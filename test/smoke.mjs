/**
 * 用量统计服务端（Host）的独立冒烟测试（账本模式，自管理 sqlite 介质）。
 *
 * 以 mock 的 cordis 服务挂载 apply()（存储不 mock：账本直接写 node:sqlite
 * 文件），喂入真实会话事件（从 session.jsonl.zstd 提取），验证：
 *   - 首启初始化：账本 sqlite 文件落盘（$DSH_HOME/storages/
 *     dsh-usage-statistics/ledger.sqlite），快照从聚合缓存读出；
 *   - 重启恢复：重开同一 sqlite 文件、会话清单返回空，仍能从介质重建统计
 *     （不依赖重扫日志）；
 *   - 实时重放事件经 seq 水位去重，不重复计数；
 *   - rebuild API 清空账本并重扫；
 *   - 回环围栏与 go-quota 路由。
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 隔离 DSH_HOME：账本 sqlite 写入临时目录，避免污染真实 ~/.dsh。
const tmpHome = mkdtempSync(join(tmpdir(), 'usage-stats-smoke-'))
process.env.DSH_HOME = tmpHome
const ledgerDir = join(tmpHome, 'storages', 'dsh-usage-statistics')
const dbFile = join(ledgerDir, 'ledger.sqlite')

const { apply } = await import('../lib/index.js')

// 真实会话事件 fixture（从 ~/.dsh/sessions 解码、裁剪出的 usage 相关行）
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'session-events.jsonl')
const events = readFileSync(fixturePath, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
const SESSION_ID = 'session-910656fd-379b-4651-8301-c9233eaeead7'
const OTHER_ID = 'session-66d03fb3-cffa-4af1-bc0b-4afcf034fac4'

let route = null
const webServer = {
  register(r) { route = r; return () => {} },
}
const sessionQuery = {
  async listSessions() { return [{ header: { id: SESSION_ID } }, { header: { id: OTHER_ID } }] },
  async readSession(id) { return { events: id === SESSION_ID ? events : [] } },
}
// persistence 后端 mock：声明支持原始工件（readRaw），解码/输出来自预提取的
// 真实事件 —— 冒烟应走 RAW 优先路径（persistence.readRaw），不再需要 zstd CLI。
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

// 挂载插件（apply 同步；初始扫描在 apply 内 fire-and-forget）
apply(mockCtx(sessionQuery, sessionPersistence))

// 等待初始扫描完成（sqlite 同步落盘，等待折叠结束即可）
await new Promise((r) => setTimeout(r, 3000))

if (!route) { console.error('FAIL: route not registered'); process.exit(1) }
console.log('route:', route.kind, route.path)

// 账本落盘验证：自管理 sqlite 文件存在
if (!existsSync(dbFile)) {
  console.error('FAIL: sqlite 账本文件未生成', dbFile)
  process.exit(1)
}
console.log('sqlite ledger:', dbFile)

function callRoute(body, url = '/usage-stats/api/snapshot') {
  return new Promise((resolve, reject) => {
    const handlers = {}
    const req = {
      url,
      method: 'POST',
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      on(ev, fn) { (handlers[ev] ||= []).push(fn) },
      destroy() {},
    }
    const res = {
      writeHead(status, headers) { res.status = status; res.headers = headers },
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

async function snapshotBody(body = { sessionId: null }) {
  const out = await callRoute(body)
  if (out.status !== 200) throw new Error(`快照 HTTP ${out.status}: ${out.payload}`)
  return JSON.parse(out.payload).value
}

const snap = await snapshotBody()
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

// 回环围栏测试
const out3 = await callRoute({ sessionId: null })
const snap3raw = JSON.parse(out3.payload)
console.log('loopback ok:', snap3raw.ok === true)

// OpenCode Go 额度路由：queryGoQuota 永不抛错（结构化状态）
const goOut = await callRoute({}, '/usage-stats/api/go-quota')
const goBody = JSON.parse(goOut.payload)
console.log('go-quota ok:', goBody.ok === true, '| status:', goBody.value?.status, '| rolling:', goBody.value?.rolling?.percent ?? null)
if (goBody.ok !== true || !['ok', 'no-key', 'error'].includes(goBody.value?.status)) {
  console.error('FAIL: unexpected go-quota response')
  process.exit(1)
}

// go-quota 支持客户端抓取间隔（TTL 适配）：携带 intervalMinutes（如 3 分钟下限）
// 不改变结构化结果，且不抛错；未携带时用默认 5 分钟（上面已覆盖）。
const goOut2 = await callRoute({ intervalMinutes: 3 }, '/usage-stats/api/go-quota')
const goBody2 = JSON.parse(goOut2.payload)
console.log('go-quota w/ interval ok:', goBody2.ok === true, '| status:', goBody2.value?.status)
if (goBody2.ok !== true || !['ok', 'no-key', 'error'].includes(goBody2.value?.status)) {
  console.error('FAIL: unexpected go-quota response with intervalMinutes')
  process.exit(1)
}

// go-quota force=true：绕过 TTL 缓存强制重新抓取（仍返回结构化状态，不抛错）
const goOut3 = await callRoute({ intervalMinutes: 3, force: true }, '/usage-stats/api/go-quota')
const goBody3 = JSON.parse(goOut3.payload)
console.log('go-quota force ok:', goBody3.ok === true, '| status:', goBody3.value?.status)
if (goBody3.ok !== true || !['ok', 'no-key', 'error'].includes(goBody3.value?.status)) {
  console.error('FAIL: unexpected go-quota response with force')
  process.exit(1)
}

// 重启恢复路径：重开同一 sqlite 文件、会话清单返回空 → 账本有事件 →
// 直接从介质重建聚合缓存（不重扫日志）
const emptyQuery = { async listSessions() { return [] }, async readSession() { return { events: [] } } }
const emptyPersist = { async list() { return [] }, async readFrom() { return { events: [] } }, supportsRawArtifacts: true, async readRaw() { return undefined } }
apply(mockCtx(emptyQuery, emptyPersist))
await new Promise((r) => setTimeout(r, 500))
const snap4 = await snapshotBody()
console.log('after reopen (rebuild from medium):', JSON.stringify({ calls: snap4.all.calls, foldedEvents: snap4.foldedEvents, sessions: snap4.sessions }))
if (snap4.all.calls !== snap.all.calls) {
  console.error('FAIL: 重启恢复统计不一致（应直接从 sqlite 重建）')
  process.exit(1)
}

// 清理临时 DSH_HOME
rmSync(tmpHome, { recursive: true, force: true })
console.log('SMOKE TEST PASSED')