# JSON API 与运行时协议

本插件 Host 服务端暴露的 HTTP 协议与客户端偏好设置的完整约定。随接口演进
维护；AGENTS.md 只保留不变量，包括 POST only、回环围栏、注入清单，不重复本文件
细节。类型单一事实来源在 `src/types.ts`。

## 1. 通用约定

- 路由前缀 `/usage-stats/api`，**仅 POST**，body `application/json`。
- 每次调用先过**回环围栏**，仅 127.0.0.1、localhost、::1、127.x 网段 Host
  可访问，可防 DNS 重绑定和跨站探测；非回环返回 403
  `{ ok: false, error: { code: 'forbidden' } }`。
- 所有请求必须携带请求头 `x-dsh-usage-stats: dsh-usage-stats`，缺失或不匹配
  返回 403 `{ ok: false, error: { code: 'forbidden' } }`，可防跨站 CSRF，浏览器
  跨站 fetch 无法在不触发 preflight 的前提下携带自定义头。
- 成功响应 `{ ok: true, value }`；失败 `{ ok: false, error: { code, message } }`。
- 非 POST → 405 `method-error`；未知方法 / 路径含斜杠 → 404 `not-found`；
  执行异常 → `writeError`，状态码为 5xx。

## 2. POST /usage-stats/api/snapshot

- body `{ sessionId?: string, limit?: number, sessionsLimit?: number }`，带 sessionId 时返回对应会话的 `current`
  和 `series.current`，`limit` 和 `sessionsLimit` 为会话明细分页上限，取值范围为 `1..1000`，默认 `200`，浏览器端 `useSnapshot` 以 `500` 请求，超出截断。
- 响应 `value` 字段为 `UsageSnapshot` 类型，类型单一定义在 `src/types.ts`，由 host 构建与 client 消费共用：
  - 统计元信息：`scanning` / `scans` / `failed` / `rawSessions` /
    `harnessSessions` / `foldedEvents` / `dedupSkipped` / `lastError` /
    `scanError` / `lastScanAt` / `time`；
  - `sessions` 为有量会话数、`current` 为指定会话聚合或 `null`、`all` 为全量 `Agg`、`series.all` 为全量按日 `SeriesPoint[]` 及 `series.current` 为指定会话按日；
  - `models[]` 按模型拆分，元素含 `provider`、`model`、`calls`、`usage`、`series`，`series` 为该模型按日 `SeriesPoint[]`，供浏览器端范围筛选与堆叠柱使用，旧快照可能缺省；
  - `sessionsList[]` 为会话明细，按 `lastActive` 倒序，已分页截断，每项含 `id`、`title`、`cwd`、`createdAt`、`lastActive`、`calls`、`usage`、`parentSession`、`origin`、`delegationDepth`，后三者为子代理归属，序列化为 `string|null`、`string|null`、`number`。

## 3. POST /usage-stats/api/go-quota

- 目的：OpenCode Go 订阅额度，包含滚动 5 小时、本周、本月 `percent` 和 `resetsAt`。
- body `{ intervalMinutes?: number, force?: boolean }` —— `intervalMinutes` 是
  客户端抓取间隔，单位为分钟，见 §5；`force: true` 对应概览 Go 磁贴的立即刷新按钮，
  绕过有效 TTL 缓存强制重新抓取，但**仍受 3 分钟强制下限保护**，距上次抓取不足
  3 分钟时返回最近一次结果，避免刷爆官方端点。
- 响应 `value`：`GoQuota` 定义在 `src/types.ts`，结构为
  `{ status: 'ok' | 'no-key' | 'error', fetchedAt, rolling, weekly, monthly }`，
  `status` 由客户端按文案本地化展示。
