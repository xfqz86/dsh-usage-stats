# 架构与统计口径（ARCHITECTURE.md）

> 本文件是插件运行机制与统计口径的**唯一权威文档**：账本与聚合的数据流、折叠与
> 去重语义、fork 继承前缀、清零墓碑、精确统计口径、构建产物形态。只写跨文件的
> 机制事实，不复制函数级实现细节（那些随代码头注释走）；改变行为必须同批改这里。
> 规则类约束在 `AGENTS.md`，线路协议在 `docs/API.md`。各节标注的代码文件是实现
> 的权威位置。

## 1. 总则

- **账本（Ledger，`ledger.ts`）唯一事实来源，聚合（UsageStore，`store.ts`）只读派生**：
  聚合任何时候都能从账本事件流重建，不允许反向写入。
- 存储直接 `node:sqlite:DatabaseSync`（Node≥22 同步 API），落盘
  `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`（经基座路径能力解析，
  默认 `~/.dsh`；测试注入 `DSH_HOME` 隔离）。同库同步读写、独立提交，即写即持久。

## 2. 账本九表（`ledger.ts`）

同库九表，列名即语义：

- **events**：`(t, session_id, seq, provider, model, input/output/cache_read/cache_write/reasoning)`，
  `PK(t,session_id,seq)` 天然幂等 `ON CONFLICT DO UPDATE`；`t` 缺失时当天确定性毫秒偏移。
  约束：TEXT 禁 `\0`，内存键 `provider\0model` 写时 `splitModelKey` 拆列，标题/cwd 等
  先 `sanitizeSqlText`（`\0→\uFFFD`）。另有 `(provider, model, t)` 普通索引
  `idx_events_model`（供模型明细按模型过滤后按会话聚合）与 `(session_id, t)` 普通索引
  `idx_events_session`（供会话明细按会话集合聚合）；索引随建表语句幂等创建，
  只是查询加速，不是数据结构或口径变化、不递增 `user_version`。
- **session_meta**：`(session_id PK, title, cwd, created_at, last_active, parent_session,
  origin, delegation_depth)`，初始化抄录、运行时由 `session/title` 与 `session/event`
  头补齐，内存 `metaCache` 供快照；`user_version 3→4` 增量补三列。
- **agg_***：`agg_total/agg_daily/agg_model/agg_model_daily/agg_session/agg_session_daily/agg_checkpoint`
  预统计物化视图，批量扫描 `aggSuspended` 挂起、结束 `persistAggregates` 一次物化并
  `sealUntil(今日零点)`。
- **版本**：`PRAGMA user_version=LEDGER_VERSION=6`；仅 `2→3/3→4` 增量保留数据，
  其余 `DROP` 重建（空表触发全量重扫）；**统计口径变化也必须递增**，否则历史事件
  不会被补录（见 §5）。

## 3. 数据流

1. **openLedger**：建目录/表、迁移、载入 meta、预编译 `LedgerStatements`。
2. **scanOnce**（`scan.ts`）：会话 id 全集 = 磁盘 `findSessionLogs`（深度≤3，按代次
   择优）∪ harness 清单；4 路 worker，优先 harness 读取（`sessionQuery.readSession` →
   `persistence.open+read`），失败或空时回退自读磁盘原始日志（`rawlog.ts` 多帧 zstd
   解码，覆盖 harness 迁移拒绝的旧格式）；两路都按 fork 继承前缀过滤（`store.ts` 的
   `liveEventsOf`），经 `foldRecord` 共用路径；`running` 防重入（`force` 持锁重入除外）。
3. **实时增量**：`ctx.on('session/event')` → `foldRecord` → `foldLedgerEvent` +
   `incrementAgg`，经 seq 水位、seq=-1 主键、`append` 返回值三层去重，补齐
   `parentSession/origin/depth/cwd/createdAt`。
4. **重启恢复**（`bootstrap()`）：优先 `hasAggregates→rebuildWithDelta`（加载 `agg_*`
   + 补 `sealedUntil` 后增量），其次 `hasEvents→rebuildFromEvents`，否则全量扫描；
   日志删除仍可从介质恢复。空库且 `agg_checkpoint` 有 `cleared_at` 清零墓碑时跳过
   首启扫描（否则空库被当首启、历史统计复活，违背 clear 承诺）。
