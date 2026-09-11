/**
 * 快照构建：把聚合缓存 UsageStore 与账本会话元数据整理成
 * usageStats/snapshot 的结果 value，不触碰传输层与 ctx。
 * 快照协议类型 UsageSnapshot、ModelStat、SessionStat、SeriesPoint、
 * UsageAgg 单一定义在 types.ts，host 构建与 client 消费共用同一类型面，
 * 避免两端镜像漂移；splitModelKey 来自 utils.ts，host 与 client 共用。
 */
import { SERIES_MAX_DAYS, splitModelKey } from '../utils.ts';

import { metaOf } from './store.ts';

import type { Agg } from './agg.ts';
import type { Ledger } from './ledger.ts';
import type { UsageStore } from './store.ts';
import type { ModelStat, SeriesPoint, SessionStat, UsageAgg, UsageSnapshot } from '../types.ts';


/** 按日序列点结构定义在 types.ts，与 client 端 SeriesPoint 统一。 */
export type { SeriesPoint } from '../types.ts';

/** 把逐日聚合转成按时间升序的序列，用于会话、全量与模型×日。 */
export function buildSeries(dailyMap: Map<number, Agg>): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const [day, agg] of dailyMap) {
    out.push({
      t: day, input: agg.input, output: agg.output,
      cacheRead: agg.cacheRead, cacheWrite: agg.cacheWrite,
      reasoning: agg.reasoning, calls: agg.calls,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** 聚合转为对外 usage 形状，直接透传聚合内预计算的 total，调用数已分离。 */
export function usageOf(agg: Agg): UsageAgg {
  return {
    input: agg.input, output: agg.output, cacheRead: agg.cacheRead,
    cacheWrite: agg.cacheWrite, reasoning: agg.reasoning, total: agg.total,
  };
}

/** 无用量会话的占位 usage。 */
export const zeroUsage: UsageAgg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };

/** 截断已排序序列至共享上限（`SERIES_MAX_DAYS`，与客户端 `all` 范围对齐），避免长历史下每 4s 全量序列化开销。 */
function truncateSeries(series: SeriesPoint[]): SeriesPoint[] {
  return series.length > SERIES_MAX_DAYS ? series.slice(series.length - SERIES_MAX_DAYS) : series;
}

/** 构建快照 value：汇总 + 模型拆分 + 会话明细 + 按日序列；sessionId 可选过滤当前会话。会话明细默认 200、上限 1000；all 与 models 序列截断至 366 天，current 序列不截断；sessions 为有量会话数。 */
export function snapshot(store: UsageStore, ledger: Ledger, sessionId: string | null, opts?: { limit?: number }): UsageSnapshot {
  let sessionsWithUsage = 0;
  const sessionsList: SessionStat[] = [];
  for (const [id, info] of store.sessions) {
    if (info.allAgg.calls > 0) sessionsWithUsage += 1;
    const meta = metaOf(ledger, id);
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
    });
  }
  sessionsList.sort((a, b) => b.lastActive - a.lastActive);
  // 分页截断：避免上千会话时每 4 秒全量序列化开销；默认 200，可由客户端 limit 显式覆盖
  const rawLimit = opts?.limit;
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.floor(rawLimit))) : 200;
  const truncatedList = sessionsList.length > limit ? sessionsList.slice(0, limit) : sessionsList;

  const models: ModelStat[] = [];
  for (const [key, agg] of store.models) {
    const { provider, model } = splitModelKey(key);
    const dailyMap = store.modelDaily.get(key);
    const series = dailyMap ? truncateSeries(buildSeries(dailyMap)) : [];
    models.push({ provider, model, calls: agg.calls, usage: usageOf(agg), series });
  }
  models.sort((a, b) => b.usage.total - a.usage.total);

  const allAgg = store.allAgg;
  const allSeries = truncateSeries(buildSeries(store.allDaily));
  let current: UsageSnapshot['current'] = null;
  let currentSeries: SeriesPoint[] = [];
  if (sessionId) {
    const info = store.sessions.get(sessionId);
    if (info) {
      current = { id: sessionId, calls: info.allAgg.calls, usage: usageOf(info.allAgg) };
      currentSeries = buildSeries(info.daily);
    } else {
      current = { id: sessionId, calls: 0, usage: { ...zeroUsage } };
      currentSeries = [];
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
  };
}