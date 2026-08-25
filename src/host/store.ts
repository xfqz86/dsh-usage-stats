/**
 * 内存聚合缓存：由账本事件流折叠而来的派生统计（按天 / 会话 / 模型 / 全量）。
 *
 * 边界：账本（ledger.ts 的 Ledger）持有 sqlite 事件流与会话元数据；本模块
 * 只做折叠与聚合，是快照 API 的读取面。折叠路径：
 *   - 启动/重建：从账本事件全量折叠（scan.ts 的 rebuildFromEvents）；
 *   - 实时：session/event 监听逐条折叠（foldRecord，与账本追加共用）。
 * 账本写入同步落盘（sqlite 自动提交，即写即持久）。
 * 预统计：对不会再变动的历史数据做物化聚合，启动时优先从 agg_* 表加载，
 * 仅少量未密封事件需重放，显著降低冷启动时间；实时路径增量更新预统计。
 * 所有操作以 store 为首参的纯函数或接受 ledger 参数的折叠助手，可独立测试。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Agg, SessionInfo } from './agg.ts'
import { newAgg, ink, usable } from './agg.ts'
import { startOfDay } from '../utils.ts'
import type { Ledger, LedgerEvent } from './ledger.ts'
import { toLedgerEvent } from './ledger.ts'
import { errorMessage } from '../utils.ts'

/** 会话级状态（数值聚合 + 去重水位；title/cwd/createdAt 在账本 meta）。 */
export interface UsageStore {
  sessions: Map<string, SessionInfo>
  models: Map<string, Agg>
  allAgg: Agg
  allDaily: Map<number, Agg>
  /** 账本余额计数：事件总数与去重跳过数。 */
  foldedEvents: number
  dedupSkipped: number
  /** 初始化/重建扫描的导入报告（语义见 scan.ts）。 */
  scanning: boolean
  running: boolean
  scans: number
  failed: number
  rawSessions: number
  harnessSessions: number
  lastError: string | null
  scanError: string | null
  lastScanAt: number
}

/** 新建空聚合缓存。 */
export function createStore(): UsageStore {
  return {
    sessions: new Map(),
    models: new Map(),
    allAgg: newAgg(),
    allDaily: new Map(),
    foldedEvents: 0,
    dedupSkipped: 0,
    scanning: false,
    running: false,
    scans: 0,
    failed: 0,
    rawSessions: 0,
    harnessSessions: 0,
    lastError: null,
    scanError: null,
    lastScanAt: 0,
  }
}

/** 取（或建）某日分桶计数。 */
export function dayAgg(map: Map<number, Agg>, day: number): Agg {
  let a = map.get(day)
  if (!a) { a = newAgg(); map.set(day, a) }
  return a
}

/** 取（或建）会话级状态。 */
export function ensureSession(store: UsageStore, id: string): SessionInfo {
  let info = store.sessions.get(id)
  if (!info) {
    info = { daily: new Map(), allAgg: newAgg(), maxSeq: -1, lastActive: 0 }
    store.sessions.set(id, info)
  }
  return info
}

/** 取（或建）某模型分桶计数（key 为 provider\0model）。 */
export function ensureModel(store: UsageStore, key: string): Agg {
  let agg = store.models.get(key)
  if (!agg) { agg = newAgg(); store.models.set(key, agg) }
  return agg
}

/** 把一次真实用量折进会话日桶 / 会话总桶 / 全量日桶 / 全量总桶。 */
export function foldUsage(store: UsageStore, info: SessionInfo, timeMs: number, u: TokenUsage): void {
  const day = startOfDay(timeMs)
  ink(dayAgg(info.daily, day), u)
  ink(info.allAgg, u)
  ink(dayAgg(store.allDaily, day), u)
  ink(store.allAgg, u)
  if (timeMs > info.lastActive) info.lastActive = timeMs
}

/**
 * 折叠一条账本事件进聚合缓存（幂等前提：账本内事件唯一 —— event 表按
 * session+seq 键 upsert，重开账本时每键只折一次）。返回是否真正折叠
 * （事件无用量时 false）。顺带推进该会话的 maxSeq 水位，使重启恢复后
 * 实时路径同样能去重历史事件。
 * 若提供 ledger，则同步增量更新预统计物化表（挂起时跳过，由批量 persist 覆盖）。
 */