5. **重建 / 清零 / 密封**：
   - `usageStats/rebuild` → `ledger.clear()` + `resetStore` + `scanOnce` 全量重扫；
   - `usageStats/clear` 清库后**不重扫**，统计直接归零；
   - **清零墓碑**：`clear` 清库后落 `markCleared`（`agg_checkpoint.cleared_at`，必须在
     clear 之后写）。清零后账本为空，若无墓碑，下次进程启动 bootstrap 会把空库当
     首启、全量重扫磁盘日志令历史复活；bootstrap 在空库且有墓碑时跳过首启扫描，
     统计保持归零，新会话照常实时入账。`rebuild` 经 `ledger.clear()` 清掉墓碑后
     重扫历史，是恢复历史的出口；
   - `usageStats/seal` 手动物化：把内存聚合物化进 `agg_*` 并将密封边界推进至今日
     零点，显著加快冷启动；批量导入与实时增量已自动密封，通常无需手动调用。
6. **明细读取**（`detail.ts`，按需查询，不参与折叠与物化）：
   - `usageStats/modelDetail`：「按日期」取内存聚合的模型×日桶（`startOfDay` 分桶、
     `since` 过滤），「按会话」读账本 `events` 按 `provider`/`model` 过滤后
     `GROUP BY session_id`（走 `idx_events_model`），会话元数据复用账本 `session_meta`；
   - `usageStats/dateDetail`：两个维度都取内存聚合的当日桶（模型×日与会话×日），
     不读账本 events——单日两边都是既有桶的一次查表，再走一遍 SQL 聚合没有收益；
   - `usageStats/sessionDetail`：合计与按日取内存聚合（集合内各会话的总桶与日桶并桶），
     按模型读账本 `events` 按集合 `GROUP BY provider, model`（走 `idx_events_session`）；
     集合由客户端传（所点行的折叠分组），服务端不自走 `session_meta` 子树——
     快照列表有截断、父会话可能没有用量，只有与行数字同源才能逐位对齐（协议见 `docs/API.md` §2.3）；
   - 三者都不新增表、不改 `user_version`。

## 4. 折叠与去重（`agg.ts` / `store.ts`）

- **折叠语义**：`foldRecord` 处理种子/`title`/`usable`（`data.usage` 存在）事件，
  零用量事件直接丢弃不入账本；经三层去重后 `append` + `foldLedgerEvent` 折入日桶/
  总桶/模型、模型×日并更新 `maxSeq/lastActive`（`seq>=0` 才推进水位）；
  `foldLedgerEvent` 归一非有限/负数→0 并向下取整，若传 `ledger` 则同步
  `incrementAgg`（失败仅 `lastError`）。
- **fork 继承前缀**：被 fork 的子会话日志物理包含父会话的历史事件，由
  `session/end-seed`（`data.inherited: true`）标记分界。统计只取自有部分——harness
  两路读 `inheritedEventCount`，原始日志路径用 `inheritedPrefixOf` 求标记；不做这层
  过滤会把父的用量在子会话名下重复计入（`store.ts` 的 `inheritedCountOf`/
  `inheritedPrefixOf`/`liveEventsOf`，实时监听同样按 `session.inheritedEventCount` 跳过）。

## 5. 统计口径（精确）

- 数据源：带 `data.usage` 的计量事件——对话调用 `assistant/message` 与压缩调用
  `compaction/summary`（`toLedgerEvent` 非有限/负数→0 并向下取整，零用量直接丢弃
  不入账本）。
- **跨会话不重复**：fork 继承前缀属于父会话，子会话只统计 `inheritedEventCount`
  之后的自有事件（见 §4）；同一会话按最高代次文件只折一次。
- `total=input+output+cacheRead+cacheWrite`，`reasoning` 单列。
- 按模型：`assistant/message` 取 `data.message.source.provider/model`，
  `compaction/summary` 取 `data.provider`/`data.model`，缺失记 `unknown`；
  `assistant/attempt` 不收（用量是流式中间态，与同 turn 的 `assistant/message` 重复）。
