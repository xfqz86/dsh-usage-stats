/**
 * 内存聚合存储：UsageStore 结构 + 折叠助手。
 *
 * 所有操作都以 store 为首参的纯函数（不触碰 ctx / I/O），可独立测试。
 * 折叠路径：foldSessionEvents（批量，来自扫描）与 index.ts 的 session/event
 * 监听（单条，实时增量）共用 foldMeta / foldUsage / ensure* 助手。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Agg, SessionInfo } from './agg.ts'
import { newAgg, localMidnight, ink, usable, modelKeyOf } from './agg.ts'
import type { SessionSeedRecord } from './logs.ts'

/** 扫描、实时折叠与快照共享的内存聚合存储。 */
export interface UsageStore {
  sessions: Map<string, SessionInfo>
  models: Map<string, Agg>
  allAgg: Agg
  allDaily: Map<number, Agg>
  scanning: boolean
  running: boolean
  scans: number
  failed: number
  rawSessions: number
  harnessSessions: number
  foldedEvents: number
  dedupSkipped: number
  lastError: string | null
  scanError: string | null
  lastScanAt: number
}

/** 新建空存储。 */
export function createStore(): UsageStore {
  return {
    sessions: new Map(),
    models: new Map(),
    allAgg: newAgg(),
    allDaily: new Map(),
    scanning: false,
    running: false,
    scans: 0,
    failed: 0,
    rawSessions: 0,
    harnessSessions: 0,
    foldedEvents: 0,
    dedupSkipped: 0,
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
    info = { daily: new Map(), allAgg: newAgg(), maxSeq: -1, title: '', cwd: '', createdAt: 0, lastActive: 0 }
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
  const day = localMidnight(timeMs)
  ink(dayAgg(info.daily, day), u)
  ink(info.allAgg, u)
  ink(dayAgg(store.allDaily, day), u)
  ink(store.allAgg, u)
  if (timeMs > info.lastActive) info.lastActive = timeMs
}

/** 应用单条记录的副作用（会话元数据：种子记录 / session/title）。 */
export function foldMeta(store: UsageStore, id: string, record: SessionEvent | SessionSeedRecord): void {
  if (record.type === 'session') {
    // 持久化种子记录：会话头字段在顶层。
    const info = ensureSession(store, id)
    if (typeof record.cwd === 'string' && record.cwd) info.cwd = record.cwd
    if (typeof record.createdAt === 'number' && record.createdAt) info.createdAt = record.createdAt
    if (typeof record.version === 'number') info.lastActive = Math.max(info.lastActive, record.createdAt)
  } else if (record.type === 'session/title') {
    const info = ensureSession(store, id)
    if (record.data && typeof record.data.title === 'string' && record.data.title) info.title = record.data.title
  }
}

/** 批量折叠一批日志记录（扫描用）：元数据 + usage + 模型拆分 + seq 水位去重。 */
export function foldSessionEvents(
  store: UsageStore,
  id: string,
  records: Array<SessionEvent | SessionSeedRecord>,
): void {
  const info = ensureSession(store, id)
  if (!Array.isArray(records)) return
  for (const record of records) {
    foldMeta(store, id, record)
    if (record.type === 'session') continue
    if (!usable(record)) continue
    if (typeof record.seq === 'number' && record.seq <= info.maxSeq) { store.dedupSkipped += 1; continue }
    foldUsage(store, info, record.time, record.data.usage)
    ink(ensureModel(store, modelKeyOf(record)), record.data.usage)
    store.foldedEvents += 1
    if (typeof record.seq === 'number') info.maxSeq = Math.max(info.maxSeq, record.seq)
  }
}