/**
 * 明细构建：把 usageStats/modelDetail 与 usageStats/dateDetail 的结果 value
 * 从聚合缓存与账本整理出来，不触碰传输层与 ctx。
 *
 * 两个方法取数路径不同，各有理由：
 *   - modelDetail：按日走聚合缓存的 modelDaily —— 它就是 startOfDay 分的桶，
 *     本地日划分的唯一来源是 utils.ts（docs/ARCHITECTURE.md §5），不在 SQLite
 *     里再分一次日；按会话的内存里没有该维度，读账本 modelSessions，会话行
 *     字段与快照 sessionsList 同形（SessionStat），元数据取 metaOf，口径与
 *     快照一致；范围内合计由会话行求和，与按日序列合计互为校验。
 *   - dateDetail：按模型与按会话两个维度都在内存聚合里（modelDaily 与会话
 *     daily），不读账本 events —— 单日两边都是既有桶的一次查表，再走一遍 SQL
 *     聚合没有收益；桶键本就是 utils.ts startOfDay 的本地日零点，与浏览器端
 *     日期行里的 SeriesPoint.t 同源，不会出现「服务端另分一次日」的漂移。
 *     合计由当天模型行求和，与会话行合计互为校验（test/smoke.mjs 断言相等）。
 */
import { splitModelKey } from '../utils.ts';

import { buildSeries, usageOf } from './snapshot.ts';
import { metaOf } from './store.ts';

import type { Agg } from './agg.ts';
import type { Ledger } from './ledger.ts';
import type { UsageStore } from './store.ts';
import type { DateDetail, ModelDetail, ModelStat, SessionStat, UsageAgg } from '../types.ts';

/** 明细合计的零值起点，两台明细各由自己维度的行逐行累加（modelDetail 累会话行、dateDetail 累模型行）。 */
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

/**
 * 构建某本地日的明细 value：按模型取聚合缓存的模型×日桶，按会话取各会话的日桶，
 * 两个维度都是对内存聚合的一次查表；`day` 非正数即服务层归一后的无效请求，
 * 返回空明细而不抛错，字段保持齐全供浏览器端直接渲染。
 * @param store - 聚合缓存，提供模型×日与会话×日。
 * @param ledger - 账本，仅用于取会话元数据（标题与子代理归属）。
 * @param day - 本地日零点，非正数返回空明细。
 * @returns 当天合计、当天模型行（总计降序）与当天会话行（总计降序）。
 */
export function dateDetail(store: UsageStore, ledger: Ledger, day: number): DateDetail {
  const models: ModelStat[] = [];
  const sessions: SessionStat[] = [];
  const usage = zeroUsage();
  let calls = 0;
  // 非正数即无效请求（服务层已归一，这里再夹一次保证返回值与类型约定一致）：
  // 桶键是 startOfDay 的结果、恒不为 0，本就会查空，显式挡在循环外让
  // 「非法即空明细」不依赖桶键的取值约定。
  const dayKey = Number.isFinite(day) && day > 0 ? day : 0;
  if (dayKey > 0) {
    for (const [key, dailyMap] of store.modelDaily) {
      const agg = dailyMap.get(dayKey);
      if (agg === undefined) continue;
      const { provider, model } = splitModelKey(key);
      models.push({ provider, model, calls: agg.calls, usage: usageOf(agg) });
    }
    for (const [id, info] of store.sessions) {
      const agg = info.daily.get(dayKey);
      if (agg === undefined) continue;
      const meta = metaOf(ledger, id);
      sessions.push({
        id,
        title: meta.title,
        cwd: meta.cwd,
        createdAt: meta.createdAt,
        // 与快照 sessionsList 同口径：账本元数据与事件时间取较大者
        lastActive: Math.max(meta.lastActive, info.lastActive),
        calls: agg.calls,
        usage: usageOf(agg),
        parentSession: meta.parentSession || null,
        origin: meta.origin || null,
        delegationDepth: meta.delegationDepth || 0,
      });
    }
    // 合计取当天模型行求和：模型行是当天全部用量的完备拆分，会话行只作互校
    // （两者不一致即折叠口径漂移，test/smoke.mjs 断言三者相等）。
    for (const row of models) {
      calls += row.calls;
      usage.input += row.usage.input;
      usage.output += row.usage.output;
      usage.cacheRead += row.usage.cacheRead;
      usage.cacheWrite += row.usage.cacheWrite;
      usage.reasoning += row.usage.reasoning;
      usage.total += row.usage.total;
    }
  }
  // 默认按总计降序、同值按稳定键；浏览器端仍会按当前排序列重排
  models.sort((a, b) => (b.usage.total - a.usage.total)
    || a.provider.localeCompare(b.provider)
    || a.model.localeCompare(b.model));
  sessions.sort((a, b) => (b.usage.total - a.usage.total) || a.id.localeCompare(b.id));
  return { day: dayKey, calls, usage, models, sessions };
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
