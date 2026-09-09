/**
 * 用量统计服务端 Remote 方法的独立冒烟测试（账本模式，自管理 sqlite 介质）。
 *
 * 以真实 cordis Context 挂载 UsageStatsService（存储不 mock：账本直接写
 * node:sqlite 文件），直接调用 7 个 @Remote 方法，验证：
 *   - 首启初始化：账本 sqlite 文件落盘（$DSH_HOME/storages/
 *     dsh-usage-stats/ledger.sqlite），快照从聚合缓存读出；
 *   - 绝对基线（AGENTS §9）：快照 foldedEvents 锚定 fixture 的 394 条可折叠
 *     事件，初始扫描 / 实时去重 / rebuild / 重开介质四处一致；
 *   - 方法与手写严格贡献相容：真实出入值过 zod 信封，错误码透传不断解析；
 *   - rebuild 并发返回 usageStats/busy，clear/seal 语义正确；
 *   - 三路额度在凭据中心缺席时确定性 no-key，不产生任何真实外网请求；
 *   - 重启恢复：重开同一 sqlite 文件、会话清单返回空，仍能从介质重建统计
 *     （不依赖重扫日志）。
 * 信任与认证由网关载体统一处理，本测试只覆盖业务语义。
 *
 * 运行 `node --experimental-strip-types test/smoke.mjs`：lib 内 Remote
 * 服务为构建产物，贡献（zod）直引 src 源码。
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context, Service as CordisService } from '@deepseek-ai/cordis'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import UsageStatsService from '../lib/index.js'
import { USAGE_STATS_REMOTE } from '../src/remote/contribution.ts'

// 隔离 DSH_HOME：账本 sqlite 写入临时目录，避免污染真实 ~/.dsh。
const tmpHome = mkdtempSync(join(tmpdir(), 'usage-stats-smoke-'))
process.env.DSH_HOME = tmpHome
const ledgerDir = join(tmpHome, 'storages', 'dsh-usage-stats')
const dbFile = join(ledgerDir, 'ledger.sqlite')

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

/**
 * 挂载服务：等价组合层注入 sessionQuery 等之后，凭据中心缺席覆盖回退路径。
 * 直接构造并手动触发 [Service.init]（生产环境由 Loader 完成这两步）。
 */
