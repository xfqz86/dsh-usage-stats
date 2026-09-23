/**
 * 用量统计服务端 Remote 方法的独立冒烟测试（账本模式，自管理 sqlite 介质）。
 *
 * 以真实 cordis Context 挂载 UsageStatsService（存储不 mock：账本直接写
 * node:sqlite 文件），直接调用 7 个 @Remote 方法，验证：
 *   - 首启初始化：账本 sqlite 文件落盘（$DSH_HOME/storages/
 *     dsh-usage-stats/ledger.sqlite），快照从聚合缓存读出；
 *   - 绝对基线：快照 foldedEvents 锚定 fixture 的 394 条可折叠
 *     事件，初始扫描 / 实时去重 / rebuild / 重开介质四处一致；
 *   - 方法与手写严格贡献相容：真实出入值过 zod 信封，错误码透传不断解析；
 *     SRC 线路字段（产物方法源码参数名）与贡献 wire 名逐个对齐——生产构建压缩
 *     方法签名会让新版网关拒收全部带参请求，此处立即失败；
 *   - rebuild 并发返回 usageStats/busy，clear/seal 语义正确；
 *   - 三路额度在凭据中心缺席时确定性 no-key，不产生任何真实外网请求；
 *   - 重启恢复：重开同一 sqlite 文件、会话清单返回空，仍能从介质重建统计
 *     （不依赖重扫日志）；
 *   - 旧代次会话兼容：harness 两路以 SessionFormatUnsupportedError 拒绝时，raw 兜底
 *     自读磁盘最高代次原始日志（多帧 zstd / 未压缩明文）把用量折入账本，只折最高代次；
 *   - 清零墓碑回归（独立 DSH_HOME）：清零后重启保持归零且不再扫描，重建恢复 394
 *     后墓碑清除，再重启统计仍在；
 *   - fork 继承前缀回归（独立 DSH_HOME）：query 与 raw 两路都只折自有事件；
 *   - 压缩调用计入回归（独立 DSH_HOME）：compaction/summary 的用量计入总量与模型
 *     拆分，缺 usage/零用量不入账，实时路径同样接纳；
 *   - 偏好设置条目接入与落盘（独立 DSH_HOME，真实 app-boot Loader + 真实
 *     ConfigEditor/SettingsForms）：条目把 usage-stats schema 作为 Config 声明后，
 *     describe 列出该命名空间且解析值为默认值、schema 可 JSON 序列化；浏览器端
 *     走的 settings.mutate 路径只把显式改过的字段写进 profile 补丁文档，其余字段
 *     继续跟随默认值，规则表整表落成 YAML 列表并原样读回；
 *   - 旧设置文档迁移两路（flow 风格真实片段）：基座自动导入尚存的 settings.yaml；
 *     基座导入失败后的现场（只剩 settings.yaml.imported）由插件回收，两路都只写与
 *     默认值不同的字段、不改段里没有的字段；回收只跑一次——同一 home 再启动两次
 *     （其间清空条目 config）都不得复活旧值；条目已有用户自己的配置时回收让位
 *     （不覆盖用户取值）但同样落标记，此后清空条目也不复活旧值。
 * 信任与认证由网关载体统一处理，本测试只覆盖业务语义。
 *
 * 运行 `node --experimental-strip-types test/smoke.mjs`：lib 内 Remote
 * 服务为构建产物，贡献（zod）直引 src 源码。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { Context, Service as CordisService } from '@deepseek-ai/cordis'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import UsageStatsService from '../lib/index.js'
import { USAGE_STATS_REMOTE } from '../src/remote/contribution.ts'
import { USAGE_SETTINGS_DEFAULTS, USAGE_SETTINGS_NAMESPACE } from '../src/utils.ts'

/**
 * 偏好设置用例用基座真实链路：app-boot 起一个临时 profile（plugin 条目把
 * UsageStatsService 当 Loader 内置插件挂载），并挂真实的 ConfigEditor 与
 * SettingsForms——生产里 dsh-base 就是这个组合，settings 服务把条目 Config
 * 投影成设置表单、把改动写回 profile 补丁文档。
 */

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
// persistence 后端 mock：新基座 open(id,'read')+handle.read(0)+close 形态，
// list 返回含 header 的快照（与 SessionPersistenceSnapshot 同形）。
const sessionPersistence = {
  async list() {
    return [
      { header: { id: SESSION_ID }, revision: 0 },
      { header: { id: OTHER_ID }, revision: 0 },
    ]
  },
  async open(id) {
    return {
      async read() { return { events: id === SESSION_ID ? events : [] } },
      async close() {},
    }
  },
}

/**
 * 挂载服务：等价组合层注入 sessionQuery 等之后，凭据中心缺席覆盖回退路径。
 * 直接构造并手动触发 [Service.init]（生产环境由 Loader 完成这两步）。
 */
