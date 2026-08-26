/**
 * 用量统计服务端（Host）的独立冒烟测试（账本模式，自管理 sqlite 介质）。
 *
 * 以 mock 的 cordis 服务挂载 apply()（存储不 mock：账本直接写 node:sqlite
 * 文件），喂入真实会话事件（从 session.jsonl.zstd 提取），验证：
 *   - 首启初始化：账本 sqlite 文件落盘（$DSH_HOME/storages/
 *     dsh-usage-stats/ledger.sqlite），快照从聚合缓存读出；
 *   - 绝对基线（AGENTS §9）：快照 foldedEvents 锚定 fixture 的 394 条可折叠
 *     事件，初始扫描 / 实时去重 / rebuild / 重开介质四处一致；
 *   - 重启恢复：重开同一 sqlite 文件、会话清单返回空，仍能从介质重建统计
 *     （不依赖重扫日志）；
 *   - 实时重放事件经 seq 水位去重，不重复计数；
 *   - rebuild API 清空账本并重扫；
 *   - 信任围栏双闸：非回环 Host、回环但缺 x-dsh-usage-stats 自定义头均 403；
 *   - go-quota 在清空 key / home 定位环境变量的隔离段内运行，精确期望
 *     结构化 no-key，不产生任何真实外网请求。
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 隔离 DSH_HOME：账本 sqlite 写入临时目录，避免污染真实 ~/.dsh。
const tmpHome = mkdtempSync(join(tmpdir(), 'usage-stats-smoke-'))
process.env.DSH_HOME = tmpHome
const ledgerDir = join(tmpHome, 'storages', 'dsh-usage-stats')
const dbFile = join(ledgerDir, 'ledger.sqlite')

const { apply } = await import('../lib/index.js')

// 真实会话事件 fixture（从 ~/.dsh/sessions 解码、裁剪出的 usage 相关行）
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'session-events.jsonl')
const events = readFileSync(fixturePath, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
const SESSION_ID = 'session-910656fd-379b-4651-8301-c9233eaeead7'
const OTHER_ID = 'session-66d03fb3-cffa-4af1-bc0b-4afcf034fac4'
// 绝对基线（AGENTS §9）：fixture 共 397 行，其中 394 条为带 usage 且各 token
// 分量非负且总和为正的 assistant/message 事件 —— 全部可折叠（foldLedgerEvent
// 对零用量行跳过）。期望值从 fixture 运行时推导后锚定 394：fixture 被裁剪或
// 折叠口径回归时，双重断言都会显式失败而非静默通过。
const foldableCount = events.filter((e) => {
  if (e?.type !== 'assistant/message') return false
  const u = e.data?.usage
  if (u == null || typeof u !== 'object') return false
  const sum = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) + (u.reasoningTokens || 0)
  return Number.isFinite(sum) && sum > 0
}).length
if (foldableCount !== 394) {
  console.error(`FAIL: fixture 可折叠事件数为 ${String(foldableCount)}，与 AGENTS §9 锚定的 394 不一致（fixture 被改动？）`)
  process.exit(1)
}
const EXPECTED_FOLDED = foldableCount

let route = null
const webServer = {
  register(r) { route = r; return () => {} },
}
const sessionQuery = {
  async listSessions() { return [{ header: { id: SESSION_ID } }, { header: { id: OTHER_ID } }] },
  async readSession(id) { return { events: id === SESSION_ID ? events : [] } },
}
// persistence 后端 mock：声明支持原始工件（readRaw），解码/输出来自预提取的真实事件。
const sessionPersistence = {
  async list() { return [{ id: SESSION_ID }, { id: OTHER_ID }] },
  async readFrom(id) { return { events: id === SESSION_ID ? events : [] } },
  supportsRawArtifacts: true,
  async readRaw(id) {
    if (id !== SESSION_ID) return undefined
    return {
      meta: { id, version: 1 },
      filename: 'session.jsonl',
      content: events.map((e) => JSON.stringify(e)).join('\n'),
    }
  },
}

/** 构造一个带 mock 服务的上下文（等价组合层注入 webServer 等之后）。 */
function mockCtx(query, persist) {
  return {
    webServer,
    sessionQuery: query,
    sessionPersistence: persist,
    get(name) {
      return { webServer, sessionQuery: query, sessionPersistence: persist }[name]
    },
    on(event, fn) { listeners[event] = fn },
    effect(fn) { return fn() },
  }
}