- **key 解析**：仅 DSH 凭据中心 `OPENCODE_GO_API_KEY`，经 `ctx.credentials` 读取，由 `~/.dsh/.credentials.yaml` 统一托管，不直接读 `process.env` 或 `auth.json`。
- **端点** `https://opencode.ai/zen/go/v1/usage` + 浏览器 UA，否则被前置
  Cloudflare 以 error 1010 拦截。
- **缓存**：有效 TTL = `min(5 分钟, max(3 分钟, intervalMinutes))`；未带间隔
  默认 5 分钟；**单飞**，即并发请求只打一次官方端点。
- **语义**：无 key、401、403 → `no-key`；请求失败或结构非法 → `error`；
  成功 → `ok`。

## 3.1 POST /usage-stats/api/deepseek-balance

- 目的：DeepSeek 余额，包含当前余额 `is_available` 和多币种 `balance_infos`，每项含 `currency`、`total_balance`、`granted_balance`、`topped_up_balance`，金额为字符串，预留今日消耗 `todayAmount`、`todayCurrency`，v1 固定为 `null`。
- body `{ intervalMinutes?: number, force?: boolean }` —— `intervalMinutes` 是
  客户端抓取间隔，单位为分钟，见 §5；`force: true` 对应概览 DeepSeek 磁贴的立即刷新按钮，
  绕过有效 TTL 缓存强制重新抓取，但**仍受 3 分钟强制下限保护**，距上次抓取不足
  3 分钟时返回最近一次结果，避免刷爆官方端点。
- 响应 `value`：`DeepSeekBalance` 定义在 `src/types.ts`，结构为
  `{ status: 'ok' | 'no-key' | 'error', fetchedAt, isAvailable, balances: DeepSeekBalanceInfo[], todayAmount, todayCurrency }`，
  `DeepSeekBalanceInfo` 为 `{ currency, totalBalance, grantedBalance, toppedUpBalance }`，金额保持字符串，避免浮点丢失，`status` 由客户端按文案本地化展示；`isAvailable` 仅当官方 `is_available === true` 且类型为 boolean 时为 `true`，其余归一化为 `false`。
- **key 解析**：仅 DSH 凭据中心 `DEEPSEEK_API_KEY`，兼容 `DEEPSEEK_APIKEY`、`DEEPSEEK_API_TOKEN`、`DEEPSEEK_TOKEN`，均走 `ctx.credentials`，不直接读 `process.env` 或 `~/.deepseek/*`。
- **端点** `https://api.deepseek.com/user/balance` + 浏览器 UA，与 GoQuota 同款，可防前置拦截，`Authorization: Bearer <key>`，15s 超时。
- **缓存**：有效 TTL = `min(5 分钟, max(3 分钟, intervalMinutes))`；未带间隔
  默认 5 分钟；**单飞**，即并发请求只打一次官方端点；**不落账本**，仅内存缓存。
- **归一化**：`balance_infos` 逐条经 `normalizeBalanceInfo` 过滤，`currency` 非空字符串才保留，金额 `string|number` 统一为字符串，缺失回退为 `"0.00"`，非法条目丢弃不使整批失败。
- **语义**：无 key、401、403 → `no-key`；`is_available === false` → `ok` + `isAvailable: false`，余额不可用由 Client 文案区分，不归为 `error`；非 2xx 除 401、403 外、超时、网络异常、JSON 结构非法 → `error`；成功 → `ok`，`balances` 可能为空数组，此时 Client 展示“暂无余额明细”并以本地今日用量降级，`todayAmount` 和 `todayCurrency` 在 v1 固定为 `null`，Client 以本地今日 tokens 和 calls 降级展示并标注本地 hint。

## 3.2 POST /usage-stats/api/zai-quota

- 目的：Z.ai 智谱额度，包含滚动 5 小时、本周 `percent` 和 `resetsAt`，以及每月 Web 搜索 `used`、`limit` 和 `resetsAt`，计划名 `plan` 来自 `data.level`。
- body `{ intervalMinutes?: number, force?: boolean }` —— `intervalMinutes` 是
  客户端抓取间隔，单位为分钟，见 §5；`force: true` 对应概览 Z.ai 磁贴的立即刷新按钮，
  绕过有效 TTL 缓存强制重新抓取，但**仍受 3 分钟强制下限保护**，距上次抓取不足
  3 分钟时返回最近一次结果，避免刷爆官方端点。