async function mount(query, persist, options = {}) {
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

/**
 * SRC 线路字段自检（构建产物 × 手写贡献）：新网关把方法源码文本里的参数名
 * （`Function.prototype.toString`）当作线路字段名，压缩重命名参数即逐次拒收
 * （曾经生产构建把 `snapshot(request)` 压成 `snapshot(e)`，请求被判
 * `gateway/arguments-invalid: unexpected "request"`）。这里用同一读法取产物
 * 原型方法的参数名，与贡献的 wire 名逐方法对齐——本地 `pnpm build`（不压缩）
 * 与 CI 生产构建（压缩策略同发布）都必须在场，产物签名一旦被改写立即失败。
 */
function assertWireFields() {
  for (const descriptor of USAGE_STATS_REMOTE.descriptors) {
    const fn = Object.getOwnPropertyDescriptor(UsageStatsService.prototype, descriptor.method)?.value
    if (typeof fn !== 'function') {
      console.error(`FAIL: 产物缺 Remote 方法 ${descriptor.method}`)
      process.exit(1)
    }
    const source = Function.prototype.toString.call(fn)
    const open = source.indexOf('(')
    const close = source.indexOf(')', open + 1)
    if (open < 0 || close < 0) {
      console.error(`FAIL: ${descriptor.method} 产物源码无参数列表（签名被改写？）：${source.slice(0, 80)}`)
      process.exit(1)
    }
    const body = source.slice(open + 1, close).trim()
    const names = body === '' ? [] : body.split(',').map((part) => part.trim())
    const wires = descriptor.parameters.map((parameter) => parameter.wire)
    if (names.length !== wires.length || names.some((name, i) => name !== wires[i])) {
      console.error(
        `FAIL: ${descriptor.method} 产物参数名 [${names.join(', ')}] 与贡献线路字段 [${wires.join(', ')}] 不一致`
        + '（构建压缩了方法签名？见 tsdown.config.ts 服务端 minify）',
      )
      process.exit(1)
    }
  }
}

/** 真实结果过 zod 成功信封：方法实现与手写 codec 相容。 */
function assertEnvelope(method, value) {
  const parsed = descriptorOf(method).result
  if (parsed.mode !== 'strict') {
    console.error(`FAIL: ${method} 结果无严格 codec`)
    process.exit(1)
  }
  // 双形态同源：create 物化即 schema 本体（供 checkout 新版），旧版读 schema 字段。
  if (parsed.create() !== parsed.schema) {
    console.error(`FAIL: ${method} 的 create/schema 不同源`)
    process.exit(1)
  }
  parsed.schema.parse({ ok: true, value })
}

// 产物方法源码参数名 = 手写贡献的线路字段（SRC 分发前提）
assertWireFields()

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
// 主场景的 DSH_HOME 下没有 sessions 目录，磁盘发现为空 → raw 兜底不触发，
// rawSessions 应为 0（raw 兜底本身的回归用例见文件末尾的旧代次会话用例）。
if (snap.rawSessions !== 0) {
  console.error(`FAIL: rawSessions=${String(snap.rawSessions)}，主场景无磁盘会话文件，应恒为 0`)
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
  rawSessions: snap.rawSessions,       // raw 兜底命中的会话数（主场景无磁盘文件，恒为 0）
  harnessSessions: snap.harnessSessions, // harness 路径命中的会话数（query.readSession / persistence.open+read）
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
const emptyPersist = {
  async list() { return [] },
  async open() { throw new Error('not found') },
}
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

// ===== 旧代次会话的 raw 兜底回归用例（独立 DSH_HOME，不触碰上面的 394 基线）=====
// 等价真实场景：同一会话目录里同时存在 v0 与 v2 两份日志（低代次是高代次的迁移
// 前缀，两份都折会重复计数），harness 两路读取都以 SessionFormatUnsupportedError
// 拒绝；另有一个只在磁盘、未进 harness 清单的明文会话，验证 id 全集 = 磁盘 ∪ 清单。
// 断言：用量经 raw 兜底折入账本、rawSessions 自增、harnessSessions 为 0，且只折最高代次。
{
  const legacyHome = mkdtempSync(join(tmpdir(), 'usage-stats-smoke-legacy-'))
  const LEGACY_ID = 'session-1f4d0a3e-5c7b-4a1d-9f3e-2b6c8d0e4a71'
  const DISK_ONLY_ID = 'session-7c2b9d10-3f5a-4c8e-9b1d-6a2e5f8c4310'
  const LEGACY_CWD = '/Users/example/legacy-workspace'
  const LEGACY_CREATED_AT = 1785000000000
  const workspaceDir = join(legacyHome, 'sessions', '--Users-example-legacy-workspace--')

  /** 记录数组 → append-only 的多帧 zstd 拼接（每行一帧，与 harness 落盘写法一致）。 */
  const zstdFrames = (records) =>
    Buffer.concat(records.map((r) => zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`, 'utf8'))))
  const seed = (version, id) => ({
    type: 'session', version, id, createdAt: LEGACY_CREATED_AT, cwd: LEGACY_CWD, isSeeded: true, delegationDepth: 0,
  })
  const usageOf = (seq, time, u) => ({
    type: 'assistant/message',
    seq,
    time,
    data: { usage: u, message: { source: { provider: 'opencode-go', model: 'deepseek-v4-flash' } } },
  })

  // LEGACY_ID：v0（1205 token，低代次、必须被忽略）+ v2（6300 token，最高代次、命中）
  const legacyDir = join(workspaceDir, LEGACY_ID)
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'session.jsonl.zstd'), zstdFrames([
    seed(0, LEGACY_ID),
    usageOf(1, LEGACY_CREATED_AT + 1000, { inputTokens: 1100, outputTokens: 100, cacheReadTokens: 5 }),
  ]))
  writeFileSync(join(legacyDir, 'session.v2.jsonl.zstd'), zstdFrames([
    seed(2, LEGACY_ID),
    usageOf(1, LEGACY_CREATED_AT + 1000, { inputTokens: 2000, outputTokens: 100 }),
    usageOf(2, LEGACY_CREATED_AT + 2000, { inputTokens: 4000, outputTokens: 200 }),
  ]))
  // 非规范名（session.lock）：代次解析 -1，必须被忽略，不得当成会话日志读入
  writeFileSync(join(legacyDir, 'session.lock'), Buffer.from('not a session log'))

  // DISK_ONLY_ID：未压缩明文 v0，且不在 harness 清单里，只能靠磁盘发现 + raw 兜底统计
  const diskOnlyDir = join(workspaceDir, DISK_ONLY_ID)
  mkdirSync(diskOnlyDir, { recursive: true })
  writeFileSync(join(diskOnlyDir, 'session.jsonl'), [
    JSON.stringify(seed(0, DISK_ONLY_ID)),
    JSON.stringify(usageOf(1, LEGACY_CREATED_AT + 3000, { inputTokens: 500, outputTokens: 50 })),
    '',
  ].join('\n'))

  /** harness 的真实拒绝形态：旧代次日志不被当前构建解释。 */
  const refusal = (id) => new SessionFormatUnsupportedError(
    `session "${id}" uses log format v0, older than the supported v3, and this build ships no upgrade path for it`,
  )
  const legacyQuery = {
    async listSessions() { return [{ header: { id: LEGACY_ID, createdAt: LEGACY_CREATED_AT, cwd: LEGACY_CWD } }] },
    async readSession(id) { throw refusal(id) },
  }
  const legacyPersist = {
    async list() { return [{ header: { id: LEGACY_ID }, revision: 0 }] },
    async open(id) { throw refusal(id) },
  }

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = legacyHome
  const legacyMounted = await mount(legacyQuery, legacyPersist)
  const snapLegacy = await (async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const s = legacyMounted.svc.snapshot({ sessionId: null })
      assertEnvelope('snapshot', s)
      if (s.foldedEvents > 0) return s
      if (Date.now() > deadline) throw new Error('等待旧代次会话 raw 兜底折叠超时')
      await new Promise((r) => setTimeout(r, 200))
    }
  })()
  const byId = new Map(snapLegacy.sessionsList.map((s) => [s.id, s]))
  const legacy = byId.get(LEGACY_ID)
  const diskOnly = byId.get(DISK_ONLY_ID)
  console.log('legacy raw fallback:', JSON.stringify({
    foldedEvents: snapLegacy.foldedEvents,
    rawSessions: snapLegacy.rawSessions,
    harnessSessions: snapLegacy.harnessSessions,
    sessions: snapLegacy.sessionsList.map((s) => ({ id: s.id, calls: s.calls, total: s.usage.total, cwd: s.cwd })),
  }, null, 2))
  // 三处用量：v2 的 6300 + 明文会话的 550；v0 的 1205 不得计入
  if (snapLegacy.foldedEvents !== 3 || snapLegacy.all.calls !== 3 || snapLegacy.all.usage.total !== 6850) {
    console.error(`FAIL: raw 兜底折叠数/用量不符：foldedEvents=${String(snapLegacy.foldedEvents)} calls=${String(snapLegacy.all.calls)} total=${String(snapLegacy.all.usage.total)}，应为 3 / 3 / 6850`)
    process.exit(1)
  }
  if (snapLegacy.rawSessions !== 2 || snapLegacy.harnessSessions !== 0) {
    console.error(`FAIL: rawSessions=${String(snapLegacy.rawSessions)} harnessSessions=${String(snapLegacy.harnessSessions)}，应为 2 / 0`)
    process.exit(1)
  }
  if (!legacy || legacy.calls !== 2 || legacy.usage.total !== 6300 || legacy.cwd !== LEGACY_CWD) {
    console.error(`FAIL: 旧会话未按最高代次折叠（应只折 v2 的 2 条 / 6300 token）：${JSON.stringify(legacy)}`)
    process.exit(1)
  }
  if (!diskOnly || diskOnly.calls !== 1 || diskOnly.usage.total !== 550) {
    console.error(`FAIL: 仅磁盘存在的明文会话未折入：${JSON.stringify(diskOnly)}`)
    process.exit(1)
  }
  await legacyMounted.dispose()
  process.env.DSH_HOME = previousHome
  rmSync(legacyHome, { recursive: true, force: true })
}

// ===== 清零墓碑回归用例（独立 DSH_HOME，不触碰上面的 394 基线）=====
// 等价真实场景：设置页清零（账本 9 表全空）→ 重启 dsh。若空库直接落进 bootstrap
// 首启分支，会全量重扫磁盘日志、把刚清掉的历史统计原样带回来，与「清零不会重新
// 读取历史会话」的文案矛盾。断言：清零落墓碑后重启保持归零且扫描从未发生
// （scans/lastScanAt 均为 0）；「重建」清墓碑并重扫恢复历史，再次重启数据仍在。
{
  const tombHome = mkdtempSync(join(tmpdir(), 'usage-stats-smoke-tomb-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = tombHome

  // 第一次进程：首启扫描折满 394 → 清零归零并落墓碑
  const first = await mount(sessionQuery, sessionPersistence)
  {
    const deadline = Date.now() + 10_000
    for (;;) {
      const s = first.svc.snapshot({ sessionId: null })
      assertEnvelope('snapshot', s)
      // scanning 为假且 lastScanAt 已落：扫描 finally 收尾（物化聚合）已完成，
      // 否则紧随其后的 clear 会撞上 running=true 被 usageStats/busy 拒绝。
      if (s.foldedEvents === EXPECTED_FOLDED && s.scanning === false && s.lastScanAt > 0) break
      if (Date.now() > deadline) throw new Error('等待清零前首启扫描折叠超时')
      await new Promise((r) => setTimeout(r, 200))
    }
    // 留出 finally 尾部余量，再清零。
    await new Promise((r) => setTimeout(r, 300))
  }
  const cleared = await first.svc.clear()
  assertEnvelope('clear', cleared)
  if (cleared.foldedEvents !== 0) {
    console.error(`FAIL: 清零后 foldedEvents=${String(cleared.foldedEvents)}，应为 0`)
    process.exit(1)
  }
  await first.dispose()

  // 第二次进程 = 重启：空库 + 墓碑 → 跳过首启扫描，统计保持归零。
  // bootstrap 异步启动：轮询 2s 作为回归哨兵，若墓碑失效这里会折满 394 而被抓包。
  const second = await mount(sessionQuery, sessionPersistence)
  {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const s = second.svc.snapshot({ sessionId: null })
      assertEnvelope('snapshot', s)
      if (s.foldedEvents !== 0 || s.scans !== 0) {
        console.error(`FAIL: 清零后重启历史复活：foldedEvents=${String(s.foldedEvents)} scans=${String(s.scans)}，应保持归零且未扫描`)
        process.exit(1)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    const settled = second.svc.snapshot({ sessionId: null })
    assertEnvelope('snapshot', settled)
    if (settled.foldedEvents !== 0 || settled.scans !== 0 || settled.lastScanAt !== 0) {
      console.error(`FAIL: 清零墓碑未生效：foldedEvents=${String(settled.foldedEvents)} scans=${String(settled.scans)} lastScanAt=${String(settled.lastScanAt)}，应全为 0`)
      process.exit(1)
    }
    console.log('clear tombstone restart:', JSON.stringify({ foldedEvents: settled.foldedEvents, scans: settled.scans }))
  }

  // 同进程重建：清墓碑 + 全量重扫 → 历史统计恢复
  const rebuilt = await second.svc.rebuild()
  assertEnvelope('rebuild', rebuilt)
  if (rebuilt.foldedEvents !== EXPECTED_FOLDED) {
    console.error(`FAIL: 重建后 foldedEvents=${String(rebuilt.foldedEvents)}，应为 ${String(EXPECTED_FOLDED)}`)
    process.exit(1)
  }
  await second.dispose()

  // 第三次进程 = 再次重启：重建后走预统计/事件重放，数据仍在且不再归零
  const third = await mount(sessionQuery, sessionPersistence)
  {
    const deadline = Date.now() + 10_000
    for (;;) {
      const s = third.svc.snapshot({ sessionId: null })
      assertEnvelope('snapshot', s)
      if (s.foldedEvents === EXPECTED_FOLDED) break
      if (Date.now() > deadline) throw new Error('等待重建后重启恢复折叠超时')
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  await third.dispose()
  console.log('clear tombstone rebuild-recover:', JSON.stringify({ foldedEvents: EXPECTED_FOLDED }))

  process.env.DSH_HOME = previousHome
  rmSync(tombHome, { recursive: true, force: true })
}

// ===== fork 继承前缀回归用例（独立 DSH_HOME，不触碰上面的 394 基线与旧代次用例）=====
// 等价真实场景：子会话日志的物理前缀是从父会话复制来的历史事件（`session/end-seed`
// 带 `inherited: true` 标记分界），harness 读取会连前缀一起返回。若整份日志折叠，
// 父会话的用量会在子会话名下再算一遍，总量虚高。断言只折自有部分：
//   query 路径按 snapshot.inheritedEventCount 过滤；raw 兜底按 inherited 标记过滤。
{
  const forkHome = mkdtempSync(join(tmpdir(), 'usage-stats-smoke-fork-'))
  const PARENT_ID = 'session-9b1f2c3d-4e5a-4b6c-8d7e-1f2a3b4c5d6e'
  const CHILD_QUERY_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  const CHILD_RAW_ID = 'session-b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
  const FORK_CWD = '/Users/example/fork-workspace'
  const FORK_CREATED_AT = 1785200000000
  const forkWorkspace = join(forkHome, 'sessions', '--Users-example-fork-workspace--')

  const zstdFrames = (records) =>
    Buffer.concat(records.map((r) => zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`, 'utf8'))))
  const forkHeader = (id, parent) => ({
    type: 'session',
    version: 2,
    id,
    createdAt: FORK_CREATED_AT,
    cwd: FORK_CWD,
    isSeeded: Boolean(parent),
    delegationDepth: parent ? 1 : 0,
    ...(parent ? { parentSession: parent } : {}),
  })
  const forkUsage = (seq, input) => ({
    type: 'assistant/message',
    seq,
    time: FORK_CREATED_AT + (seq + 1) * 1000,
    data: { usage: { inputTokens: input }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4-flash' } } },
  })
  const endSeed = (seq) => ({ type: 'session/end-seed', seq, time: FORK_CREATED_AT + seq * 1000 + 1, data: { inherited: true } })

  // 父会话：3 条自有用量，共 1500 token
  const parentEvents = [forkHeader(PARENT_ID, null), forkUsage(0, 500), forkUsage(1, 500), forkUsage(2, 500)]
  // 子会话（query 路径）：继承父的 3 条（1500 token）+ 标记 + 自有 1 条（100 token）
  const childQueryEvents = [
    forkHeader(CHILD_QUERY_ID, PARENT_ID),
    forkUsage(0, 500), forkUsage(1, 500), forkUsage(2, 500),
    endSeed(3),
    forkUsage(4, 100),
  ]
  // 子会话（raw 路径）：harness 两路拒绝，磁盘 v2 日志含继承前缀 2 条（2000 token）+ 自有 1 条（300 token）
  const childRawDir = join(forkWorkspace, CHILD_RAW_ID)
  mkdirSync(childRawDir, { recursive: true })
  writeFileSync(join(childRawDir, 'session.v2.jsonl.zstd'), zstdFrames([
    forkHeader(CHILD_RAW_ID, PARENT_ID),
    forkUsage(0, 1000), forkUsage(1, 1000),
    endSeed(2),
    forkUsage(3, 300),
  ]))

  const forkRefusal = (id) => new SessionFormatUnsupportedError(
    `session "${id}" uses log format v2, older than the supported v3, and this build ships no upgrade path for it`,
  )
  const forkQuery = {
    async listSessions() {
      return [
        { header: { id: PARENT_ID, createdAt: FORK_CREATED_AT, cwd: FORK_CWD } },
        { header: { id: CHILD_QUERY_ID, createdAt: FORK_CREATED_AT, cwd: FORK_CWD, parentSession: PARENT_ID, delegationDepth: 1 } },
        { header: { id: CHILD_RAW_ID, createdAt: FORK_CREATED_AT, cwd: FORK_CWD, parentSession: PARENT_ID, delegationDepth: 1 } },
      ]
    },
    async readSession(id) {
      if (id === PARENT_ID) return { events: parentEvents, inheritedEventCount: 0 }
      if (id === CHILD_QUERY_ID) return { events: childQueryEvents, inheritedEventCount: 4 }
      throw forkRefusal(id)
    },
  }
  const forkPersist = {
    async list() {
      return [
        { header: { id: PARENT_ID }, revision: 0 },
        { header: { id: CHILD_QUERY_ID }, revision: 0 },
        { header: { id: CHILD_RAW_ID }, revision: 0 },
      ]
    },
    async open(id) { throw forkRefusal(id) },
  }

  const previousForkHome = process.env.DSH_HOME
  process.env.DSH_HOME = forkHome
  const forkMounted = await mount(forkQuery, forkPersist)
  const snapFork = await (async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const s = forkMounted.svc.snapshot({ sessionId: null })
      assertEnvelope('snapshot', s)
      if (s.foldedEvents >= 5) return s
      if (Date.now() > deadline) throw new Error('等待 fork 继承前缀用例折叠超时')
      await new Promise((r) => setTimeout(r, 200))
    }
  })()
  const forkById = new Map(snapFork.sessionsList.map((s) => [s.id, s]))
  const forkChildQuery = forkById.get(CHILD_QUERY_ID)
  const forkChildRaw = forkById.get(CHILD_RAW_ID)
  console.log('fork inherited prefix:', JSON.stringify({
    foldedEvents: snapFork.foldedEvents,
    all: snapFork.all.usage.total,
    sessions: snapFork.sessionsList.map((s) => ({ id: s.id, calls: s.calls, total: s.usage.total })),
  }, null, 2))
  // 父 3 条（1500）+ 子 query 自有 1 条（100）+ 子 raw 自有 1 条（300）；继承段一律不计
  if (snapFork.foldedEvents !== 5 || snapFork.all.calls !== 5 || snapFork.all.usage.total !== 1900) {
    console.error(`FAIL: fork 继承前缀被重复计入：foldedEvents=${String(snapFork.foldedEvents)} calls=${String(snapFork.all.calls)} total=${String(snapFork.all.usage.total)}，应为 5 / 5 / 1900`)
    process.exit(1)
  }
  if (!forkChildQuery || forkChildQuery.calls !== 1 || forkChildQuery.usage.total !== 100) {
    console.error(`FAIL: query 路径子会话未按 inheritedEventCount 过滤继承前缀：${JSON.stringify(forkChildQuery)}`)
    process.exit(1)
  }
  if (!forkChildRaw || forkChildRaw.calls !== 1 || forkChildRaw.usage.total !== 300) {
    console.error(`FAIL: raw 兜底路径子会话未按 inherited 标记过滤继承前缀：${JSON.stringify(forkChildRaw)}`)
    process.exit(1)
  }
  await forkMounted.dispose()
  process.env.DSH_HOME = previousForkHome
  rmSync(forkHome, { recursive: true, force: true })
}