const listeners = {}

// 挂载插件（apply 同步注册路由；初始扫描在 apply 内 fire-and-forget）
apply(mockCtx(sessionQuery, sessionPersistence))

if (!route) { console.error('FAIL: route not registered'); process.exit(1) }
console.log('route:', route.kind, route.path)

// CSRF 自定义头围栏的请求头名/值（与服务端 http.ts 约定一致）
const CSRF_NAME = 'x-dsh-usage-stats'
const CSRF_VALUE = 'dsh-usage-stats'

/**
 * 构造 mock 请求调用路由。默认携带合法回环 Host 与 CSRF 自定义头；
 * opts.host 覆盖 Host（围栏负向用例），opts.csrfHeader=false 省略自定义头。
 */
function requestRoute(body, url = '/usage-stats/api/snapshot', opts = {}) {
  const { host = '127.0.0.1:3080', csrfHeader = true } = opts
  return new Promise((resolve, reject) => {
    const handlers = {}
    const headers = { host, 'content-type': 'application/json' }
    if (csrfHeader) headers[CSRF_NAME] = CSRF_VALUE
    const req = {
      url,
      method: 'POST',
      headers,
      on(ev, fn) { (handlers[ev] ||= []).push(fn) },
      destroy() {},
    }
    const res = {
      writeHead(status, hdrs) { res.status = status; res.headers = hdrs },
      end(payload) { resolve({ status: res.status, payload }) },
    }
    if (body !== undefined) {
      queueMicrotask(() => {
        for (const fn of handlers.data || []) fn(Buffer.from(JSON.stringify(body)))
        for (const fn of handlers.end || []) fn()
      })
    } else {
      queueMicrotask(() => { for (const fn of handlers.end || []) fn() })
    }
    route.handler(req, res).catch(reject)
  })
}

/** 默认调用（合法回环 Host + CSRF 自定义头）。 */
function callRoute(body, url = '/usage-stats/api/snapshot') {
  return requestRoute(body, url)
}

/** 指定 Host 的调用（回环围栏负向用例）。 */
function callRouteWithHost(body, host, url = '/usage-stats/api/snapshot') {
  return requestRoute(body, url, { host })
}

// 账本落盘验证：自管理 sqlite 文件存在（openLedger 在 apply 内同步建库）
if (!existsSync(dbFile)) {
  console.error('FAIL: sqlite 账本文件未生成', dbFile)
  process.exit(1)
}
console.log('sqlite ledger:', dbFile)

async function snapshotBody(body = { sessionId: null }) {
  const out = await callRoute(body)
  if (out.status !== 200) throw new Error(`快照 HTTP ${out.status}: ${out.payload}`)
  return JSON.parse(out.payload).value
}

/**
 * 轮询 snapshot 直到 foldedEvents > 0 或超时抛错（每 ~intervalMs 一次，
 * 默认 10s 上限）：替代固定 sleep，等待初始扫描 / 重开介质重建完成。
 */
async function waitForFolded(timeoutMs = 10_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = await snapshotBody()
    if (s.foldedEvents > 0) return s
    if (Date.now() > deadline) {
      throw new Error(`等待折叠超时（${String(timeoutMs)}ms）：foldedEvents 仍为 0`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// 等待初始扫描完成：轮询至首条事件折叠，首个就绪快照即统计基线
const snap = await waitForFolded()
// 绝对基线锚定：初始扫描折满 fixture 全部 394 条可用事件（AGENTS §9）
if (snap.foldedEvents !== EXPECTED_FOLDED) {
  console.error(`FAIL: 快照 foldedEvents=${String(snap.foldedEvents)}，应为 ${String(EXPECTED_FOLDED)}`)
  process.exit(1)
}
console.log(JSON.stringify({
  scanning: snap.scanning,
  sessions: snap.sessions,
  all: snap.all,
  models: snap.models,
  sessionsList: snap.sessionsList.map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, calls: s.calls, total: s.usage.total })),
  seriesPoints: snap.series.all.length,
  foldedEvents: snap.foldedEvents,
  rawSessions: snap.rawSessions,       // RAW 优先路径（persistence.readRaw）命中的会话数
  harnessSessions: snap.harnessSessions, // harness 兜底路径命中的会话数
}, null, 2))

