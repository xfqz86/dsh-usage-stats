# Remote API 与运行时协议（API.md）

> 本文件是 `usageStats` 命名空间 Remote **线路协议**与**偏好设置协议**的唯一权威：方法表、
> 请求/响应、状态语义、TTL 与缓存、偏好字段与配置串格式。类型单一事实来源是 `src/types.ts`，
> Client 严格编解码在 `src/remote/contribution.ts`；运行机制见 `docs/ARCHITECTURE.md`。

## 1. 通用约定

- 命名空间 `usageStats`，10 个一元（一问一答，非流式）方法：
  `snapshot/modelDetail/dateDetail/sessionDetail/rebuild/clear/seal/goQuota/deepseekBalance/zaiQuota`；
  `rebuild`/`clear`/`seal` 无请求参数（贡献里 `parameters: []`），其余七个各带一个具名必填 `request`。
- 调用经 `ctx.get('remote.usageStats')`（本仓库 `usageStatsRemote()` 封装，每次实时解析）；线路是
  客户端 Connection 的 RPC `POST /api/usageStats/<方法>`，请求体
  `{ type:'client-request', rpcId, method, payload:{ args } }`，信任与认证由网关载体统一处理
  （Host/Origin 围栏 + 浏览器会话 cookie），本插件不注册 HTTP 路由。
- 成功 `{ ok:true, value }`；失败 `{ ok:false, error:{ code, message, details } }`。业务失败只有
  `usageStats/busy`（`details.operation` 为方法名，见 §4.2），其余未归类异常由网关折为 `gateway/internal`。
- Host 侧是 `@Remote` 装饰器标记 + 实时服务绑定的 SRC 分发，Client 侧是手写严格贡献（独立仓库跑不了
  harness 生成器管线，见 `src/remote/contribution.ts` 头注释）；增删方法或改签名必须同批改实现体、贡献与本文件。
- **参数名即线路字段名**：网关从服务端方法源码文本（`Function.prototype.toString`）取参数名作为 `args`
  字段，带参方法参数名必须与贡献的 `wire` 逐字一致（都是 `request`）；服务端产物因此不压缩（`docs/ARCHITECTURE.md`
  §6），`test/smoke.mjs` 逐方法对齐两侧。

## 2. usageStats/snapshot

- request `{ sessionId: string | null, limit?: number }`：带 `sessionId` 时返回该会话的 `current` 与
  `series.current`（未知 id 给零值）；`limit` 为会话明细分页上限，`1..1000`（超出截断），默认 `200`，
  浏览器端 `useSnapshot` 以 `500` 请求。
- `series.all` 与各模型 `series` 截断至最近 366 天（`SERIES_MAX_DAYS`），避免长历史全量序列化
  开销；`series.current` 不截断；`all` 与 `models[].usage` 等聚合总量不受截断影响。
- 响应 `value` 为 `UsageSnapshot`（`src/types.ts`）：
  - 扫描报告：`scanning`/`scans`/`failed`/`rawSessions`/`harnessSessions`/`foldedEvents`/
    `dedupSkipped`/`lastError`/`scanError`/`lastScanAt`/`time`；
  - `sessions` 为有量会话数，`current` 为指定会话聚合或 `null`，`all` 为全量 `{ calls, usage }`，
    `series.all`/`series.current` 为 `SeriesPoint[]`；
  - `models[]`：`provider`、`model`、`calls`、`usage`、`series?`（模型按日序列，可缺省）；
  - `sessionsList[]`：按 `lastActive` 倒序、已分页截断的 `SessionStat`（`id`、`title`、`cwd`、`createdAt`、
    `lastActive`、`calls`、`usage`、`parentSession`、`origin`、`delegationDepth`，后三者为子代理归属）。

## 2.1 usageStats/modelDetail

- 单个模型的明细（模型页点开一行）。按需查询、不进快照：「模型 × 会话」交叉表随快照下发会让每
  4 秒一次的轮询体积随「模型数 × 会话数」膨胀。
- request `{ provider: string, model: string, since?: number }`：`provider`/`model` 为账本原始
  「供应商 + 模型」（快照 `models[]` 拆出的两列，非归并后行）；`since` 是浏览器端算好的本地日零点
  （模型页时间范围 → `modelRangeCutoff`），服务端只做 `t >= since` 过滤，缺省或非正数即全部历史。
  模型统计重定向由浏览器端按来源各查一次再合并。
