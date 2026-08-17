/**
 * 快照构建：把 UsageStore 折叠结果整理成 /usage-stats/api/snapshot 的
 * 响应 value（纯函数，不触碰 HTTP / ctx）。
 */
import type { Agg } from './agg.ts'
import type { UsageStore } from './store.ts'

/** 按日序列点（快照 series 元素）。 */
export interface SeriesPoint {
  t: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  calls: number
}

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
export function usageOf(agg: Agg) {
  return {
    input: agg.input, output: agg.output, cacheRead: agg.cacheRead,
    cacheWrite: agg.cacheWrite, reasoning: agg.reasoning, total: agg.total,
  }
}

/** 无用量会话的占位 usage。 */
export const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }

/** 构建快照 value：汇总 + 模型拆分 + 会话明细 + 按日序列；sessionId 可选过滤当前会话。 */
export function snapshot(store: UsageStore, sessionId: string | null): unknown {
  let sessionsWithUsage = 0
  const sessionsList: Array<Record<string, unknown>> = []
  for (const [id, info] of store.sessions) {
    if (info.allAgg.calls > 0) sessionsWithUsage += 1
    sessionsList.push({
      id,
      title: info.title,
      cwd: info.cwd,
      createdAt: info.createdAt,
      lastActive: info.lastActive,
      calls: info.allAgg.calls,
      usage: usageOf(info.allAgg),
    })
  }
  sessionsList.sort((a, b) => (b.lastActive as number) - (a.lastActive as number))

  const models: Array<Record<string, unknown>> = []
  for (const [key, agg] of store.models) {
    const sep = key.indexOf('\u0000')
    const provider = sep === -1 ? key : key.slice(0, sep)
    const model = sep === -1 ? 'unknown' : key.slice(sep + 1)
    models.push({ provider, model, calls: agg.calls, usage: usageOf(agg) })
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
    ok: true,
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
    sessionsList,
  }
}