- 响应 `value`：`ZaiQuota` 定义在 `src/types.ts`，结构为
  `{ status: 'ok' | 'no-key' | 'no-plan' | 'error', fetchedAt, plan, session, weekly, webSearches }`，
  `session` 和 `weekly` 为 `ZaiWindow | null`，结构为 `{ percent, resetsAt, used, limit }`，`resetsAt` 为 ISO 字符串，`percent` 已夹到 0..100，`used` 和 `limit` 为点数明细，来自官方条目的 `currentValue` 和 `usage` 字段，官方未下发时为 `null`，`webSearches` 为 `ZaiWebSearchQuota | null`，结构为 `{ used, limit, percent, resetsAt }`，`plan` 为 `string | null`，如 `"Z.ai pro"`，`status` 由客户端按文案本地化展示，`ok` 时三窗口可能部分为 `null`，按官方 `limits` 实际返回决定，开放未来窗口兼容。
- **key 解析**：仅 DSH 凭据中心 `ZAI_CODING_CN_API_KEY` → `ZAI_API_KEY`，经 `ctx.credentials` 读取，不直接读 `process.env`，不使用 `GLM_API_KEY`。
- **端点** `GET https://api.z.ai/api/monitor/usage/quota/limit` + 浏览器 UA，与 GoQuota 同款，可防前置拦截，`Authorization: Bearer <key>`，`Accept: application/json`，15s 超时；参考 `openusage` 的 `ZAIUsageClient.quotaURL` 与 `ZAIUsageMapper`，`CREDIT_LIMIT` 和 `TOKENS_LIMIT` 按 `unit` 归类，`unit:3` 小时×数量<1 天为会话 5 小时，`unit:6` 周和 `unit:4` 天等多日为本周，`TIME_LIMIT` 为月度 Web 搜索计数。
- **缓存**：有效 TTL = `min(5 分钟, max(3 分钟, intervalMinutes))`；未带间隔
  默认 5 分钟；**单飞**，即并发请求只打一次官方端点；**不落账本**，仅内存缓存。
- **归一化**：`data.limits` 逐条按 `type`、`rawType` 归类，`CREDIT_LIMIT` 和 `TOKENS_LIMIT` 为百分比窗口，按 `unit` 的实际时长归为 `session` 和 `weekly`，`TIME_LIMIT` 为 `webSearches`，`percentage` 缺失时该窗口视为非法，`currentValue` 和 `usage` 缺失时 `webSearches` 视为非法；`nextResetTime` 为 epoch 毫秒，统一转为 ISO `resetsAt`；`percent` 经 `Math.round` 夹到 0..100 后由前端 `goPercent` 和 `goLevelOf` 分档；非法条目按 `openusage` 的校验策略，若已识别类型但归一化失败则整批判为 `error`，否则按空数据返回 `ok`，三窗口为 `null`。
- **语义**：无 key、401、403 → `no-key`；`success:false` 且 `msg` 含 `"coding plan"`，如 `"当前用户不存在coding plan"`，→ `no-plan`，为合法 key 但无 GLM Coding Plan，由客户文案提示订阅；非 2xx 除 401、403 外、超时、网络异常、JSON 结构非法、已识别窗口归一化失败 → `error`；成功 → `ok`，空 `limits:[]` 仍为 `ok` 且三窗口为 `null`，前端展示“暂无额度数据”。

## 4. POST /usage-stats/api/rebuild