- 响应 `value` 为 `ModelDetail`：`provider`、`model`、范围内合计 `calls`/`usage`、按本地日升序的
  `daily`（只含有量的日子）、按总计降序的 `sessions`（`SessionStat[]`，与快照同形）。`since` 缺省
  的「全部」**不做 366 天截断**：那是快照序列化的取舍，按需查询要与所点行的合计对齐。
- 取数路径与合计口径见 `docs/ARCHITECTURE.md` §3 末条与 §5。纯读：不判 `usageStats/busy`、不写
  账本；扫描或重建进行中返回当前账本数据，可能偏少。

## 2.2 usageStats/dateDetail

- 某一个本地日的明细（日期页点开一行）。按需查询、不进快照：「日 × 会话」交叉数据随快照下发会让
  轮询体积随「有量天数 × 会话数」膨胀。
- request `{ day: number }`：`day` 是浏览器端日期行的本地日零点（`SeriesPoint.t` 原样传来），服务端
  按同一套 `startOfDay`（`src/utils.ts`）归一——有限且大于 0 的取值向下取整后归一，其余一律返回空
  明细（`day` 为 `0`、合计为零、两个维度为空数组），**不抛错**。
- 响应 `value` 为 `DateDetail`：归一后的 `day`、当天合计 `calls`/`usage`、当天有量的
  `models: ModelStat[]`（单日不重复下发 `series`）与 `sessions: SessionStat[]`（均只含当天有量的行）。
  两个维度都按总计降序：模型同值按「供应商 + 模型」升序、会话同值按 `id` 升序。
- 取数路径与三者互校的口径见 `docs/ARCHITECTURE.md` §3 末条与 §5。纯读：不判
  `usageStats/busy`、不写账本；扫描或重建进行中返回当前聚合数据，可能偏少。

## 2.3 usageStats/sessionDetail

- 一条会话的明细（会话页点主会话行的「明细」）：所点行的折叠分组（主会话 + `groupSessions` 展平的全部
  子代理）。按需查询、不进快照——交叉数据会让 4 秒轮询体积随会话数 × 模型数膨胀。
- request `{ sessionIds: string[] }`：**集合由客户端界定**——`groupSessions` 展平后的 `main.id + children[].id`
  （`stats.sessionGroupIds` 单点构造，点击那刻取一次并随弹窗冻结），服务端只聚合给定集合，**不按
  `session_meta` 自走子树**：行数字 = 该集合在聚合缓存里逐会话求和，自走子树会与行数字不同源（快照
  `sessionsList` 有截断、父会话可能没有用量，多级展平与防环也要复刻）。归一：只收非空字符串、精确去重，
  非数组视为空集合，一律**不抛错**、不设条数上限（截断会破坏合计不变量）；id 是不透明键（不 trim、不清洗 NUL、区分大小写）。
- 响应 `value` 为 `SessionDetail`：集合合计 `calls`/`usage`、按本地日升序的 `daily`（只含有量的
  日子、全历史不截断）、按总计降序的 `models`（账本原始键、不归并、省略 `series`）。空集合/全未知
  id 返回字段齐全的空明细（`calls: 0`、零值 `usage`、空数组），不抛错。
- 核心不变量（同一数据代次内逐位精确）：`calls`/`usage` = 所点行折叠后的合计 = `Σdaily` =
  `Σmodels`；明细打开期间新增的用量不并入本次响应（重开或重试对齐）。取数路径见
  `docs/ARCHITECTURE.md` §3 末条。纯读：不判 `usageStats/busy`、不写账本。

## 3. 额度查询通用约定（goQuota / deepseekBalance / zaiQuota 共用）

- body `{ intervalMinutes?: number, force?: boolean }`：`intervalMinutes` 是客户端抓取间隔（分钟，来自偏好
  设置），服务端据此调整 TTL；`force: true` 对应概览磁贴的立即刷新，**完全绕过 TTL 与下限**立即重抓（并发
  仍经单飞合并）。
- **TTL**：有效 TTL = `min(5 分钟, max(3 分钟, intervalMinutes))`；未带间隔默认 5 分钟。抓取结果（含失败的
  结构化结果）写入缓存，窗口从抓取时刻重新起算。
- **单飞**：并发请求只打一次官方端点；缓存仅在内存，**不落账本**。
- **key 解析**：一律经 DSH 凭据中心 `ctx.credentials`，按各节键名顺序回退，不读 `process.env` 或官方 CLI 的
  凭据文件；凭据中心缺席或无 key → `no-key`。