- 按会话：标题/`cwd`/创建时间/最近活跃。
- 本地日划分：`startOfDay`（`utils.ts` 唯一来源，避免 UTC 漂移）。
- 展示口径：日期趋势柱仅堆叠输入/输出/缓存三段（柱高按三段求和，`total` 字段仍为
  全口径），缓存命中率=`cacheRead/(cacheRead+input)`；快照序列的截断行为
  （`series.current` 不截断）见 `docs/API.md` §2。
- **模型明细口径**（`usageStats/modelDetail`，协议见 `docs/API.md` §2.1）：与快照同一
  `startOfDay` 日划分、同一 `since` 过滤；按会话聚合与按日序列覆盖同一批事件，
  合计由会话行求和（与按日合计相等由 `test/smoke.mjs` 断言）；`since` 缺省时覆盖
  全部历史、不做 366 天截断，以便与所点模型行的合计对齐。展示与面板同名 Tab 同一套：
  按日期顶部复用 `StackedBar` date 模式（补齐范围内每一天、同一三段堆叠口径），
  表格只列有量的日子；按会话复用 `groupSessions`/`compareSessionGroup`，
  子代理折叠与排序键都与会话 Tab 一致。
- **单日明细口径**（`usageStats/dateDetail`，协议见 `docs/API.md` §2.2）：某一本地日的
  合计 + 按模型 + 按会话，三个数字互为校验——合计由当天模型行求和，当天会话行求和与之
  相等、且等于当天日桶（`test/smoke.mjs` 断言三者一致）；两个维度都只含当天有量的行，
  桶键就是 `startOfDay` 的本地日零点，与浏览器端日期行同源。展示与面板同名 Tab 同一套：
  按会话复用 `groupSessions`/`compareSessionGroup`（子代理折叠与排序键与会话 Tab 一致），
  按模型复用模型页的占比口径（`largestRemainderPcts`）。
- **会话明细口径**（`usageStats/sessionDetail`，协议见 `docs/API.md` §2.3）：一条会话的
  合计 + 按日期 + 按模型，**集合由客户端界定**——会话页把所点主会话行的折叠分组
  （主会话 + `groupSessions` 展平的全部子代理）随请求传入，服务端只聚合给定集合，
  不自走 `session_meta` 子树：快照列表有截断、父会话可能没有用量（孤儿回落顶层成行），
  只有与行数字同源才能逐位相等。合计等于集合内各会话总桶之和，`daily` 由各会话日桶并桶
  （`startOfDay` 零点、升序、只含有量的日子、全历史不截断），`models` 读账本按集合
  `GROUP BY provider, model`（原始键、不做重定向归并，归并在浏览器端）；合计与两个维度
  在同一数据代次内逐位相等（`test/smoke.mjs` 断言）。展示与面板同名 Tab 同一套：
  按日期复用 `StackedBar` date 模式（窗口固定 `all`，上限 366 天）与日期页的列，
  按模型复用模型页的列、占比与归并标记。
- **不计入项（数据源边界，非本仓可补）**：
  - 会话标题生成的辅助调用——`session/title-llm-request` 只记请求，harness 取标题
    文本后丢弃响应 usage，日志里没有用量可折；
  - 重试被替换的中间尝试与无 `assistant/message` 的中断流——用量只存在于
    `assistant/chunk`/`assistant/attempt` 的 stream 里，与最终 `assistant/message`
    同源，按 message 折叠避免双计（dsh 自身 token 投影同样不计）。

## 6. 构建与产物形态

- `lib/index.js`（Host，Node ESM，`@xfqz86/dsh-usage-stats`）：仅 Node 内置+本地，
  DSH 服务 cordis 注入；**任何构建都不压缩**（含生产发布）——SRC 分发的线路字段名
  取自方法源码文本，压缩重命名参数会让网关拒收带参请求（协议见 `docs/API.md` §1，
  回归自检见 `test/smoke.mjs`）。
- `lib/client.js`（Browser CJS 闭包 `window.__ModuleLoader__.load({id,factory})`）：
  `externals` 复刻冻结表（`react/primitives/slots` 等），其余内联；`production`
  压缩且无 sourcemap，非 `production` 不压缩并保留 sourcemap。
- CSS：`scripts/css-modules-inline.mjs`（lightningcss `cssModules`）将 `*.module.css`
  编译为 scoped 映射 + `<style data-plugin-css>` 注入（源码仍真实 CSS Modules）。
