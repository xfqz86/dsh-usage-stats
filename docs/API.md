# JSON API 与运行时协议

本插件服务端（Host）暴露的 HTTP 协议与客户端偏好设置的完整约定。随接口演进
维护；AGENTS.md 只保留不变量（POST only、回环围栏、注入清单），不重复本文件
细节。类型单一事实来源在 `src/types.ts`。

## 1. 通用约定

- 路由前缀 `/usage-stats/api`，**仅 POST**，body `application/json`。
- 每次调用先过**回环围栏**（仅 127.0.0.1 / localhost / ::1 / 127.x 网段 Host
  可访问，防 DNS 重绑定 / 跨站探测）；非回环返回 403
  `{ ok: false, error: { code: 'forbidden' } }`。
- 成功响应 `{ ok: true, value }`；失败 `{ ok: false, error: { code, message } }`。
- 非 POST → 405 `method-error`；未知方法 / 路径含斜杠 → 404 `not-found`；
  执行异常 → `writeError`（5xx）。

## 2. POST /usage-stats/api/snapshot

- body `{ sessionId?: string }`（带 sessionId 时返回对应会话的 `current` /
  `series.current`）。
- 响应 `value` 字段（`UsageSnapshot`，类型见 `src/client/useSnapshot.ts`）：
  - 统计元信息：`scanning` / `scans` / `failed` / `rawSessions` /
    `harnessSessions` / `foldedEvents` / `dedupSkipped` / `lastError` /
    `scanError` / `lastScanAt` / `time`；
  - `sessions`（有量会话数）、`all`（全量 `Agg`）、`series.all`（按日
    `SeriesPoint[]`）`models[]`（模型拆分）、`sessionsList[]`（会话明细）。

## 3. POST /usage-stats/api/go-quota

- 目的：OpenCode Go 订阅额度（滚动 5 小时 / 本周 / 本月 `percent` +
  `resetsAt`）。
- body `{ intervalMinutes?: number, force?: boolean }` —— `intervalMinutes` 是
  客户端抓取间隔（分钟，见 §5）；`force: true`（概览 Go 磁贴"立即刷新"按钮）
  绕过有效 TTL 缓存强制重新抓取，但**仍受 3 分钟强制下限保护**（距上次抓取不足
  3 分钟时返回最近一次结果，避免刷爆官方端点）。
- 响应 `value`：`GoQuota`（`src/types.ts`）
  `{ status: 'ok' | 'no-key' | 'error', fetchedAt, rolling, weekly, monthly }`，
  `status` 由客户端按文案本地化展示。
- **key 解析**：环境变量 `OPENCODE_GO_API_KEY` → 兼容旧名 `OPENCODE_API_KEY`
  → opencode CLI 登录态 `auth.json`（`['opencode-go'].key`，与 CLI 共用登录态）。
- **端点** `https://opencode.ai/zen/go/v1/usage` + 浏览器 UA（否则被前置
  Cloudflare 以 error 1010 拦截）。
- **缓存**：有效 TTL = `min(5 分钟, max(3 分钟, intervalMinutes))`；未带间隔
  默认 5 分钟；**单飞**（并发请求只打一次官方端点）。
- **语义**：无 key / 401 / 403 → `no-key`；请求失败 / 结构非法 → `error`；
  成功 → `ok`。

## 4. POST /usage-stats/api/rebuild

- 清空 sqlite 两表 + 复位聚合缓存 → 全量重扫日志导入 →
  `{ rebuilt: true, foldedEvents }`。设置页有入口。

## 4.1 POST /usage-stats/api/clear

- 清空 sqlite 两表 + 复位聚合缓存 → `{ cleared: true, foldedEvents }`，
  **不重扫**（与重建的区别：重建会重新读取历史会话，清零不会，统计直接归零）。
  设置页有入口（二次确认）。

## 5. 偏好设置（浏览器端 localStorage）

- key `dsh-usage-statistics.settings`；读取失败 / 字段非法回退默认值。
- 字段（`UsageSettings`，`src/client/settings.ts`）：
  - `goEnabled`（默认 `true`）：关闭则**不再轮询** go-quota，侧边栏与模态窗
    均不显示 Go 额度；
  - `showGoInSidebar`（默认 `true`）：只门控侧边栏底部 Go 芯片（宽列 /
    rail），模态窗内额度详情仍可见；
  - `goFetchMinutes`（默认 5，下限 3）：抓取间隔，同时作为 go-quota 请求体的
    `intervalMinutes`，服务端据此调整 TTL。
- 关闭 `goEnabled` 时，「侧边栏展示」与「抓取间隔」两项一并置灰不可改。
- 纯浏览器端持久化（不落账本），刷新页面后仍生效。