- **传输**：官方端点 + 浏览器 UA 与必要请求头（否则被前置 Cloudflare 以 error 1010 拦截），15s 超时。
- **状态**：无 key、401、403 → `no-key`（各节特例除外）；非 2xx 其他、超时、网络异常、结构非法 → `error`；
  成功 → `ok`。`status` 由客户端本地化展示。

## 3.1 usageStats/goQuota

- OpenCode Go 订阅额度：滚动 5 小时、本周、本月 `percent` 与 `resetsAt`。
- key：仅 `OPENCODE_GO_API_KEY`；端点：`GET https://opencode.ai/zen/go/v1/usage`。
- 响应 `value` 为 `GoQuota`：`{ status: 'ok'|'no-key'|'no-plan'|'error', fetchedAt, rolling, weekly,
  monthly }`，三个窗口为 `GoWindow | null`（`{ percent, resetsAt }`）。
- 特例：401/403 且响应体 `error.type` 为 `EntitlementError`（已配置 Key 但未开通订阅）→ `no-plan`，其余
  401/403（Key 无效等）仍为 `no-key`。

## 3.2 usageStats/deepseekBalance

- DeepSeek 余额：`isAvailable` 与多币种 `balances`；预留今日消耗 `todayAmount`/`todayCurrency`，v1 无官方
  日耗接口、固定为 `null`。
- key：`DEEPSEEK_API_KEY` → `DEEPSEEK_APIKEY` → `DEEPSEEK_API_TOKEN` → `DEEPSEEK_TOKEN`；端点
  `GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <key>`。
- 响应 `value` 为 `DeepSeekBalance`：`{ status, fetchedAt, isAvailable, balances, todayAmount,
  todayCurrency }`；`DeepSeekBalanceInfo` 为 `{ currency, totalBalance, grantedBalance, toppedUpBalance }`，
  金额保持字符串（避免浮点丢失）。
- 归一化：`balance_infos` 逐条经 `normalizeBalanceInfo`——`currency` 非空字符串才保留，金额 `string|number`
  统一为字符串、缺失回退 `"0.00"`，非法条目丢弃不使整批失败；`isAvailable` 仅当 `is_available === true` 时
  为 `true`。
- 特例：`is_available === false` → `ok` + `isAvailable: false`（由 Client 文案区分，不归为 `error`）；
  `balances` 为空数组仍为 `ok`，Client 展示「暂无余额明细」并用本地今日 tokens/calls 降级展示。

## 3.3 usageStats/zaiQuota

- Z.ai 智谱额度：滚动 5 小时、本周百分比窗口与每月 Web 搜索计数；`plan` 取官方 `data.level`（拼成
  `"Z.ai <level>"`，无则 `null`）。
- key：`ZAI_CODING_CN_API_KEY` → `ZAI_API_KEY`（前者优先），不使用 `GLM_API_KEY`；端点
  `GET https://api.z.ai/api/monitor/usage/quota/limit`，`Authorization: Bearer <key>`、`Accept: application/json`。
- 响应 `value` 为 `ZaiQuota`：`{ status: 'ok'|'no-key'|'no-plan'|'error', fetchedAt, plan, session, weekly,
  webSearches }`；`session`/`weekly` 为 `ZaiWindow | null`（`{ percent, resetsAt, used, limit }`），
  `webSearches` 为 `ZaiWebSearchQuota | null`（`{ used, limit, percent, resetsAt }`）。`session`/`weekly` 的
  `percent` 为官方原始浮点（服务端只保证非负），`webSearches.percent` 由 `used/limit` 现算；展示时由
  `goPercent`（取整夹 0..100）与 `goLevelOf` 分档；`used`/`limit` 取官方 `currentValue`/`usage`
  （兼容 `used`/`limit` 别名，未下发为 `null`）；`resetsAt` 由 epoch 毫秒转 ISO。
- 归一化：`data.limits` 逐条按 `type`/`rawType` 归类——`CREDIT_LIMIT`/`TOKENS_LIMIT` 为百分比窗口，按
  `unit` 实际时长归类（`unit:3` 小时×数量 <1 天为会话 5 小时窗口，`unit:4` 天、`unit:5` 月、`unit:6` 周为
  本周），`TIME_LIMIT` 为月度 Web 搜索计数。已识别类型但**全部**窗口归一化失败（如缺 `percentage`）→
  `error`（只要有一个窗口成功即 `ok`）；空 `limits: []` → `ok` 且三窗口 `null`；`limits` 缺失或非数组、
  `data` 为数组 → `error`；`code` 已给出时，非 200 **且** `success` 非 true 才判 `error`（`code` 缺省按通过处理）。
