/**
 * 快照构建：把聚合缓存（UsageStore）+ 账本会话元数据整理成
 * /usage-stats/api/snapshot 的响应 value（纯函数，不触碰 HTTP / ctx）。
 * 类型（SeriesPoint / UsageAgg）来自 types.ts；splitModelKey 来自 utils.ts（host 与 client 共用）。
 */
import type { Agg } from './agg.ts'
import type { UsageStore } from './store.ts'
import type { Ledger } from './ledger.ts'
import { metaOf } from './store.ts'
import type { SeriesPoint, UsageAgg } from '../types.ts'
import { splitModelKey } from '../utils.ts'

/** 按日序列点结构定义在 types.ts（与 client 端 SeriesPoint 统一）。 */
export type { SeriesPoint } from '../types.ts'

/** 把某会话/全量的逐日聚合转成按时间升序的序列。 */
export function buildSeries(dailyMap: Map<number, Agg>): SeriesPoint[] {
  const out: SeriesPoint[] = []
  for (const [day, agg] of dailyMap) {
    out.push({
      t: day, input: agg.input, output: agg.output,
      cacheRead: agg.cacheRead, cacheWrite: agg.cacheWrite,
      reasoning: agg.reasoning, calls: agg.calls,
    })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/** 聚合 → 对外 usage 形状（total 由各分量之和得到，已含调用数分离）。 */
export function usageOf(agg: Agg): UsageAgg {
  return {
    input: agg.input, output: agg.output, cacheRead: agg.cacheRead,
    cacheWrite: agg.cacheWrite, reasoning: agg.reasoning, total: agg.total,
  }
}

/** 无用量会话的占位 usage。 */
export const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }

/** 构建快照 value：汇总 + 模型拆分 + 会话明细 + 按日序列；sessionId 可选过滤当前会话。 */
export function snapshot(store: UsageStore, ledger: Ledger, sessionId: string | null, opts?: { limit?: number }): unknown {
  let sessionsWithUsage = 0
  const sessionsList: Array<Record<string, unknown>> = []
  for (const [id, info] of store.sessions) {
    if (info.allAgg.calls > 0) sessionsWithUsage += 1
    const meta = metaOf(ledger, id)
    sessionsList.push({
      id,
      title: meta.title,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      lastActive: Math.max(meta.lastActive, info.lastActive),
      parentSession: meta.parentSession || null,
      origin: meta.origin || null,
      delegationDepth: meta.delegationDepth || 0,
      calls: info.allAgg.calls,
      usage: usageOf(info.allAgg),
    })
  }
  sessionsList.sort((a, b) => (b.lastActive as number) - (a.lastActive as number))
  const sessionsListTotal = sessionsList.length
  // 分页截断：避免上千会话时每 4 秒全量序列化开销；默认 200，可由客户端 limit 显式覆盖
  const rawLimit = opts?.limit
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.floor(rawLimit))) : 200
  const truncatedList = sessionsList.length > limit ? sessionsList.slice(0, limit) : sessionsList

  const models: Array<Record<string, unknown>> = []
  for (const [key, agg] of store.models) {
    const { provider, model } = splitModelKey(key)
    const dailyMap = store.modelDaily.get(key)
    const series = dailyMap ? buildSeries(dailyMap) : []
    models.push({ provider, model, calls: agg.calls, usage: usageOf(agg), series })
  }
  models.sort((a, b) => (b.usage as { total: number }).total - (a.usage as { total: number }).total)

  const allAgg = store.allAgg
  const allSeries = buildSeries(store.allDaily)
  let current: Record<string, unknown> | null = null
  let currentSeries: SeriesPoint[] = []
  if (sessionId) {
    const info = store.sessions.get(sessionId)
    if (info) {
      current = { id: sessionId, calls: info.allAgg.calls, usage: usageOf(info.allAgg) }
      currentSeries = buildSeries(info.daily)
    } else {
      current = { id: sessionId, calls: 0, usage: { ...zeroUsage } }
      currentSeries = []
    }
  }
  return {
    scanning: store.scanning,
    scans: store.scans,
    failed: store.failed,
    rawSessions: store.rawSessions,
    harnessSessions: store.harnessSessions,
    foldedEvents: store.foldedEvents,
    dedupSkipped: store.dedupSkipped,
    lastError: store.lastError,
    scanError: store.scanError,
    lastScanAt: store.lastScanAt,
    time: Date.now(),
    sessions: sessionsWithUsage,
    current,
    all: { calls: allAgg.calls, usage: usageOf(allAgg) },
    series: { all: allSeries, current: currentSeries },
    models,
    sessionsList: truncatedList,
    sessionsListTotal,
  }
}