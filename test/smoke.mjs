/**
 * 用量统计服务端（Host）的独立冒烟测试（账本模式）。
 *
 * 以 mock 的 cordis 服务挂载 apply()，喂入真实会话事件（从
 * session.jsonl.zstd 提取），再调用注册的 /usage-stats/api/snapshot
 * 路由并打印快照。DSH_HOME 指向临时目录，验证：
 *   - 首启初始化：账本事件流与会话元数据落盘（storages/dsh-usage-statistics/）；
 *   - 快照从聚合缓存读出（不依赖持久化会话日志）；
 *   - 实时重放事件经 seq 水位去重，不重复计数；
 *   - rebuild API 清空账本并重扫；
 *   - 回环围栏与 go-quota 路由。
 */
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：账本写入临时目录，避免污染真实 ~/.dsh。
const tmpHome = mkdtempSync(join(tmpdir(), 'usage-stats-smoke-'))
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')

const events = readFileSync('/tmp/session-events.jsonl', 'utf8')
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
const timer = { interval() {} }

const listeners = {}
const ctx = {
  webServer,
  sessionQuery,
  sessionPersistence,
  timer,
  get(name) {
    return { webServer, sessionQuery, sessionPersistence, timer }[name]
  },
  on(ev, fn) { listeners[ev] = fn },
  effect(fn) { return fn() },
}

apply(ctx)

// 等待初始扫描完成 + 会话元数据防抖落盘（2s）
await new Promise((r) => setTimeout(r, 3000))

if (!route) { console.error('FAIL: route not registered'); process.exit(1) }
console.log('route:', route.kind, route.path)

// 账本落盘验证：事件流分片 + 会话元数据文件存在
const ledgerDir = join(tmpHome, 'storages', 'dsh-usage-statistics')
const eventsDir = join(ledgerDir, 'events')
const metaFile = join(ledgerDir, 'session-meta.json')
if (!existsSync(eventsDir) || !existsSync(metaFile)) {
  console.error('FAIL: 账本目录未生成', ledgerDir)
  process.exit(1)
}
const shards = readdirSync(eventsDir).filter((n) => n.endsWith('.jsonl'))
if (shards.length === 0) {
  console.error('FAIL: 事件流分片为空')
  process.exit(1)
}
const shardTotal = shards.reduce((sum, n) => sum + readFileSync(join(eventsDir, n), 'utf8').split('\n').filter(Boolean).length, 0)
console.log('ledger events:', shardTotal, '| shards:', shards.join(', '))

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
await new Promise((r) => setTimeout(r, 100))
const snap2 = await snapshotBody({ sessionId: SESSION_ID })
console.log('after live replay (should equal before):', JSON.stringify({ calls: snap2.all.calls, current: snap2.current }))
if (snap2.all.calls !== snap.all.calls) {
  console.error('FAIL: live replay double-counted!')
  process.exit(1)
}

// rebuild API：清空账本 → 重扫 → 事件流重建
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

// 清理临时 DSH_HOME
rmSync(tmpHome, { recursive: true, force: true })
console.log('SMOKE TEST PASSED')