- 特例：`success:false` 且 `msg` 含 `"coding plan"`（如「当前用户不存在coding plan」）→ `no-plan`（合法 key
  但无 GLM Coding Plan）。

## 4. usageStats/rebuild

- 清空账本九表（清单见 `docs/ARCHITECTURE.md` §2）、复位聚合缓存 → 全量重扫日志导入 → 物化预统计
  并把密封边界推进至今日零点 → `{ rebuilt: true, foldedEvents }`。

## 4.1 usageStats/clear

- 清空账本九表、复位聚合缓存 → `{ cleared: true, foldedEvents }`，**不重扫**：重建会重新读取历史
  会话，清零后统计直接归零。清零墓碑与恢复出口见 `docs/ARCHITECTURE.md` §3 的「重建 / 清零 / 密封」。

## 4.2 usageStats/seal

- 手动物化预统计：物化当前内存聚合至 `agg_*`、把密封边界推进至今日零点；响应
  `{ sealed: true, sealedUntil, foldedEvents }`。批量扫描结束会自动物化并推进密封边界；实时事件只增量写
  预统计，通常无需手动调用。**写操作并发**：
  `rebuild`/`clear`/`seal` 在扫描或重建进行中一律 `usageStats/busy` 拒绝（`details.operation` 为方法名）。

## 5. 偏好设置（`usage-stats` 插件条目）

偏好命名空间就是本插件的 profile 条目 id（`cordis.patch.yml` 的 `usage-stats` 行），也是浏览器端取设置表单的键。

- **事实来源**：该条目的 Config 在服务端 profile 配置文档里的片段——偏好属部署而非某个浏览器；文档只存显式改过的字段，其余按 schema 默认值解析。偏好不落账本（账本只记用量）。
- **服务端**：`src/host/settings.ts` 的 `UsageSettingsSchema` 由 `UsageStatsService.Config` 声明，harness
  设置服务（`ctx.settings`）据此投影成设置表单。**每个字段必须标 `.volatile()`**：volatile 字段才被投影、
  才接受写入；条目没声明 schema 时该命名空间不出现，浏览器端只显示默认值、写入被丢弃（设置页提示改动不会保存）。
- **浏览器端**：`ctx.configForms.get('usage-stats')` 取表单（`configForms` 由
  `@deepseek-ai/dsh-client-ui-settings` 提供，已列进 client 的 `inject` 保证加载序），`src/client/settings.ts`
  提供订阅/读写：写入走路径操作、只落显式改过的字段，间隔字段写前夹到下限 3；单字段写入一律是显式 `set`
  ——改回默认值也照样落在文档里，让条目整段消失的只有配置导入的整份替换（`unset`，见 §5.1）。
- **字段**（`UsageSettings` 定义在 `src/types.ts`）：

  | 字段 | 默认 | 语义 |
  |---|---|---|
  | `goEnabled` / `deepseekEnabled` / `zaiEnabled` | `true` | 关闭即**不再轮询**对应额度/余额，侧边栏与模态窗均不显示；该行的侧边栏展示与抓取间隔不可改 |
  | `showGoInSidebar` / `showDeepSeekInSidebar` / `showZaiInSidebar` | `true` | 只门控侧边栏底部芯片（含宽列与 rail），模态窗内详情仍可见 |
  | `goFetchMinutes` / `deepseekFetchMinutes` / `zaiFetchMinutes` | `5`（下限 3） | 抓取间隔，作为对应请求的 `intervalMinutes`，服务端据此调整 TTL |
  | `showSessionId` | `true` | 会话标题右侧 session-id 徽标开关：关闭后 `conversation.session.header.utilities` 的徽标 entry 渲染空 |
  | `modelRedirects` | `[]` | 模型统计重定向规则表，见下 |