// ===== 压缩调用计入用例（独立 DSH_HOME，不触碰上面的 394 基线与其他用例）=====
// 上下文压缩会发起一次独立 summarize 调用，用量落在 `compaction/summary` 的
// data.usage，模型身份在 data.provider/data.model（该调用不经 agent loop，
// 不与 assistant/message 重复）。断言它计入总量与模型拆分，而缺 usage、
// 零用量的压缩事件不入账；实时路径同样接纳。
{
  const compactHome = mkdtempSync(join(tmpdir(), 'usage-stats-smoke-compact-'))
  const COMPACT_ID = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f'
  const COMPACT_CWD = '/Users/example/compact-workspace'
  const COMPACT_AT = 1785300000000
  const COMPACT_PROVIDER = 'zai-coding-cn'
  const COMPACT_MODEL = 'glm-5.3-flash'

  const compactMessage = (seq, input) => ({
    type: 'assistant/message',
    seq,
    time: COMPACT_AT + (seq + 1) * 1000,
    data: { usage: { inputTokens: input }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4-flash' } } },
  })
  const compactSummary = (seq, usage) => ({
    type: 'compaction/summary',
    seq,
    time: COMPACT_AT + (seq + 1) * 1000,
    data: {
      compactionId: `compaction-${seq}`,
      summary: [],
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [],
      shadowedTokenCount: 0,
      provider: COMPACT_PROVIDER,
      model: COMPACT_MODEL,
      ...(usage === undefined ? {} : { usage }),
    },
  })
  const compactEvents = [
    { type: 'session', version: 3, id: COMPACT_ID, createdAt: COMPACT_AT, cwd: COMPACT_CWD },
    compactMessage(0, 1000),
    // 压缩调用：200 + 50 + 3000 = 3250
    compactSummary(1, { inputTokens: 200, outputTokens: 50, cacheReadTokens: 3000 }),
    // 后端未上报 usage：不计
    compactSummary(2, undefined),
    // 零用量：不入账本
    compactSummary(3, { inputTokens: 0, outputTokens: 0 }),
    compactMessage(4, 700),
  ]
  const compactQuery = {
    async listSessions() {
      return [{ header: { id: COMPACT_ID, createdAt: COMPACT_AT, cwd: COMPACT_CWD } }]
    },
    async readSession(id) {
      if (id !== COMPACT_ID) throw new Error(`压缩用例收到意外会话 ${id}`)
      return { events: compactEvents, inheritedEventCount: 0 }
    },
  }
  const compactPersist = {
    async list() { return [{ header: { id: COMPACT_ID }, revision: 0 }] },
    async open(id) { throw new Error(`压缩用例不应走持久化路径：${id}`) },
  }

  const previousCompactHome = process.env.DSH_HOME
  process.env.DSH_HOME = compactHome
  const compactMounted = await mount(compactQuery, compactPersist)
  const snapCompact = await (async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const s = compactMounted.svc.snapshot({ sessionId: null })
      assertEnvelope('snapshot', s)
      if (s.foldedEvents >= 3) return s
      if (Date.now() > deadline) throw new Error('等待压缩调用用例折叠超时')
      await new Promise((r) => setTimeout(r, 200))
    }
  })()
  const compactModel = snapCompact.models.find((m) => m.provider === COMPACT_PROVIDER && m.model === COMPACT_MODEL)
  console.log('compaction usage:', JSON.stringify({
    foldedEvents: snapCompact.foldedEvents,
    all: snapCompact.all.usage.total,
    models: snapCompact.models.map((m) => ({ key: `${m.provider}/${m.model}`, calls: m.calls, total: m.usage.total })),
  }, null, 2))
  // 1000 + 3250（压缩调用）+ 700 = 4950，三条计量事件
  if (snapCompact.foldedEvents !== 3 || snapCompact.all.calls !== 3 || snapCompact.all.usage.total !== 4950) {
    console.error(`FAIL: 压缩调用未按口径入账：foldedEvents=${String(snapCompact.foldedEvents)} calls=${String(snapCompact.all.calls)} total=${String(snapCompact.all.usage.total)}，应为 3 / 3 / 4950`)
    process.exit(1)
  }
  if (!compactModel || compactModel.calls !== 1 || compactModel.usage.total !== 3250) {
    console.error(`FAIL: 压缩调用未计入模型拆分：${JSON.stringify(compactModel)}`)
    process.exit(1)
  }
  // 实时路径：同一条 foldRecord 接纳压缩事件
  compactMounted.svc.ctx.emit('session/event', { id: COMPACT_ID }, compactSummary(5, { inputTokens: 500 }))
  const snapCompactLive = compactMounted.svc.snapshot({ sessionId: null })
  const compactModelLive = snapCompactLive.models.find((m) => m.provider === COMPACT_PROVIDER && m.model === COMPACT_MODEL)
  if (snapCompactLive.foldedEvents !== 4 || snapCompactLive.all.usage.total !== 5450 || compactModelLive?.usage.total !== 3750) {
    console.error(`FAIL: 实时压缩调用未入账：foldedEvents=${String(snapCompactLive.foldedEvents)} total=${String(snapCompactLive.all.usage.total)} model=${JSON.stringify(compactModelLive)}，应为 4 / 5450 / 3750`)
    process.exit(1)
  }
  await compactMounted.dispose()
  process.env.DSH_HOME = previousCompactHome
  rmSync(compactHome, { recursive: true, force: true })
}

