# 架构与统计口径（ARCHITECTURE.md）

> 本文件是插件运行机制与统计口径的**唯一权威**：数据流、折叠与去重、fork 继承前缀、
> 清零墓碑、精确口径与产物形态；只写跨文件机制事实。规则在 `AGENTS.md`，协议在 `docs/API.md`。

## 1. 总则

- **账本（Ledger，`ledger.ts`）唯一事实来源，聚合（UsageStore，`store.ts`）只读派生**：
  聚合任何时候都能从账本事件流重建，不允许反向写入。
- 存储直接用 `node:sqlite` 的 `DatabaseSync`（Node ≥22 同步 API），落盘
  `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`（基座路径能力解析，测试注入
  `DSH_HOME` 隔离）；同步读写、独立提交，即写即持久。

## 2. 账本九表（`ledger.ts`）

- **events**：`(t, session_id, seq, provider, model, input/output/cache_read/cache_write/reasoning)`，
  `PK(t,session_id,seq)` 天然幂等；`t` 缺失时按内容哈希落当天确定性毫秒偏移。TEXT 列禁
  `\0`：内存键 `provider\0model` 写时 `splitModelKey` 拆列，标题/cwd 等经 `sanitizeSqlText`
  （`\0→\uFFFD`）。查询索引 `idx_events_model(provider, model, t)` 与
  `idx_events_session(session_id, t)` 在 `open()` 版本判定后幂等补建，只是查询加速、不递增 `user_version`。
- **session_meta**：`(session_id PK, title, cwd, created_at, last_active, parent_session,
  origin, delegation_depth)`，初始化抄录、运行时由 `session/title` 与实时事件 header 补齐，`metaCache` 供快照与明细读取。
- **agg_\***：`agg_total/agg_daily/agg_model/agg_model_daily/agg_session/agg_session_daily/agg_checkpoint`
  七张预统计物化视图；批量扫描时 `aggSuspended` 挂起逐条物化，结束一次性 `persistAggregates` 并 `sealUntil(今日零点)`。
- **版本**：`PRAGMA user_version=LEDGER_VERSION=6`。只有旧库 `2`/`3` 增量升到 6（幂等建表 +
  `session_meta` 补 `parent_session`/`origin`/`delegation_depth` 三列，事件保留）；其余
  版本（`0` 有数据、`4`/`5` 等）清库重建，空表下次启动全量重扫。**统计口径变化也必须
  递增**，否则历史事件不会被补录（见 §5）。

## 3. 数据流

1. **openLedger**：建目录/表、迁移、载入 meta、预编译 `LedgerStatements`。
2. **scanOnce**（`scan.ts`）：会话 id 全集 = 磁盘 `findSessionLogs`（深度 ≤3，同目录只取
   最高代次，同代次优先 zstd）∪ harness 清单（`sessionQuery.listSessions` /
   `sessionPersistence.list`）；`SCAN_WORKERS=4` 路并行，优先 harness 读取
   （`sessionQuery.readSession` → `persistence.open+read`），失败或空事件时用 `rawlog.ts`
   自读原始日志兜底（多帧 zstd 解码，覆盖 harness 迁移拒绝的旧格式）；两路都按 fork
   继承前缀过滤（`store.ts` 的 `liveEventsOf`），经 `foldRecord` 共用路径；`running` 防重入。
3. **实时增量**：`ctx.on('session/event')` → 补齐 `parentSession/origin/delegationDepth/
   cwd/createdAt` → `foldRecord` → `foldLedgerEvent` + `incrementAgg`；经 seq 水位、
   seq=-1 主键、`append` 返回值三层去重。
4. **重启恢复**（`bootstrap()`）：优先 `hasAggregates → rebuildWithDelta`（加载 `agg_*` +
   补 `sealedUntil` 之后的增量），其次 `hasEvents → rebuildFromEvents`，否则全量扫描；
   日志删除后仍可从介质恢复。空库且 `agg_checkpoint` 有 `cleared_at` 清零墓碑时跳过首启
   扫描（否则空库被当首启、历史统计复活，违背 clear 承诺）。
5. **重建 / 清零 / 密封**：`rebuild` → `ledger.clear()` + `resetStore` + 全量 `scanOnce`；
   `clear` 清库后**不重扫**、统计归零，随后 `markCleared` 落墓碑（`agg_checkpoint.cleared_at`，
   必须在 clear 之后写——clear 会清空 checkpoint），`rebuild` 清墓碑重扫即恢复出口；
   `seal` 手动物化 `persistAggregates` + `sealUntil(今日零点)`；批量扫描结束会自动做同样一次，
   实时事件只逐条 `incrementAgg` 增量写预统计、不推进密封边界。
6. **明细读取**（`detail.ts`，按需查询，不参与折叠与物化，都不新增表、不改 `user_version`）：
   - `modelDetail`：按日取内存 `modelDaily`（`startOfDay` 分桶、`since` 过滤）；按会话读
     `events` 过滤 `provider`/`model` 后 `GROUP BY session_id`（`ledger.modelSessions`，走 `idx_events_model`）；
   - `dateDetail`：两个维度都取内存聚合的当日桶（模型×日与会话×日），不读 `events`——
     单日两边都是既有桶的一次查表，再走一遍 SQL 聚合没有收益；
   - `sessionDetail`：合计与按日取内存聚合（集合内各会话总桶与日桶并桶），按模型读
     `events` 按集合 `GROUP BY provider, model`（`ledger.sessionModels`，走
     `idx_events_session`）。集合由客户端传（所点行的折叠分组）：快照列表有截断、父会话
     可能没有用量，只有与行数字同源才能逐位对齐（协议见 `docs/API.md` §2.3）。

