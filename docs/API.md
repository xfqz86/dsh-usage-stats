# Remote API 与运行时协议（API.md）

> 本文件是 `usageStats` 命名空间 Remote **线路协议**与**偏好设置协议**的唯一权威
> 文档：方法表、请求/响应结构、状态语义、TTL 与缓存行为、偏好字段。类型单一事实
> 来源在 `src/types.ts`，Client 严格编解码在 `src/remote/contribution.ts`；运行机制
> （账本、扫描、清零墓碑）见 `docs/ARCHITECTURE.md`，规则类约束见 `AGENTS.md`。

## 1. 通用约定

- 命名空间 `usageStats`，7 个一元（unary，一问一答，区别于流式）方法：
  `snapshot/rebuild/clear/seal/goQuota/deepseekBalance/zaiQuota`；其中
  `rebuild`/`clear`/`seal` **无请求参数**（贡献里 `parameters: []`），其余各带一个具名 request。
  调用经 `ctx.get('remote.usageStats')` 取命名空间服务后调用（本仓库由 `usageStatsRemote()` 封装）；
  线路上走客户端 Connection 的 RPC：`POST /api/usageStats/<方法>`，请求体为
  `{ type:'client-request', rpcId, method, payload:{ args } }`，信任与认证由网关载体统一处理（Host/Origin 围栏 + 浏览器会话 cookie）。禁止暂存 `ctx.remote` 再读 `.usageStats`。
- 成功响应 `{ ok: true, value }`；失败 `{ ok: false, error: { code, message, details } }`；
  业务失败码为 `usageStats/busy`（写操作并发，见 §4），未归类异常由网关折为 `gateway/internal`。
- Host 侧走 @Remote 装饰器标记 + 实时服务绑定的 SRC 分发（与 dev 模式同源），
  Client 侧挂载手写严格贡献（独立仓库跑不了 harness 生成器管线，见
  `src/remote/contribution.ts` 头注释）；只改实现体不动贡献，改签名必须同步。

## 2. usageStats/snapshot

- request `{ sessionId: string | null, limit?: number }`，带 sessionId 时返回对应会话的 `current`
  和 `series.current`，`limit` 为会话明细分页上限，取值范围为 `1..1000`，默认 `200`，浏览器端 `useSnapshot` 以 `500` 请求，超出截断。
- `series.all` 与各模型 `series` 均截断至最近 366 天，与客户端 `all` 范围上限对齐，避免长历史下全量序列化开销；`series.current` 为指定会话序列，不截断；聚合总量 `all`/`models[].usage` 不受截断影响，仍为全量。
- 响应 `value` 字段为 `UsageSnapshot` 类型，类型单一定义在 `src/types.ts`，由 host 构建与 client 消费共用：
  - 统计元信息：`scanning` / `scans` / `failed` / `rawSessions` /
    `harnessSessions` / `foldedEvents` / `dedupSkipped` / `lastError` /
    `scanError` / `lastScanAt` / `time`；
  - `sessions` 为有量会话数、`current` 为指定会话聚合或 `null`、`all` 为全量 `Agg`、`series.all` 为全量按日 `SeriesPoint[]` 及 `series.current` 为指定会话按日；
  - `models[]` 按模型拆分，元素含 `provider`、`model`、`calls`、`usage`、`series`，`series` 为该模型按日 `SeriesPoint[]`，供浏览器端范围筛选与堆叠柱使用，旧快照可能缺省；
  - `sessionsList[]` 为会话明细，按 `lastActive` 倒序，已分页截断，每项含 `id`、`title`、`cwd`、`createdAt`、`lastActive`、`calls`、`usage`、`parentSession`、`origin`、`delegationDepth`，后三者为子代理归属，序列化为 `string|null`、`string|null`、`number`。

## 3. 额度查询通用约定（goQuota / deepseekBalance / zaiQuota 共用）

三路额度方法共享同一请求形态与缓存语义，各节只写差异（键名、端点、归一化、状态特例）。