// ===== 偏好设置：条目接入、落盘与旧设置文档迁移（独立 DSH_HOME，不触碰上面的 394 基线）=====
// 偏好设置不再存 localStorage、也不再注册独立命名空间：条目自己声明 Config
// schema（src/host/settings.ts 的 UsageSettingsSchema），harness 设置服务把它
// 投影成设置表单，浏览器端经 ctx.configForms 按条目 id 读写，改动落到 profile
// 补丁文档。
// 四个用例都走真实链路（app-boot Loader + ConfigEditor + SettingsForms）。

/** 旧版设置文档里的 `usage-stats` 段：从本机真实 settings.yaml.imported 裁剪而来（flow 风格、未加引号），回收必须能吃下这种写法。 */
const LEGACY_SETTINGS_DOC = `usage-stats:
  {
    showZaiInSidebar: true,
    zaiEnabled: false,
    modelRedirects:
      [
        {
            fromProvider: opencode-go-completions,
            fromModel: ox-alpha-free,
            toProvider: opencode-go,
            toModel: glm-5.3-flash
          }
      ],
    goEnabled: true,
    deepseekEnabled: true
  }
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
`
/** 上游文档里的那条规则（整表落盘后读回断言用）。 */
const LEGACY_REDIRECTS = [{ fromProvider: 'opencode-go-completions', fromModel: 'ox-alpha-free', toProvider: 'opencode-go', toModel: 'glm-5.3-flash' }]