- 清空 sqlite 全量表 `events`、`session_meta`、`agg_total`、`agg_daily`、`agg_model`、`agg_model_daily`、`agg_session`、`agg_session_daily`、`agg_checkpoint` 共 9 张，复位聚合缓存 → 全量重扫日志导入
  → 物化预统计并将密封边界推进至今日零点 → `{ rebuilt: true, foldedEvents }`。设置页有入口，需二次确认。

## 4.1 POST /usage-stats/api/clear

- 清空 sqlite 全量表，同 rebuild 共 9 张，复位聚合缓存 → `{ cleared: true, foldedEvents }`，
  **不重扫**，与重建的区别为重建会重新读取历史会话而清零不会，统计直接归零。
  设置页有入口，需二次确认。

## 4.2 POST /usage-stats/api/seal

- 手动触发预统计密封：物化当前内存聚合至 `agg_*` 物化表，并将密封边界推进至今日零点。
- 用于将“不会再变动的历史数据”预统计进数据库，后续启动仅需加载物化表 + 少量增量事件，显著加快冷启动。
- 响应 `{ sealed: true, sealedUntil, foldedEvents }`。与其他写路由一致，已有
  扫描 / 重建进行中时返回 409 `busy`。批量导入与实时增量已自动密封，通常无需
  手动调用。

## 5. 偏好设置，浏览器端 localStorage

- key `dsh-usage-stats.settings`；读取失败或字段非法回退默认值，`goFetchMinutes`、`deepseekFetchMinutes`、`zaiFetchMinutes` 经 `clamp*` 夹到下限 3。
- 字段 `UsageSettings` 定义在 `src/client/settings.ts`：
  - `goEnabled` 默认 `true`，关闭则**不再轮询** go-quota，侧边栏与模态窗
    均不显示 Go 额度；
  - `showGoInSidebar` 默认 `true`，只门控侧边栏底部 Go 芯片，含宽列和 rail，模态窗内额度详情仍可见；
  - `goFetchMinutes` 默认 5，下限 3，抓取间隔，同时作为 `POST /usage-stats/api/go-quota` 请求体的
    `intervalMinutes`，服务端据此调整 TTL；
  - `deepseekEnabled` 默认 `true`，关闭则**不再轮询** deepseek-balance，侧边栏与模态窗
    均不显示 DeepSeek 余额；
  - `showDeepSeekInSidebar` 默认 `true`，只门控侧边栏底部 DeepSeek 芯片，含宽列多币种 `totalBalance` 和今日用量及 rail 迷你芯片，模态窗内余额详情仍可见；
  - `deepseekFetchMinutes` 默认 5，下限 3，抓取间隔，同时作为 `POST /usage-stats/api/deepseek-balance` 请求体的
    `intervalMinutes`，服务端据此调整 TTL；
  - `zaiEnabled` 默认 `true`，关闭则**不再轮询** zai-quota，侧边栏与模态窗
    均不显示 Z.ai 额度；
  - `showZaiInSidebar` 默认 `true`，只门控侧边栏底部 Z.ai 芯片，含宽列 `5h`、`周` 百分比和 `Web 搜索` 次数及 rail 迷你芯片，模态窗内额度详情仍可见；
  - `zaiFetchMinutes` 默认 5，下限 3，抓取间隔，同时作为 `POST /usage-stats/api/zai-quota` 请求体的
    `intervalMinutes`，服务端据此调整 TTL。
- 关闭 `goEnabled` 时，Go 的「侧边栏展示」与「抓取间隔」两项一并置灰不可改；关闭 `deepseekEnabled` 时，DeepSeek 的「侧边栏展示」与「抓取间隔」两项一并置灰不可改；关闭 `zaiEnabled` 时，Z.ai 的「侧边栏展示」与「抓取间隔」两项一并置灰不可改，三组独立联动。
- 纯浏览器端持久化，不落账本，刷新页面后仍生效；通过 `useGoSettings`、`useZaiQuota` 等读写，同实现，局部合并、持久化与多间隔夹取。