- body `{ intervalMinutes?: number, force?: boolean }` —— `intervalMinutes` 是客户端
  抓取间隔（分钟，来自偏好设置），服务端据此调整 TTL；`force: true` 对应概览磁贴的
  立即刷新按钮，**完全绕过 TTL 缓存立即重新抓取**（仅并发经单飞合并），成功后缓存
  窗口重新起算。
- **TTL**：有效 TTL = `min(5 分钟, max(3 分钟, intervalMinutes))`；未带间隔默认 5 分钟。
- **单飞**：并发请求只打一次官方端点。缓存仅内存，**不落账本**。
- **key 解析**：一律经 DSH 凭据中心 `ctx.credentials` 读取，不直接读 `process.env`
  或官方 CLI 的本地凭据文件；具体键名见各节。凭据中心缺席或无 key → `no-key`。
- **传输**：官方端点 + 浏览器 UA 与必要请求头（否则被前置 Cloudflare 以 error 1010
  拦截），15s 超时。
- **状态语义**：无 key、401、403 → `no-key`（各节特例除外）；非 2xx 其他、超时、
  网络异常、JSON 结构非法 → `error`；成功 → `ok`。`status` 由客户端按文案本地化展示。

## 3.1 usageStats/goQuota

- 目的：OpenCode Go 订阅额度，包含滚动 5 小时、本周、本月 `percent` 和 `resetsAt`。
- key：仅凭据中心 `OPENCODE_GO_API_KEY`。
- 端点：`GET https://opencode.ai/zen/go/v1/usage`。
- 响应 `value`：`GoQuota` 定义在 `src/types.ts`，结构为
  `{ status: 'ok' | 'no-key' | 'no-plan' | 'error', fetchedAt, rolling, weekly, monthly }`。
- 特例：401/403 且响应体 `error.type` 为 `EntitlementError`（已配置 Key 但未开通订阅，
  如 403 + `{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}`）
  → `no-plan`，其余 401/403（Key 无效等）仍为 `no-key`。

## 3.2 usageStats/deepseekBalance

- 目的：DeepSeek 余额，包含当前余额 `isAvailable` 和多币种 `balances`；预留今日消耗
  `todayAmount`/`todayCurrency`，v1 固定为 `null`。
- key：仅凭据中心 `DEEPSEEK_API_KEY`，兼容 `DEEPSEEK_APIKEY`、`DEEPSEEK_API_TOKEN`、
  `DEEPSEEK_TOKEN`。
- 端点：`GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <key>`。
- 响应 `value`：`DeepSeekBalance` 定义在 `src/types.ts`，结构为
  `{ status, fetchedAt, isAvailable, balances: DeepSeekBalanceInfo[], todayAmount, todayCurrency }`，
  `DeepSeekBalanceInfo` 为 `{ currency, totalBalance, grantedBalance, toppedUpBalance }`，
  金额保持字符串（官方即字符串，避免浮点丢失）。
- 归一化：`balance_infos` 逐条经 `normalizeBalanceInfo`——`currency` 非空字符串才保留，
  金额 `string|number` 统一为字符串、缺失回退 `"0.00"`，非法条目丢弃不使整批失败；
  `isAvailable` 仅当官方 `is_available === true` 且类型为 boolean 时为 `true`，其余归一
  为 `false`。
- 特例：`is_available === false` → `ok` + `isAvailable: false`（余额不可用由 Client
  文案区分，不归为 `error`）；成功但 `balances` 为空数组仍为 `ok`，Client 展示
  「暂无余额明细」并以本地今日 tokens/calls 降级展示、标注本地 hint。

## 3.3 usageStats/zaiQuota

- 目的：Z.ai 智谱额度，滚动 5 小时、本周 `percent`/`resetsAt` 与每月 Web 搜索
  `used`/`limit`/`resetsAt`；计划名 `plan` 来自官方 `data.level`。