/**
 * 起一个临时 profile：真实 Loader + ConfigEditor + SettingsForms，插件条目按内置插件挂载
 * （等价 dsh-base 组合里由 bundle 补丁插入的那一行）。
 * @param options.legacy - 'pending' 预置 $DSH_HOME/settings.yaml（基座待导入）；
 *   'imported' 预置 $DSH_HOME/settings.yaml.imported 且不预置 settings.yaml（基座导入失败后的现场）。
 * @param options.userPatch - 预置用户层补丁文档文本（模拟条目里已有用户自己配置的现场）。
 * @returns ctx、目录与取值读取器。
 */
async function mountSettingsProfile(options = {}) {
  // options.home 复用同一份 home（同一台机器多次启动），否则每次新建临时 home。
  const home = options.home ?? realpathSync(mkdtempSync(join(tmpdir(), 'usage-stats-smoke-settings-')))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  if (options.legacy === 'pending') writeFileSync(join(home, 'settings.yaml'), LEGACY_SETTINGS_DOC)
  if (options.legacy === 'imported') writeFileSync(join(home, 'settings.yaml.imported'), LEGACY_SETTINGS_DOC)
  // 临时 profile：profile 目录 + 一个 bundle（补丁插入三个条目）+ 空 cordis.yml。
  const profileDir = join(home, 'profiles', 'test')
  initProfile(profileDir, ['test-bundle'])
  if (options.userPatch !== undefined) writeFileSync(join(profileDir, 'cordis.patch.yml'), options.userPatch)
  const bundleDir = join(profileDir, 'node_modules', 'test-bundle')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  // 条目 id 用 USAGE_SETTINGS_NAMESPACE：浏览器端按同一常量取表单，两侧漂移即失败。
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: USAGE_SETTINGS_NAMESPACE, name: 'cordis:usage-stats' },
  ] }]))
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  const profile = {
    name: 'test', startedBundles: ['test-bundle'], dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home,
    overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(profileDir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
    root.provide('profileContext', profile)
    root.provide('appReady', { onReady: (listener) => { listener(); return () => {} } })
    // 组合层注入的两个必需服务：本用例只关心偏好设置链路，会话侧给空实现。
    root.provide('sessionQuery', { async listSessions() { return [] }, async readSession() { return { events: [] } } })
    root.provide('sessionPersistence', { async list() { return [] }, async open() { throw new Error('偏好设置用例不应走持久化路径') } })
    Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: SettingsForms, 'usage-stats': UsageStatsService })
  })
  const settings = ctx.get('settings')
  if (settings === undefined || !(ctx.get('usageStats') instanceof UsageStatsService)) {
    console.error('FAIL: 设置服务或 usageStats 服务未挂载（条目未按 Config 声明生效？）')
    process.exit(1)
  }
  const dispose = async (disposeOptions = {}) => {
    await ctx.fiber.dispose()
    process.env.DSH_HOME = previousHome
    if (disposeOptions.keepHome !== true) rmSync(home, { recursive: true, force: true })
  }
  return {
    ctx,
    home,
    profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    dispose,
    entry: () => settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === USAGE_SETTINGS_NAMESPACE),
    settings,
  }
}