- **模型统计重定向**（浏览器端归并，服务端快照与各明细保持原始行）：模型页、日期明细与会话明细的「按模型」
  三处共用 `src/client/stats.ts` 的 `redirectModels`。匹配按 `provider + model` 精确比较（trim 后、区分
  大小写），同一来源只有列表最上面一条生效，四项没填齐的不生效（界面保留待填）；链式规则解析到终点，
  环形规则折到环内最靠前规则的目标上；归并求和用量与调用次数、日序列按本地日逐日求和，目标行不存在时按
  规则名新建，无规则或无命中时原样返回，规则数上限 `MODEL_REDIRECT_MAX_RULES`（50）。规则表整表写入
  （`{op:'set', path:['modelRedirects'], value:[...]}`），`normalizeModelRedirects` 去首尾空白、丢空行、
  截断到上限；自动完成候选由快照 `models` 经 `modelCatalog` 建表，来源侧排除其他行已配过的组合（`unusedRedirectSources`）。

- **读取路径**：表单快照 → `normalizeUsageSettings` 字段级校验（布尔只收布尔、间隔只收有限数并夹取、规则表
  按 `normalizeModelRedirects` 清洗）→ 缺字段回退默认值；表单未就绪同样回退默认值。读不到或写不了配置文档
  时，设置页在表格上方挂状态提示卡。
- **旧版 localStorage 迁移**（key `dsh-usage-stats.settings`，升级后首次挂载一次性）：等表单落定；就绪可写且
  条目尚无用户片段时把与默认值不同的字段写入文档并删除旧键，已有用户片段时只删旧键；服务端设置缺席或只读时
  **保留**旧键（没有可靠落点，删掉等于丢设置）。
- **旧版 `settings.yaml` 命名空间迁移**（两路，都只写与默认值不同的字段、都经 `normalizeUsageSettings` 归一化）：
  1. **基座自动导入**：升级到 0.1.7 基座时把 `$DSH_HOME/settings.yaml` 的同名段导入 profile 条目（文档改名
     `settings.yaml.imported`）；插件此刻已声明 Config schema，旧偏好继续生效。
  2. **插件回收**：基座导入**改名后不重试**——若升级那刻插件还没有 Config schema（0.4.4 及更早），
     `recoverLegacyUsageSettings` 在 Loader 落定后收尾一次：`settings.yaml` 尚在时让基座自己导（不抢写），
     已不在时按该段补丁写进 profile 并记 info；条目已有用户片段（`describe().user` 非空）则让位。
  **同一份旧文档只处理一次**：处理完在插件存储目录写 `legacy-settings-recovered.json` 标记，标记在即启动直接
  返回——之后改回默认、清空条目 config 或留着 `.imported`，旧值都不复活。落标记三现场：回收成功、已有用户
  片段而让位（`action: skipped-user-config`）、旧文档没有本条目那段（`action: nothing-to-restore`）——让位也
  落标记，否则用户清空条目时旧值会复活。其余现场（`settings.yaml` 还在、`.imported` 不存在、条目不在
  `describe()`、写入被拒）都不落标记、下次启动重看。

### 5.1 配置串（导出 / 导入）

- **目的与边界**：把整份偏好搬走再搬回（换机器、备份）。纯浏览器端能力——**不新增 Remote 方法**、不走线路、不落
  账本，落点仍是同一个 profile 条目；实现见 `src/client/configTransfer.ts`（编解码）与 `src/client/settings.ts`
  （`replacementOps` / `replaceUsageSettings`）。
- **形态**：载荷 JSON `{ format: 'dsh-usage-stats', version: 1, exportedAt: <ISO>, settings: <整份偏好> }` →
  UTF-8 → 标准 Base64（带填充）单行文本；`settings` 经 `normalizeUsageSettings` 归一化（含默认值字段），
  「导出 → 导入」逐字段还原；`exportedAt` 只作诊断，非字符串按 `null`。
- **解码容错**：忽略空白与换行；接受 URL 安全字母表（`-`/`_`）与缺失的填充，其余字符即非法。
- **失败语义**（错误码在浏览器端，不进线路）：`empty` 空串、`invalid-base64` 非法字符、`invalid-payload` 非
  JSON 或 `settings` 非普通对象、`unknown-format` 载荷非普通对象或 `format` 不符、`unsupported-version` 版本非 1。
- **导入语义**：**整份覆盖**——与默认值相同的字段发 `unset`（继续跟随 schema 默认值），不同的发 `set`（间隔
  字段夹到下限 3），一次 `mutate` 提交；写入守卫同单字段（表单不可用或只读时不写入，导出只读）。覆盖后字段
  全为默认值时条目用户片段整段消失——那只是配置覆盖层，装载记录在 profile 的 `package.json`，插件照旧加载。