- key：仅凭据中心 `ZAI_CODING_CN_API_KEY` → `ZAI_API_KEY`（前者优先），不使用 `GLM_API_KEY`。
- 端点：`GET https://api.z.ai/api/monitor/usage/quota/limit`，`Authorization: Bearer <key>`，
  `Accept: application/json`。
- 响应 `value`：`ZaiQuota` 定义在 `src/types.ts`，结构为
  `{ status: 'ok' | 'no-key' | 'no-plan' | 'error', fetchedAt, plan, session, weekly, webSearches }`；
  `session`/`weekly` 为 `ZaiWindow | null`、`webSearches` 为 `ZaiWebSearchQuota | null`
  （均为 `{ percent, resetsAt, used, limit }`），`plan` 为 `string | null`（如 `"Z.ai pro"`）。
  `percent` 为官方原始浮点（服务端仅保证非负、不夹上限），展示时由前端 `goPercent`
  （`Math.round` 夹 0..100）与 `goLevelOf` 分档；`used`/`limit` 来自官方条目
  `currentValue`/`usage`（未下发为 `null`）；`resetsAt` 由官方 epoch 毫秒统一转 ISO。
  `ok` 时三窗口可部分为 `null`（按官方 `limits` 实际返回决定，开放未来窗口兼容；空
  `limits:[]` 仍为 `ok`，Client 展示「暂无额度数据」）。
- 归一化：`data.limits` 逐条按 `type`/`rawType` 归类——`CREDIT_LIMIT`/`TOKENS_LIMIT` 为
  百分比窗口，按 `unit` 实际时长归类（小时×数量<1 天为会话 5 小时，`unit:6` 周与
  `unit:4` 天等多日为本周），`TIME_LIMIT` 为月度 Web 搜索计数；`percentage` 缺失该窗口
  非法，`currentValue`/`usage` 缺失 `webSearches` 非法；非法条目对齐 `openusage` 校验：
  已识别类型但归一化失败 → 整批 `error`，否则按空数据 `ok`、三窗口 `null`。
- 特例：`success:false` 且 `msg` 含 `"coding plan"`（如「当前用户不存在coding plan」）
  → `no-plan`（合法 key 但无 GLM Coding Plan，前端展示「未开通 GLM Coding Plan」空态）。

## 4. usageStats/rebuild

- 清空账本全部九表（表清单见 `docs/ARCHITECTURE.md` §2）、复位聚合缓存 → 全量重扫
  日志导入 → 物化预统计并将密封边界推进至今日零点 → `{ rebuilt: true, foldedEvents }`。
  设置页有入口，需二次确认。

## 4.1 usageStats/clear

- 清空账本九表、复位聚合缓存 → `{ cleared: true, foldedEvents }`，**不重扫**——与
  重建的区别：重建重新读取历史会话，清零后统计直接归零。清零墓碑（重启不复活历史、
  `rebuild` 是恢复统计的出口）的机制见 `docs/ARCHITECTURE.md` §3。设置页有入口，
  需二次确认。

## 4.2 usageStats/seal

- 手动触发预统计密封：物化当前内存聚合至 `agg_*` 物化表，并将密封边界推进至今日
  零点，加快冷启动。响应 `{ sealed: true, sealedUntil, foldedEvents }`。批量导入与
  实时增量已自动密封，通常无需手动调用。

**写操作并发**：`rebuild`/`clear`/`seal` 在扫描或重建进行中（快照 `scanning` 为真）
一律 `usageStats/busy` 拒绝；客户端设置页两按钮置灰并给出原因、已打开的二次确认框
随扫描开始自动关闭，不发起注定失败的请求。

## 5. 偏好设置（`usage-stats` 命名空间）

- **事实来源**：harness 用户设置文档（dsh-settings-file 落 `$DSH_HOME/settings.yaml`）的
  `usage-stats` 段——偏好属部署而非某个浏览器，换浏览器、换设备共用同一份。文档只存
  显式改过的字段，其余按 schema 默认值解析（见下表；schema 默认值与
  `USAGE_SETTINGS_DEFAULTS` 同源为规则，见 `AGENTS.md` §8）。