/** 轮询等待取值稳定：迁移都是 Loader 落定后的异步收尾，不是同步完成。 */
async function waitUntil(check, describeFailure, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) {
      console.error(`FAIL: ${describeFailure}`)
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** 逐字段深比较：数组字段（modelRedirects）不能用引用比较。 */
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- 用例一：条目接入、describe 取值、mutate 落盘 ----
{
  const mounted = await mountSettingsProfile()
  const entry = mounted.entry()
  if (entry === undefined) {
    console.error(`FAIL: describe 未列出 ${USAGE_SETTINGS_NAMESPACE} 条目（条目必须把偏好 schema 声明成 Config）`)
    process.exit(1)
  }
  for (const [field, expected] of Object.entries(USAGE_SETTINGS_DEFAULTS)) {
    if (!sameValue(entry.value[field], expected)) {
      console.error(`FAIL: 默认值不一致 ${field}=${JSON.stringify(entry.value[field])}，应为 ${JSON.stringify(expected)}`)
      process.exit(1)
    }
  }
  if (!Array.isArray(entry.value.modelRedirects) || entry.value.modelRedirects.length !== 0) {
    console.error(`FAIL: 规则表默认值应为空数组，实际 ${JSON.stringify(entry.value.modelRedirects)}`)
    process.exit(1)
  }
  // describe 下发的 schema 必须可 JSON 序列化：浏览器端 ConfigForm 用它校验收到的取值。
  try {
    JSON.parse(JSON.stringify(entry.schema))
  } catch (error) {
    console.error(`FAIL: 条目 schema 不可 JSON 序列化，浏览器端无法校验收到的取值：${String(error)}`)
    process.exit(1)
  }

  // 浏览器端走的 mutate 路径（路径写入）：只落显式改过的字段。
  await mounted.settings.mutate(USAGE_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['goFetchMinutes'], value: 10 },
    { op: 'set', path: ['showZaiInSidebar'], value: false },
  ])
  const patchDocument = readFileSync(mounted.patchPath, 'utf8')
  for (const needle of [`id: ${USAGE_SETTINGS_NAMESPACE}`, 'goFetchMinutes: 10', 'showZaiInSidebar: false']) {
    if (!patchDocument.includes(needle)) {
      console.error(`FAIL: profile 补丁缺少 "${needle}"：\n${patchDocument}`)
      process.exit(1)
    }
  }
  for (const absent of ['deepseekEnabled', 'zaiFetchMinutes', 'goEnabled']) {
    if (patchDocument.includes(absent)) {
      console.error(`FAIL: 补丁只应存显式改过的字段，却出现了 ${absent}：\n${patchDocument}`)
      process.exit(1)
    }
  }
  const expectedAfterWrite = { ...USAGE_SETTINGS_DEFAULTS, goFetchMinutes: 10, showZaiInSidebar: false }
  for (const [field, expected] of Object.entries(expectedAfterWrite)) {
    if (!sameValue(mounted.entry().value[field], expected)) {
      console.error(`FAIL: 写入后解析值不一致 ${field}=${JSON.stringify(mounted.entry().value[field])}，应为 ${JSON.stringify(expected)}`)
      process.exit(1)
    }
  }

  // 模型统计重定向规则表：整表写入后落成 YAML 列表并原样读回（浏览器端读它做归并）。
  const redirects = [
    { fromProvider: 'opencode-go-vision', fromModel: 'deepseek-v4-flash', toProvider: 'opencode-go', toModel: 'deepseek-v4-flash' },
    { fromProvider: 'zai-coding-cn', fromModel: 'glm-5.3-flash', toProvider: 'opencode-go', toModel: 'glm-5.3-flash' },
  ]
  await mounted.settings.mutate(USAGE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['modelRedirects'], value: redirects }])
  const redirectDocument = readFileSync(mounted.patchPath, 'utf8')
  for (const needle of ['modelRedirects:', 'fromProvider: opencode-go-vision', 'toProvider: opencode-go']) {
    if (!redirectDocument.includes(needle)) {
      console.error(`FAIL: profile 补丁缺少规则表字段 "${needle}"：\n${redirectDocument}`)
      process.exit(1)
    }
  }
  if (!sameValue(mounted.entry().value.modelRedirects, redirects)) {
    console.error(`FAIL: 规则表读回不一致：${JSON.stringify(mounted.entry().value.modelRedirects)}，应为 ${JSON.stringify(redirects)}`)
    process.exit(1)
  }
  console.log('settings entry:', JSON.stringify({
    ns: USAGE_SETTINGS_NAMESPACE,
    resolved: mounted.entry().value,
    revision: mounted.entry().revision,
  }, null, 2))
  await mounted.dispose()
}