## 4. 折叠与去重（`agg.ts` / `store.ts`）

- **折叠语义**：`foldRecord` 处理种子/`title`/`usable`（`data.usage` 存在）事件，零用量
  直接丢弃不入账本；经三层去重后 `append`，`foldLedgerEvent` 折入日桶/总桶/模型/模型×日
  并更新 `maxSeq/lastActive`（`seq>=0` 才推进水位），传 `ledger` 时同步 `incrementAgg`
  （失败只记 `lastError`）；数值归一（非有限/负数→0、向下取整）在 `toLedgerEvent` 完成。
- **fork 继承前缀**：被 fork 的子会话日志物理包含父会话历史事件，由 `session/end-seed`
  （`data.inherited: true`）标记分界，统计只取自有部分——harness 两路读
  `inheritedEventCount`，原始日志路径用 `inheritedPrefixOf` 求标记；缺这层过滤会把父的
  用量在子会话名下重复计入（`store.ts` 的 `inheritedCountOf`/`inheritedPrefixOf`/
  `liveEventsOf`，实时监听同样按 `session.inheritedEventCount` 跳过）。

## 5. 统计口径（精确）

- 数据源：带 `data.usage` 的计量事件——对话调用 `assistant/message` 与压缩调用
  `compaction/summary`；`toLedgerEvent` 归一非有限/负数→0 并向下取整，零用量不入账本。
- **跨会话不重复**：fork 继承前缀属于父会话，子会话只统计 `inheritedEventCount` 之后的自有
  事件（见 §4）；同一会话按最高代次文件只折一次。
- `total=input+output+cacheRead+cacheWrite`，`reasoning` 单列不计入。
- 按模型：`assistant/message` 取 `data.message.source.provider/model`，`compaction/summary`
  取 `data.provider`/`data.model`，缺失记 `unknown`；`assistant/attempt` 不收（用量是流式
  中间态，与同 turn 的 `assistant/message` 重复）。
- 按会话：标题/`cwd`/创建时间/最近活跃；本地日划分 `startOfDay`（`utils.ts` 唯一来源）。
- 展示口径：日期趋势柱只堆叠输入/输出/缓存三段（柱高按三段求和，`total` 字段仍为全口径），
  缓存命中率 `cacheRead/(cacheRead+input)`；快照序列截断行为见 `docs/API.md` §2。
- 三个明细的取数路径见 §3 末条，协议见 `docs/API.md` §2.1–§2.3，共同口径：
  - `modelDetail`：与快照同一 `startOfDay`、同一 `since` 过滤；合计由会话行求和，与按日
    序列合计相等（`test/smoke.mjs` 断言）；`since` 缺省覆盖全部历史、不做 366 天截断，
    以便与所点行的合计对齐。
  - `dateDetail`：某一本地日的合计 + 按模型 + 按会话，三者互为校验且等于当天日桶
    （`test/smoke.mjs` 断言）；只含当天有量的行。
  - `sessionDetail`：集合由客户端界定（见 §3 末条）；合计 = 集合内各会话总桶之和，`daily` 由
    各会话日桶并桶（`startOfDay` 零点、升序、只含有量的日子、全历史不截断），`models` 为
    账本原始键、不归并（归并在浏览器端）；合计与两个维度在同一数据代次内逐位相等
    （`test/smoke.mjs` 断言）。
- **不计入项（数据源边界，非本仓可补）**：
  - 会话标题生成的辅助调用——`session/title-llm-request` 只记请求，harness 取标题文本后
    丢弃响应 usage，日志里没有用量可折；
  - 重试被替换的中间尝试与无 `assistant/message` 的中断流——用量只存在于
    `assistant/chunk`/`assistant/attempt` 的 stream 里，与最终 `assistant/message` 同源，
    按 message 折叠避免双计（dsh 自身 token 投影同样不计）。

## 6. 构建与产物形态

- `lib/index.js`（Host，Node ESM）：仅 Node 内置 + 本地代码 + `dependencies` + `peerDependencies`
  （cordis / typert-protocol / credentials，框架单例由 dsh 安装包提供）；**任何构建都不压缩**
  （含生产发布）——SRC 线路字段名取自方法源码文本，压缩重命名参数会让网关拒收带参请求（协议见 `docs/API.md` §1，回归见 `test/smoke.mjs`）。
- `lib/client.js`（浏览器 CJS 闭包 `window.__ModuleLoader__.load({id,factory})`）：`externals`
  复刻 shell 冻结表（react 系与 `@deepseek-ai/*` 的 cordis/store/slots/primitives/dockkit），
  其余内联；`production` 压缩且无 sourcemap，非 production 不压缩并保留 sourcemap。
- CSS：`scripts/css-modules-inline.mjs`（lightningcss）把 `*.module.css` 编译为 scoped 映射 +
  `<style data-plugin-css>` 注入（源码仍是真实 CSS Modules）。