export function foldLedgerEvent(store: UsageStore, ev: LedgerEvent, ledger?: Ledger): boolean {
  if (ev.input + ev.output + ev.cacheRead + ev.cacheWrite + ev.reasoning <= 0) return false
  const usage: TokenUsage = {
    inputTokens: ev.input,
    outputTokens: ev.output,
    cacheReadTokens: ev.cacheRead,
    cacheWriteTokens: ev.cacheWrite,
    reasoningTokens: ev.reasoning,
  }
  const info = ensureSession(store, ev.sessionId)
  if (ev.seq >= 0 && ev.seq > info.maxSeq) info.maxSeq = ev.seq
  foldUsage(store, info, ev.t, usage)
  ink(ensureModel(store, ev.provider + '\u0000' + ev.model), usage)
  store.foldedEvents += 1
  // 同步物化到预统计表（实时路径增量，批量导入时挂起）。失败不抛错、
  // 不打断折叠（内存聚合仍是正确事实），仅记录日志与 lastError 供快照
  // 暴露；预统计缺失部分由下次启动的加载/重放路径自愈。
  if (ledger) {
    try {
      ledger.incrementAgg(ev)
    } catch (e) {
      console.error('[usage-stats] 预统计增量写入失败', e)
      store.lastError = errorMessage(e)
    }
  }
  return true
}

/**
 * 处理一条原始记录（会话种子 / session/title / assistant/message）：
 * 元数据写账本 meta；usable 事件按 per-session seq 水位去重后追加进账本
 * 并折叠进聚合缓存。初始化扫描与实时监听共用此路径，保证账本内事件唯一。
 * 全部同步（sqlite 即写即持久，无需等待落盘）。
 * 预统计增量在此路径自动完成（挂起时跳过）。
 */
export function foldRecord(
  store: UsageStore,
  ledger: Ledger,
  id: string,
  record: SessionEvent | { type: string; cwd?: unknown; createdAt?: unknown; parentSession?: unknown; origin?: unknown; delegationDepth?: unknown; data?: { title?: unknown; usage?: unknown } },
): void {
  if (record.type === 'session') {
    // 会话种子记录：cwd / createdAt / parentSession 等在顶层（SessionHeader 字段）。
    const rec = record as { cwd?: unknown; createdAt?: unknown; parentSession?: unknown; origin?: unknown; delegationDepth?: unknown }
    const createdAt = typeof rec.createdAt === 'number' ? rec.createdAt : undefined
    const parentSession = typeof rec.parentSession === 'string' ? rec.parentSession : undefined
    const origin = typeof rec.origin === 'string' ? rec.origin : undefined
    const delegationDepth = typeof rec.delegationDepth === 'number' && Number.isFinite(rec.delegationDepth) ? rec.delegationDepth : undefined
    ledger.setMeta(id, {
      cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
      createdAt,
      lastActive: createdAt,
      parentSession,
      origin,
      delegationDepth,
    })
    return
  }
  if (record.type === 'session/title') {
    const rec = record as { data?: { title?: unknown } }
    const title = rec.data?.title
    ledger.setMeta(id, { title: typeof title === 'string' ? title : undefined })
    return
  }
  const event = record as SessionEvent
  if (!usable(event)) return
  let ev: LedgerEvent | null
  try {
    ev = toLedgerEvent(id, event)
  } catch {
    // 畸形事件（如缺 message.source）不影响会话其余事件
    return
  }
  if (ev === null) return
  const info = ensureSession(store, id)
  // seq 水位去重：防止初始化扫描与实时监听（或重扫）双记同一事件。
  if (typeof ev.seq === 'number' && ev.seq >= 0 && ev.seq <= info.maxSeq) {
    store.dedupSkipped += 1
    return
  }
  // seq=-1 等未知序事件无法靠水位去重，用主键存在性校验（t+session+seq 幂等）
  if (ev.seq < 0 && ledger.hasEventAt(ev.t, id, ev.seq)) {
    store.dedupSkipped += 1
    return
  }
  const isNew = ledger.append(ev)
  if (!isNew) {
    store.dedupSkipped += 1
    return
  }
  // 同步更新会话元数据的 lastActive（事件时间），保证 session_meta 不为空
  ledger.setMeta(id, { lastActive: ev.t })
  foldLedgerEvent(store, ev, ledger)
}

/** 取会话 meta（缺省用空元数据,避免 snapshot 层判空）。 */
export function metaOf(ledger: Ledger, id: string): { title: string; cwd: string; createdAt: number; lastActive: number; parentSession: string; origin: string; delegationDepth: number } {
  const meta = ledger.getMeta(id)
  return meta ?? { title: '', cwd: '', createdAt: 0, lastActive: 0, parentSession: '', origin: '', delegationDepth: 0 }
}
