/**
 * 模型明细构建：按「供应商 + 模型」把聚合缓存的每日桶与账本的按会话聚合
 * 整理成 usageStats/modelDetail 的结果 value，不触碰传输层与 ctx。
 *
 * 两个维度的来源不同是有意的：
 *   - 按日走聚合缓存的 modelDaily —— 它就是 startOfDay 分的桶，本地日划分的
 *     唯一来源是 utils.ts（docs/ARCHITECTURE.md §5），不在 SQLite 里再分一次日；
 *   - 按会话内存里没有该维度，读账本 modelSessions，会话行字段与快照
 *     sessionsList 同形（SessionStat），元数据取 metaOf，口径与快照一致。
 * 范围内合计由会话行求和，与按日序列合计互为校验（test/smoke.mjs 断言相等）。
 */
import { buildSeries } from './snapshot.ts';
import { metaOf } from './store.ts';

import type { Agg } from './agg.ts';
import type { Ledger } from './ledger.ts';
import type { UsageStore } from './store.ts';
import type { ModelDetail, SessionStat, UsageAgg } from '../types.ts';

/** 明细合计的零值起点，逐会话累加。 */
function zeroUsage(): UsageAgg {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

/**
 * 构建某模型的明细 value：按日序列取聚合缓存的该模型每日桶（`since` 为本地日
 * 零点下界，null 表示全部历史、不截断），按会话明细取账本聚合。
 * @param store - 聚合缓存，提供模型×日。
 * @param ledger - 账本，提供模型×会话与会话元数据。
 * @param provider - 供应商，账本键原文。
 * @param model - 模型，账本键原文。
 * @param since - 时间下界（本地日零点，含），null 表示全部历史。
 * @returns 范围内合计、按日序列（升序）与按会话明细（总计降序）。
 */
export function modelDetail(
  store: UsageStore,
  ledger: Ledger,
  provider: string,
  model: string,
  since: number | null,
): ModelDetail {
  const dailyMap = store.modelDaily.get(provider + '\u0000' + model);
  const daily = dailyMap === undefined
    ? []
    : buildSeries(buildRangeMap(dailyMap, since));

  const usage = zeroUsage();
  let calls = 0;
  const sessions: SessionStat[] = [];
  for (const row of ledger.modelSessions(provider, model, since ?? 0)) {
    const total = row.input + row.output + row.cacheRead + row.cacheWrite;
    usage.input += row.input;
    usage.output += row.output;
    usage.cacheRead += row.cacheRead;
    usage.cacheWrite += row.cacheWrite;
    usage.reasoning += row.reasoning;
    usage.total += total;
    calls += row.calls;
    const meta = metaOf(ledger, row.sessionId);
    sessions.push({
      id: row.sessionId,
      title: meta.title,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      // 与快照 sessionsList 同口径：账本元数据与事件时间取较大者
      lastActive: Math.max(meta.lastActive, row.lastActive),
      calls: row.calls,
      usage: {
        input: row.input, output: row.output, cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite, reasoning: row.reasoning, total,
      },
      parentSession: meta.parentSession || null,
      origin: meta.origin || null,
      delegationDepth: meta.delegationDepth || 0,
    });
  }
  // 默认按总计降序、同值按 id 稳定；浏览器端仍会按当前排序列重排
  sessions.sort((a, b) => (b.usage.total - a.usage.total) || a.id.localeCompare(b.id));

  return { provider, model, calls, usage, daily, sessions };
}

/** 按 `since` 截取每日桶，null 时原样返回（不复制，调用方只读）。 */
function buildRangeMap(dailyMap: Map<number, Agg>, since: number | null): Map<number, Agg> {
  if (since === null) return dailyMap;
  const out = new Map<number, Agg>();
  for (const [day, agg] of dailyMap) {
    if (day >= since) out.set(day, agg);
  }
  return out;
}