// 实时去重测试：经 session/event 重放同样的事件，总数不应翻倍
for (const ev of events.slice(0, 20)) listeners['session/event']({ id: SESSION_ID }, ev)
await new Promise((r) => setTimeout(r, 300))
const snap2 = await snapshotBody({ sessionId: SESSION_ID })
console.log('after live replay (should equal before):', JSON.stringify({ calls: snap2.all.calls, current: snap2.current }))
if (snap2.all.calls !== snap.all.calls) {
  console.error('FAIL: live replay double-counted!')
  process.exit(1)
}
if (snap2.foldedEvents !== EXPECTED_FOLDED) {
  console.error(`FAIL: 实时重放后 foldedEvents=${String(snap2.foldedEvents)}，应仍为 ${String(EXPECTED_FOLDED)}（去重失效）`)
  process.exit(1)
}

// rebuild API：清空账本 → 重扫 → 统计重建
const rebuildOut = await callRoute({}, '/usage-stats/api/rebuild')
const rebuildBody = JSON.parse(rebuildOut.payload)
console.log('rebuild ok:', rebuildBody.ok === true)
if (rebuildBody.ok !== true) {
  console.error('FAIL: rebuild failed')
  process.exit(1)
}
const snap3 = await snapshotBody()
console.log('after rebuild:', JSON.stringify({ foldedEvents: snap3.foldedEvents, calls: snap3.all.calls }))
if (snap3.all.calls !== snap.all.calls) {
  console.error('FAIL: rebuild 后统计不一致')
  process.exit(1)
}
// rebuild 后事件重扫折满同一绝对基线
if (snap3.foldedEvents !== EXPECTED_FOLDED) {
  console.error(`FAIL: rebuild 后 foldedEvents=${String(snap3.foldedEvents)}，应为 ${String(EXPECTED_FOLDED)}`)
  process.exit(1)
}

// 回环围栏测试
const out3 = await callRoute({ sessionId: null })
const snap3raw = JSON.parse(out3.payload)
console.log('loopback ok:', snap3raw.ok === true)

// 回环围栏拒绝分支（非回环 host 应返回同形 403 forbidden）
const forbiddenOut = await callRouteWithHost({}, 'evil.com', '/usage-stats/api/snapshot')
const forbiddenBody = JSON.parse(forbiddenOut.payload)
console.log('loopback forbidden ok:', forbiddenOut.status === 403 && forbiddenBody.ok === false &&
  forbiddenBody.error?.code === 'forbidden' && forbiddenBody.error?.message === 'forbidden')
if (forbiddenOut.status !== 403 || forbiddenBody.ok !== false ||
  forbiddenBody.error?.code !== 'forbidden' || forbiddenBody.error?.message !== 'forbidden') {
  console.error('FAIL: 回环围栏未拒绝非回环 host')
  process.exit(1)
}

// CSRF 自定义头围栏拒绝分支：合法回环 Host 但缺 x-dsh-usage-stats 头 →
// 与非回环 403 同形 { ok:false, error:{ code:'forbidden', message:'forbidden' } }
const csrfOut = await requestRoute({}, '/usage-stats/api/snapshot', { csrfHeader: false })
const csrfBody = JSON.parse(csrfOut.payload)
console.log('csrf header forbidden ok:', csrfOut.status === 403 && csrfBody.ok === false &&
  csrfBody.error?.code === 'forbidden' && csrfBody.error?.message === 'forbidden')