// ---- 用例二：升级时基座自动导入旧 settings.yaml（前向路径）----
{
  const mounted = await mountSettingsProfile({ legacy: 'pending' })
  await waitUntil(
    () => sameValue(mounted.entry()?.value.zaiEnabled, false) && sameValue(mounted.entry()?.value.modelRedirects, LEGACY_REDIRECTS),
    '基座未把旧 settings.yaml 的 usage-stats 段导入条目（自动配置迁移失效）',
  )
  const patchDocument = readFileSync(mounted.patchPath, 'utf8')
  for (const needle of ['zaiEnabled: false', 'fromModel: ox-alpha-free']) {
    if (!patchDocument.includes(needle)) {
      console.error(`FAIL: 基座导入未落到 profile 补丁（缺 "${needle}"）：\n${patchDocument}`)
      process.exit(1)
    }
  }
  if (existsSync(join(mounted.home, 'settings.yaml'))) {
    console.error('FAIL: 基座导入后旧 settings.yaml 应已改名')
    process.exit(1)
  }
  console.log('legacy import (base):', JSON.stringify({ zaiEnabled: mounted.entry().value.zaiEnabled, modelRedirects: mounted.entry().value.modelRedirects }))
  await mounted.dispose()
}

// ---- 用例三：基座导入失败后的现场（只剩 settings.yaml.imported）由插件回收 ----
{
  const mounted = await mountSettingsProfile({ legacy: 'imported' })
  await waitUntil(
    () => sameValue(mounted.entry()?.value.zaiEnabled, false) && sameValue(mounted.entry()?.value.modelRedirects, LEGACY_REDIRECTS),
    '插件未从 settings.yaml.imported 回收旧偏好（旧版升级后偏好丢失）',
  )
  // 回收只写显式改过的字段：等于默认值的 goEnabled/deepseekEnabled 不落盘。
  const patchDocument = readFileSync(mounted.patchPath, 'utf8')
  for (const needle of ['zaiEnabled: false', 'fromModel: ox-alpha-free']) {
    if (!patchDocument.includes(needle)) {
      console.error(`FAIL: 回收未落到 profile 补丁（缺 "${needle}"）：\n${patchDocument}`)
      process.exit(1)
    }
  }
  for (const absent of ['goEnabled', 'deepseekEnabled']) {
    if (patchDocument.includes(absent)) {
      console.error(`FAIL: 回收只应写与默认值不同的字段，却出现了 ${absent}：\n${patchDocument}`)
      process.exit(1)
    }
  }
  // 归一化口径：段里没有的字段保持默认。
  const value = mounted.entry().value
  for (const field of ['goFetchMinutes', 'showSessionId', 'zaiFetchMinutes']) {
    if (!sameValue(value[field], USAGE_SETTINGS_DEFAULTS[field])) {
      console.error(`FAIL: 回收不该改动段里没有的字段 ${field}=${JSON.stringify(value[field])}`)
      process.exit(1)
    }
  }
  // 回收是在插件存储目录写下的一次性标记：标记在即不再回收。
  const marker = join(mounted.home, 'storages', 'dsh-usage-stats', 'legacy-settings-recovered.json')
  if (!existsSync(marker)) {
    console.error(`FAIL: 回收后未写完成标记 ${marker}`)
    process.exit(1)
  }
  console.log('legacy recovery (plugin):', JSON.stringify({ zaiEnabled: value.zaiEnabled, modelRedirects: value.modelRedirects }))
  // 同一份 home 再启动两次：第二次把条目 config 清空（模拟用户把偏好改回默认、或手改配置文档），
  // 标记仍在，旧值不得复活；第三次再启动确认状态稳定。
  await mounted.dispose({ keepHome: true })
  rmSync(join(mounted.home, 'storages', 'dsh-usage-stats', 'ledger.sqlite'), { force: true })
  const patchPath = mounted.patchPath
  const cleared = readFileSync(patchPath, 'utf8').replace(
    /- id: usage-stats\n(?: {2}[^\n]*\n)*/,
    `- id: usage-stats\n  name: cordis:usage-stats\n`,
  )
  if (cleared.includes('zaiEnabled')) {
    console.error(`FAIL: 用例未能清空条目 config：\n${cleared}`)
    process.exit(1)
  }
  writeFileSync(patchPath, cleared)
  for (const round of [2, 3]) {
    const rebooted = await mountSettingsProfile({ home: mounted.home })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const after = rebooted.entry()
    if (after === undefined || !sameValue(after.value.zaiEnabled, USAGE_SETTINGS_DEFAULTS.zaiEnabled)
      || !sameValue(after.value.modelRedirects, [])) {
      console.error(`FAIL: 第 ${round} 次启动把旧偏好又迁移了一遍（应只回收一次）：${JSON.stringify(after?.value)}`)
      process.exit(1)
    }
    if (readFileSync(patchPath, 'utf8').includes('zaiEnabled')) {
      console.error(`FAIL: 第 ${round} 次启动重新写入了 profile 补丁（应只回收一次）`)
      process.exit(1)
    }
    await rebooted.dispose({ keepHome: round !== 3 })
  }
  console.log('legacy recovery ran exactly once（标记拦住了后续启动）')
}