- **服务端**：`src/host/settings.ts` 经 `ctx.settings.register('usage-stats', …)` 注册
  （`settings` 可选，缺席不注册）；注册失败（命名空间被占用、schema 被拒）只降级偏好
  并打警告，统计主职责不中断，浏览器端设置页提示改动不会保存。
- **浏览器端**：`ctx.settingsScope.bind({ namespace: 'usage-stats' })` 取作用域
  （`settingsScope` 已登记进 `dsh.client.inject` 保证加载序），`src/client/settings.ts`
  提供订阅/读写，组件经 `useUsageSettings` 消费；写入走路径操作、只落显式改过的字段，
  间隔字段写前夹到下限 3。
- **字段**（`UsageSettings` 定义在 `src/types.ts`）：

  | 字段 | 默认 | 语义 |
  |---|---|---|
  | `goEnabled` / `deepseekEnabled` / `zaiEnabled` | `true` | 关闭即**不再轮询**对应额度/余额，侧边栏与模态窗均不显示 |
  | `showGoInSidebar` / `showDeepSeekInSidebar` / `showZaiInSidebar` | `true` | 只门控侧边栏底部芯片（含宽列与 rail），模态窗内详情仍可见 |
  | `goFetchMinutes` / `deepseekFetchMinutes` / `zaiFetchMinutes` | `5`（下限 3） | 抓取间隔，作为对应请求的 `intervalMinutes`，服务端据此调整 TTL |
  | `modelRedirects` | `[]` | 模型统计重定向规则表，见下 |

  三组独立联动：关闭 `*Enabled` 时对应「侧边栏展示」与「抓取间隔」一并置灰。偏好不落
  账本（账本只记用量），额度轮询间隔取自偏好。
- **模型统计重定向**（浏览器端归并，服务端快照保持原始行）：
  - 归并只在「模型」页消费（`src/client/stats.ts` 的 `redirectModels`）；服务端不归并，
    设置页才能拿原始「供应商 + 模型」当规则候选。
  - 匹配按 `provider + model` 精确比较（trim 后，区分大小写）；同一来源配多条时只有
    列表最上面一条生效；四项没填齐的规则不生效（界面保留待填）。
  - 链式规则（`A→B`、`B→C`）一路解析到终点；环形规则折到环内最靠前规则的目标上
    （不死循环，也不改名换姓）。
  - 归并求和用量各字段与调用次数，日序列按本地日逐日求和；目标行不存在时按规则名
    新建（只有真有用量才出现）；无规则或无命中时原样返回入参数组。规则数上限
    `MODEL_REDIRECT_MAX_RULES`（50）。
  - 规则表整表写入（`{op:'set', path:['modelRedirects'], value:[...]}`，不做数组下标级
    增删）；`normalizeModelRedirects` 去首尾空白、丢弃四项全空的空行、截断到上限；
    界面「失焦/回车」提交。
  - 自动完成候选来自原始快照（`modelCatalog`）；来源侧排除其他行已配过的组合
    （`unusedRedirectSources`：模型被用光的供应商整条不再出现，本行自己的取值保留，
    便于回改），目标侧不排除。
- **读取路径**：作用域快照 → `normalizeUsageSettings` 字段级校验（布尔只收布尔，间隔
  只收有限数并夹取，规则表按 `normalizeModelRedirects` 清洗）→ 缺字段回退默认值；
  作用域未就绪（加载中）或部署无设置后端时同样回退默认值，设置页顶部提示当前设置
  存放位置与是否可写。
- **旧版 localStorage 迁移**（key `dsh-usage-stats.settings`，升级后首次挂载一次性）：
  等作用域从 loading 落定；就绪可写且文档尚无该命名空间时，把与默认值不同的字段写入
  文档，成功后删除旧键；文档已有用户段时只删旧键（文档为准）；服务端设置缺席或只读
  时**保留**旧键——此刻没有可靠落点，删掉等于丢设置，下次挂载再试。