if (csrfOut.status !== 403 || csrfBody.ok !== false ||
  csrfBody.error?.code !== 'forbidden' || csrfBody.error?.message !== 'forbidden') {
  console.error('FAIL: 回环请求缺 CSRF 自定义头未被拒绝')
  process.exit(1)
}

// go-quota 段网络隔离：清空 key 相关环境变量与 home / XDG 定位变量，使
// resolveGoKey 确定性返回 null → fetchGoQuota 直接短路为 no-key，
// 冒烟测试不产生任何真实外网请求；段结束（含异常路径）后恢复原环境。
const GO_ENV_KEYS = ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']
const savedGoEnv = GO_ENV_KEYS.map((k) => [k, process.env[k]])
for (const k of GO_ENV_KEYS) delete process.env[k]
try {
  // OpenCode Go 额度路由：无 key 场景精确期望结构化 no-key（永不抛错、不出网）
  const goOut = await callRoute({}, '/usage-stats/api/go-quota')
  const goBody = JSON.parse(goOut.payload)
  console.log('go-quota ok:', goBody.ok === true, '| status:', goBody.value?.status)
  if (goBody.ok !== true || goBody.value?.status !== 'no-key') {
    console.error('FAIL: unexpected go-quota response (expected no-key)')
    process.exit(1)
  }

  // go-quota 支持客户端抓取间隔（TTL 适配）：携带 intervalMinutes（如 3 分钟下限）
  // 命中有效 TTL 缓存，仍为同一 no-key 结构化结果。
  const goOut2 = await callRoute({ intervalMinutes: 3 }, '/usage-stats/api/go-quota')
  const goBody2 = JSON.parse(goOut2.payload)
  console.log('go-quota w/ interval ok:', goBody2.ok === true, '| status:', goBody2.value?.status)
  if (goBody2.ok !== true || goBody2.value?.status !== 'no-key') {
    console.error('FAIL: unexpected go-quota response with intervalMinutes (expected no-key)')
    process.exit(1)
  }

  // go-quota force=true：绕过 TTL 缓存强制重新抓取；无 key 下仍确定性
  // 短路为 no-key（且受官方端点频率保护，不出网）。
  const goOut3 = await callRoute({ intervalMinutes: 3, force: true }, '/usage-stats/api/go-quota')
  const goBody3 = JSON.parse(goOut3.payload)
  console.log('go-quota force ok:', goBody3.ok === true, '| status:', goBody3.value?.status)
  if (goBody3.ok !== true || goBody3.value?.status !== 'no-key') {
    console.error('FAIL: unexpected go-quota response with force (expected no-key)')
    process.exit(1)
  }
} finally {
  for (const [k, v] of savedGoEnv) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

// 重启恢复路径：重开同一 sqlite 文件、会话清单返回空 → 账本有事件 →
// 直接从介质重建聚合缓存（不重扫日志）
const emptyQuery = { async listSessions() { return [] }, async readSession() { return { events: [] } } }
const emptyPersist = { async list() { return [] }, async readFrom() { return { events: [] } }, supportsRawArtifacts: true, async readRaw() { return undefined } }
apply(mockCtx(emptyQuery, emptyPersist))
// 重开介质后同样轮询等待从预统计重建完成（替代固定 sleep，慢机稳健）
const snap4 = await waitForFolded()
console.log('after reopen (rebuild from medium):', JSON.stringify({ calls: snap4.all.calls, foldedEvents: snap4.foldedEvents, sessions: snap4.sessions }))
if (snap4.all.calls !== snap.all.calls) {
  console.error('FAIL: 重启恢复统计不一致（应直接从 sqlite 重建）')
  process.exit(1)
}
// 重开介质后从预统计加载，事件计数与账本一致（含增量对账后的崩溃窗口收敛）
if (snap4.foldedEvents !== EXPECTED_FOLDED) {
  console.error(`FAIL: 重启恢复 foldedEvents=${String(snap4.foldedEvents)}，应为 ${String(EXPECTED_FOLDED)}`)
  process.exit(1)
}

// 清理临时 DSH_HOME
rmSync(tmpHome, { recursive: true, force: true })
console.log('SMOKE TEST PASSED')