// ---- 用例四：条目已有用户自己的配置——回收让位，但同样落「已处理」标记 ----
// 现场：升级时偏好已经由用户（或更早那版插件）写进条目 config，旧文档还留在原地。
// 回收必须不覆盖用户取值；同时要落标记，否则用户之后把条目清空时旧值会突然复活。
{
  const userPatch = [
    `- id: ${USAGE_SETTINGS_NAMESPACE}`,
    // name 必须与条目实际加载的模块一致，否则这行 config 到不了运行中的条目（基座按行匹配）。
    '  name: cordis:usage-stats',
    '  config:',
    '    showSessionId: false',
    '',
  ].join('\n')
  const mounted = await mountSettingsProfile({ legacy: 'imported', userPatch })
  const marker = join(mounted.home, 'storages', 'dsh-usage-stats', 'legacy-settings-recovered.json')
  await waitUntil(
    () => existsSync(marker),
    '条目已有用户配置时回收既未覆盖也未落「已处理」标记（旧文档会被反复重看）',
  )
  // 用户自己的取值原样保留；旧文档里的值一律不搬（用户没改过的字段保持默认）。
  const value = mounted.entry().value
  if (!sameValue(value.showSessionId, false)) {
    console.error(`FAIL: 回收覆盖了用户自己的取值 showSessionId=${JSON.stringify(value.showSessionId)}`)
    process.exit(1)
  }
  if (!sameValue(value.zaiEnabled, USAGE_SETTINGS_DEFAULTS.zaiEnabled) || !sameValue(value.modelRedirects, [])) {
    console.error(`FAIL: 条目已有用户配置时不该搬旧文档的值：${JSON.stringify(value)}`)
    process.exit(1)
  }
  const userPatchDocument = readFileSync(mounted.patchPath, 'utf8')
  for (const absent of ['zaiEnabled', 'modelRedirects']) {
    if (userPatchDocument.includes(absent)) {
      console.error(`FAIL: 回收写进了用户已有配置的条目（出现 ${absent}）：\n${userPatchDocument}`)
      process.exit(1)
    }
  }
  const mark = JSON.parse(readFileSync(marker, 'utf8'))
  if (mark.action !== 'skipped-user-config') {
    console.error(`FAIL: 标记未记录让位这一处置结果：${JSON.stringify(mark)}`)
    process.exit(1)
  }
  console.log('legacy recovery skipped (user config):', JSON.stringify({ action: mark.action, showSessionId: value.showSessionId }))
  // 同一份 home 再启动：把条目 config 清空后，标记仍在，旧值不得复活。
  await mounted.dispose({ keepHome: true })
  rmSync(join(mounted.home, 'storages', 'dsh-usage-stats', 'ledger.sqlite'), { force: true })
  const cleared = readFileSync(mounted.patchPath, 'utf8').replace(
    new RegExp(`- id: ${USAGE_SETTINGS_NAMESPACE}\\n(?: {2}[^\\n]*\\n)*`),
    `- id: ${USAGE_SETTINGS_NAMESPACE}\n  name: '@xfqz86/dsh-usage-stats'\n`,
  )
  writeFileSync(mounted.patchPath, cleared)
  const rebooted = await mountSettingsProfile({ home: mounted.home })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const afterSkip = rebooted.entry()
  if (afterSkip === undefined || !sameValue(afterSkip.value.zaiEnabled, USAGE_SETTINGS_DEFAULTS.zaiEnabled)
    || !sameValue(afterSkip.value.modelRedirects, [])) {
    console.error(`FAIL: 让位之后清空条目又复活了旧值（标记未生效）：${JSON.stringify(afterSkip?.value)}`)
    process.exit(1)
  }
  if (readFileSync(mounted.patchPath, 'utf8').includes('zaiEnabled')) {
    console.error('FAIL: 让位之后清空条目又写入了 profile 补丁（标记未生效）')
    process.exit(1)
  }
  await rebooted.dispose()
  console.log('legacy recovery skip is final（清空条目后旧值也没有复活）')
}

// 清理临时 DSH_HOME
rmSync(tmpHome, { recursive: true, force: true })
console.log('SMOKE TEST PASSED')