async function mount(query, persist) {
  const ctx = new Context()
  ctx.provide('sessionQuery', query)
  ctx.provide('sessionPersistence', persist)
  let svc
  const fiber = ctx.plugin({
    // 与服务 static inject 同形；credentials 可选不进 inject，
    // 服务内经 ctx.get 判空，缺席覆盖回退路径。
    inject: ['sessionQuery', 'sessionPersistence'],
    apply(c) {
      svc = new UsageStatsService(c)
      svc[CordisService.init]()
    },
  })
  await fiber
  // fiber 就绪与 apply 执行之间有一拍延迟，轮询等待实例落定。
  {
    const deadline = Date.now() + 10_000
    while (!(svc instanceof UsageStatsService)) {
      if (Date.now() > deadline) {
        console.error('FAIL: usageStats 服务未挂载')
        process.exit(1)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  // 7 个 @Remote 标记全部存活：网关 SRC 分发的前提。
  const markers = remoteMethods(svc).map((m) => m.exportName ?? m.method)
  for (const name of ['snapshot', 'rebuild', 'clear', 'seal', 'goQuota', 'deepseekBalance', 'zaiQuota']) {
    if (!markers.includes(name)) {
      console.error(`FAIL: 缺 @Remote 标记 ${name}`)
      process.exit(1)
    }
  }
  return { ctx, svc, dispose: () => fiber.dispose() }
}

/** 取描述符：方法与手写严格贡献一致的单一断言入口。 */
function descriptorOf(method) {
  const found = USAGE_STATS_REMOTE.descriptors.find((d) => d.method === method)
  if (!found) {
    console.error(`FAIL: 贡献缺方法 ${method}`)
    process.exit(1)
  }
  return found
}

/** 真实结果过 zod 成功信封：方法实现与手写 codec 相容。 */
function assertEnvelope(method, value) {
  const parsed = descriptorOf(method).result
  if (parsed.mode !== 'strict') {
    console.error(`FAIL: ${method} 结果无严格 codec`)
    process.exit(1)
  }
  parsed.schema.parse({ ok: true, value })
}

const mounted = await mount(sessionQuery, sessionPersistence)
const svc = mounted.svc

// 账本落盘验证：自管理 sqlite 文件存在（构造时同步建库）
if (!existsSync(dbFile)) {
  console.error('FAIL: sqlite 账本文件未生成', dbFile)
  process.exit(1)
}
console.log('sqlite ledger:', dbFile)

/**
 * 轮询 snapshot 直到 foldedEvents > 0 或超时抛错（每 ~intervalMs 一次，
 * 默认 10s 上限）：替代固定 sleep，等待初始扫描 / 重开介质重建完成。
 */
async function waitForFolded(timeoutMs = 10_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = svc.snapshot({ sessionId: null })
    assertEnvelope('snapshot', s)
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
for (const ev of events.slice(0, 20)) svc.ctx.emit('session/event', { id: SESSION_ID }, ev)
await new Promise((r) => setTimeout(r, 300))
const snap2 = svc.snapshot({ sessionId: SESSION_ID })
assertEnvelope('snapshot', snap2)
console.log('after live replay (should equal before):', JSON.stringify({ calls: snap2.all.calls, current: snap2.current }))
if (snap2.all.calls !== snap.all.calls) {
  console.error('FAIL: live replay double-counted!')
  process.exit(1)
}
if (snap2.foldedEvents !== EXPECTED_FOLDED) {
  console.error(`FAIL: 实时重放后 foldedEvents=${String(snap2.foldedEvents)}，应仍为 ${String(EXPECTED_FOLDED)}（去重失效）`)
  process.exit(1)
}

// rebuild 并发：第二路以 usageStats/busy 拒绝，码与归属透传
const rebuilding = svc.rebuild()
const busy = await svc.rebuild().then(() => null, (e) => e)
const busyFailure = remoteErrorOf(busy)
console.log('rebuild busy ok:', busyFailure?.code === 'usageStats/busy' && busyFailure.details?.operation === 'rebuild')
if (busyFailure?.code !== 'usageStats/busy' || busyFailure.details?.operation !== 'rebuild') {
  console.error('FAIL: rebuild 并发未返回 usageStats/busy')
  process.exit(1)
}
// busy 错误同样过 zod 错误信封（透传不断解析）。
{
  const parsed = descriptorOf('rebuild').result
  if (parsed.mode !== 'strict') {
    console.error('FAIL: rebuild 结果无严格 codec')
    process.exit(1)
  }
  parsed.schema.parse({ ok: false, error: { code: busyFailure.code, message: 'busy', details: busyFailure.details } })
}
await rebuilding

// rebuild API：清空账本 → 重扫 → 统计重建
const snap3 = svc.snapshot({ sessionId: null })
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

// 三路额度：凭据中心缺席 → 确定性 no-key，不出网；interval/force 语义一致
const go = await svc.goQuota({})
assertEnvelope('goQuota', go)
console.log('go-quota ok:', go.status === 'no-key')
if (go.status !== 'no-key') {
  console.error('FAIL: unexpected go-quota response (expected no-key)')
  process.exit(1)
}
const go2 = await svc.goQuota({ intervalMinutes: 3 })
if (go2.status !== 'no-key') {
  console.error('FAIL: unexpected go-quota response with intervalMinutes (expected no-key)')
  process.exit(1)
}
const go3 = await svc.goQuota({ intervalMinutes: 3, force: true })
if (go3.status !== 'no-key') {
  console.error('FAIL: unexpected go-quota response with force (expected no-key)')
  process.exit(1)
}

const ds = await svc.deepseekBalance({})
assertEnvelope('deepseekBalance', ds)
console.log('deepseek-balance ok:', ds.status === 'no-key')
if (ds.status !== 'no-key' || ds.isAvailable !== false || !Array.isArray(ds.balances)) {
  console.error('FAIL: unexpected deepseek-balance response (expected no-key)')
  process.exit(1)
}
const ds2 = await svc.deepseekBalance({ intervalMinutes: 3 })
if (ds2.status !== 'no-key') {
  console.error('FAIL: unexpected deepseek-balance response with intervalMinutes (expected no-key)')
  process.exit(1)
}
const ds3 = await svc.deepseekBalance({ intervalMinutes: 3, force: true })
if (ds3.status !== 'no-key') {
  console.error('FAIL: unexpected deepseek-balance response with force (expected no-key)')
  process.exit(1)
}

const zai = await svc.zaiQuota({})
assertEnvelope('zaiQuota', zai)
console.log('zai-quota ok:', zai.status === 'no-key')
if (zai.status !== 'no-key') {
  console.error('FAIL: unexpected zai-quota response (expected no-key)')
  process.exit(1)
}

// seal：手动物化预统计，密封边界与事件数一致
const sealed = svc.seal()
assertEnvelope('seal', sealed)
console.log('seal ok:', sealed.sealed === true, '| sealedUntil:', sealed.sealedUntil)
if (sealed.sealed !== true || sealed.foldedEvents !== EXPECTED_FOLDED) {
  console.error('FAIL: unexpected seal response')
  process.exit(1)
}

// 重启恢复路径：重开同一 sqlite 文件、会话清单返回空 → 账本有事件 →
// 直接从介质重建聚合缓存（不重扫日志）
const emptyQuery = { async listSessions() { return [] }, async readSession() { return { events: [] } } }
const emptyPersist = { async list() { return [] }, async readFrom() { return { events: [] } }, supportsRawArtifacts: true, async readRaw() { return undefined } }
const reopened = await mount(emptyQuery, emptyPersist)
// 重开介质后同样轮询等待从预统计重建完成（替代固定 sleep，慢机稳健）
const snap4 = await (async () => {
  const deadline = Date.now() + 10_000
  for (;;) {
    const s = reopened.svc.snapshot({ sessionId: null })
    if (s.foldedEvents > 0) return s
    if (Date.now() > deadline) throw new Error('等待重开介质重建超时')
    await new Promise((r) => setTimeout(r, 200))
  }
})()
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
await reopened.dispose()

// clear：清空账本不重扫，统计归零（放最后，避免影响前面的介质恢复断言）
const cleared = await svc.clear()
assertEnvelope('clear', cleared)
const snap5 = svc.snapshot({ sessionId: null })
console.log('after clear:', JSON.stringify({ foldedEvents: snap5.foldedEvents, calls: snap5.all.calls }))
if (cleared.cleared !== true || snap5.all.calls !== 0 || snap5.foldedEvents !== 0) {
  console.error('FAIL: clear 后统计未归零')
  process.exit(1)
}

await mounted.dispose()
// 清理临时 DSH_HOME
rmSync(tmpHome, { recursive: true, force: true })
console.log('SMOKE TEST PASSED')
