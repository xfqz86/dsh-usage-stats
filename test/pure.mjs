/**
 * 纯函数与额度解析的单测（node:test + 类型剥离直引源码）。
 *
 * 运行 `node --experimental-strip-types test/pure.mjs`（或 `pnpm test:pure`）；
 * 直接 import `src/*.ts` 源码：纯模块仅含可擦除类型语法，Node ≥22 类型剥离可执行。
 * 额度查询的 fetch 经全局 mock，不产生真实外网请求；快照截断用内存 store，不碰 sqlite。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { ink, modelKeyOf, newAgg, usable } from '../src/host/agg.ts';
import { fetchDeepSeekBalance, queryDeepSeekBalance } from '../src/host/deepseekBalance.ts';
import { fetchGoQuota, queryGoQuota } from '../src/host/goquota.ts';
import { hasUsageStatsHeader, isLoopbackHost, readJsonBody } from '../src/host/http.ts';
import { parseLine, parseLogLines } from '../src/host/logs.ts';
import { createStore } from '../src/host/store.ts';
import { snapshot } from '../src/host/snapshot.ts';
import { fetchZaiQuota } from '../src/host/zaiQuota.ts';
import {
  buildDateStack,
  buildModelStack,
  buildSet,
  curveOf,
  dateRangeCutoff,
  dayTotal,
  filterModelsByRange,
  fmt,
  fmtFull,
  fullDayLabel,
  groupSessions,
  heatGridOf,
  hitRateOfDay,
  modelRangeCutoff,
  modelRangeToDays,
  paginateGroups,
  pctOf,
  pieFullCircleOf,
  pieSlicesOf,
  shortId,
  todayOf,
  usageTotal,
} from '../src/client/stats.ts';
import {
  DAY_MS,
  QUOTA_CACHE_TTL_MS,
  QUOTA_MIN_FETCH_MS,
  SERIES_MAX_DAYS,
  cacheTotal,
  dateKeyOf,
  effectiveQuotaTtl,
  errorMessage,
  goLevelOf,
  goPercent,
  goResetsAt,
  parseJsonLine,
  splitModelKey,
  startOfDay,
} from '../src/utils.ts';

/** 恢复被 mock 的全局 fetch，避免用例间污染。 */
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** 把全局 fetch 换成桩，返回 { restore }。 */
function mockFetch(handler) {
  globalThis.fetch = handler;
  return () => { globalThis.fetch = realFetch; };
}

/** 构造最小 fetch Response 桩。 */
const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

/** 构造凭据中心桩：resolve 恒返回 value。 */
const creds = (value) => ({ resolve: async () => ({ value }) });

/** 构造按序响应的凭据桩：元素为 Error 则抛错，否则返回 { value }（测 key 回退优先级）。 */
function seqCreds(actions) {
  let i = 0;
  return {
    resolve: async () => {
      const a = actions[Math.min(i, actions.length - 1)];
      i += 1;
      if (a instanceof Error) throw a;
      return { value: a };
    },
  };
}

/** 距今天 offset 天的本地零点（offset=0 为今天）。 */
function day(offset) {
  const d = new Date(startOfDay(Date.now()));
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

/** 构造单日序列点。 */
function pt(offset, v, extra) {
  return {
    t: day(offset),
    input: v,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    calls: 1,
    ...extra,
  };
}

/** 构造会话明细条目。 */
function sess(id, over) {
  return {
    id,
    title: id,
    cwd: '',
    createdAt: 0,
    lastActive: 0,
    calls: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    parentSession: null,
    origin: null,
    delegationDepth: 0,
    ...over,
  };
}

/** 构造聚合计数。 */
function agg(total, calls) {
  return { input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total, calls: calls ?? 1 };
}

describe('utils：日期与键', () => {
  it('startOfDay 落到本地零点且幂等', () => {
    const t = Date.now();
    const z = startOfDay(t);
    const d = new Date(z);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
    assert.ok(z <= t);
    assert.equal(startOfDay(z), z);
  });

  it('dateKeyOf 为 YYYY-MM-DD', () => {
    const k = dateKeyOf(Date.now());
    assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('splitModelKey 无分隔符时双 unknown', () => {
    assert.deepEqual(splitModelKey('p\0m'), { provider: 'p', model: 'm' });
    assert.deepEqual(splitModelKey('x'), { provider: 'unknown', model: 'unknown' });
    assert.deepEqual(splitModelKey(''), { provider: 'unknown', model: 'unknown' });
  });

  it('共享常量取值', () => {
    assert.equal(SERIES_MAX_DAYS, 366);
    assert.equal(DAY_MS, 86_400_000);
    assert.equal(QUOTA_MIN_FETCH_MS, 3 * 60 * 1000);
    assert.equal(QUOTA_CACHE_TTL_MS, 5 * 60 * 1000);
  });

  it('effectiveQuotaTtl 按 min/max 夹取', () => {
    assert.equal(effectiveQuotaTtl(undefined), 300_000);
    assert.equal(effectiveQuotaTtl(Number.NaN), 300_000);
    assert.equal(effectiveQuotaTtl(1), 180_000);
    assert.equal(effectiveQuotaTtl(0), 180_000);
    assert.equal(effectiveQuotaTtl(5), 300_000);
    assert.equal(effectiveQuotaTtl(10), 300_000);
  });
});

describe('utils：额度与文本', () => {
  it('goPercent 四舍五入并夹取', () => {
    assert.equal(goPercent({ percent: 12.4, resetsAt: '' }), 12);
    assert.equal(goPercent({ percent: 12.5, resetsAt: '' }), 13);
    assert.equal(goPercent({ percent: -5, resetsAt: '' }), 0);
    assert.equal(goPercent({ percent: 120, resetsAt: '' }), 100);
  });

  it('goLevelOf 三档边界', () => {
    assert.equal(goLevelOf(79.9), 'ok');
    assert.equal(goLevelOf(80), 'warn');
    assert.equal(goLevelOf(99.9), 'warn');
    assert.equal(goLevelOf(100), 'over');
  });

  it('goResetsAt 无时间返回空串', () => {
    const t = (k) => `[${k}]`;
    assert.equal(goResetsAt(t, { percent: 0, resetsAt: '' }), '');
    assert.ok(goResetsAt(t, { percent: 0, resetsAt: new Date().toISOString() }).includes('go.resetsAt'));
  });

  it('parseJsonLine 空行坏行回 null', () => {
    assert.equal(parseJsonLine(''), null);
    assert.equal(parseJsonLine('   '), null);
    assert.equal(parseJsonLine('not json'), null);
    assert.deepEqual(parseJsonLine('{"a":1}'), { a: 1 });
  });

  it('errorMessage 三形态', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom');
    assert.equal(errorMessage({ message: 'm' }), 'm');
    assert.equal(errorMessage(42), '42');
  });

  it('cacheTotal 缺省归零', () => {
    assert.equal(cacheTotal({}), 0);
    assert.equal(cacheTotal({ cacheRead: 5 }), 5);
    assert.equal(cacheTotal({ cacheRead: 5, cacheWrite: 7 }), 12);
  });
});

describe('agg：口径', () => {
  it('newAgg 全零', () => {
    assert.deepEqual(newAgg(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 });
  });

  it('ink 求和且 reasoning 不计 total', () => {
    const a = newAgg();
    ink(a, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 100 });
    assert.equal(a.total, 20);
    assert.equal(a.reasoning, 100);
    assert.equal(a.calls, 1);
  });

  it('ink 缺字段归零仍计次', () => {
    const a = newAgg();
    ink(a, {});
    assert.equal(a.total, 0);
    assert.equal(a.calls, 1);
  });

  it('usable 仅放行带 usage 的 assistant/message', () => {
    assert.equal(usable({ type: 'assistant/message', data: { usage: {} } }), true);
    assert.equal(usable({ type: 'session' }), false);
    assert.equal(usable({ type: 'assistant/message', data: {} }), false);
    assert.equal(usable({ type: 'assistant/message' }), false);
  });

  it('modelKeyOf 缺失记 unknown', () => {
    assert.equal(modelKeyOf({ type: 'assistant/message', data: { message: { source: { provider: 'p', model: 'm' } } } }), 'p\0m');
    assert.equal(modelKeyOf({ type: 'assistant/message', data: {} }), 'unknown\0unknown');
    assert.equal(modelKeyOf({ type: 'assistant/message', data: { message: { source: { provider: '', model: '' } } } }), 'unknown\0unknown');
  });
});

describe('logs：行解析', () => {
  it('parseLine 非对象与坏行回 null', () => {
    assert.equal(parseLine(''), null);
    assert.equal(parseLine('x'), null);
    assert.equal(parseLine('{"a":1}'), null);
    assert.deepEqual(parseLine('{"type":"session"}'), { type: 'session' });
  });

  it('parseLogLines 跳坏行不断流', () => {
    const out = parseLogLines('{"type":"a"}\nbad\n\n{"type":"b"}');
    assert.equal(out.length, 2);
  });
});

describe('http：围栏与请求体', () => {
  it('isLoopbackHost 仅放行回环', () => {
    assert.equal(isLoopbackHost('127.0.0.1:3080'), true);
    assert.equal(isLoopbackHost('127.0.0.5'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('LOCALHOST:80'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('[::1]:3080'), true);
    assert.equal(isLoopbackHost('127.0.0.1.evil.com'), false);
    assert.equal(isLoopbackHost('192.168.1.1'), false);
    assert.equal(isLoopbackHost(undefined), false);
    assert.equal(isLoopbackHost(''), false);
  });

  it('hasUsageStatsHeader 精确匹配', () => {
    assert.equal(hasUsageStatsHeader({ 'x-dsh-usage-stats': 'dsh-usage-stats' }), true);
    assert.equal(hasUsageStatsHeader({ 'x-dsh-usage-stats': ['a', 'dsh-usage-stats'] }), true);
    assert.equal(hasUsageStatsHeader({}), false);
    assert.equal(hasUsageStatsHeader({ 'x-dsh-usage-stats': 'other' }), false);
    assert.equal(hasUsageStatsHeader(undefined), false);
  });

  it('readJsonBody 正常与空体', async () => {
    assert.deepEqual(await readJsonBody(Readable.from([Buffer.from('{"a":1}')])), { a: 1 });
    assert.deepEqual(await readJsonBody(Readable.from([Buffer.from('  ')])), {});
  });

  it('readJsonBody 非法与超限英文报错', async () => {
    await assert.rejects(readJsonBody(Readable.from([Buffer.from('{bad')])), /not valid JSON/);
    await assert.rejects(readJsonBody(Readable.from([Buffer.alloc(1_200_000)])), /too large/);
  });
});

describe('stats：格式化', () => {
  const en = () => '';
  it('fmt 中英紧凑', () => {
    assert.equal(fmt(null), '--');
    assert.equal(fmt(Number.NaN), '--');
    assert.equal(fmt(999), '999');
    assert.equal(fmt(1500, 'en'), '1.5K');
    assert.equal(fmt(1500, 'zh'), '1500');
    assert.equal(fmt(25_000, 'zh'), '2.5万');
    assert.equal(fmt(250_000_000, 'zh'), '2.5亿');
    assert.equal(fmt(2_000_000_000, 'en'), '2B');
    assert.equal(fmt(1500, en), '1.5K');
  });

  it('fmtFull 千分位与缺省', () => {
    assert.equal(fmtFull(1234567), '1,234,567');
    assert.equal(fmtFull(null), '--');
  });

  it('shortId 与 pctOf', () => {
    assert.equal(shortId(''), '--');
    assert.equal(shortId('short'), 'short');
    assert.equal(shortId('abcdefghij1234'), 'abcdef…1234');
    assert.equal(pctOf(12.5), '12.5%');
    assert.equal(pctOf(null), '--');
    assert.equal(pctOf(Number.NaN), '--');
  });

  it('dayTotal/usageTotal 缺省归零', () => {
    assert.equal(dayTotal({}), 0);
    assert.equal(dayTotal({ input: 1, cacheRead: 2 }), 3);
    assert.equal(usageTotal({ total: 7 }), 7);
    assert.equal(usageTotal(undefined), 0);
  });

  it('hitRateOfDay 分母零断开', () => {
    assert.equal(hitRateOfDay({}), null);
    assert.equal(hitRateOfDay({ input: 0, cacheRead: 0 }), null);
    assert.equal(hitRateOfDay({ input: 1, cacheRead: 3 }), 75);
  });
});

describe('stats：会话分组', () => {
  it('子代理折叠到主会话并汇总', () => {
    const groups = groupSessions([
      sess('m1', { lastActive: 2, calls: 2, usage: agg(20, 2) }),
      sess('c1', { lastActive: 3, calls: 3, usage: agg(30, 3), parentSession: 'm1', origin: 'subagent', delegationDepth: 1 }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].childCount, 1);
    assert.equal(groups[0].agg.calls, 5);
    assert.equal(groups[0].agg.usage.total, 50);
  });

  it('孤儿回落顶层', () => {
    const groups = groupSessions([
      sess('m1', { lastActive: 1 }),
      sess('c2', { lastActive: 2, parentSession: 'missing', origin: 'subagent', delegationDepth: 1 }),
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].main.id, 'c2');
  });

  it('多级展平到根', () => {
    const groups = groupSessions([
      sess('m1', { lastActive: 1 }),
      sess('c1', { lastActive: 2, parentSession: 'm1', origin: 'subagent', delegationDepth: 1 }),
      sess('g', { lastActive: 3, parentSession: 'c1', origin: 'subagent', delegationDepth: 2 }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].childCount, 2);
    assert.deepEqual(groups[0].children.map((c) => c.id), ['g', 'c1']);
  });

  it('成环不死循环', () => {
    const groups = groupSessions([
      sess('a', { lastActive: 1, parentSession: 'b', origin: 'subagent', delegationDepth: 1 }),
      sess('b', { lastActive: 2, parentSession: 'a', origin: 'subagent', delegationDepth: 1 }),
    ]);
    assert.equal(groups.length, 2);
  });

  it('paginateGroups 子不占页位且越界回空', () => {
    const mains = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ main: sess(id, { lastActive: i }), children: [], agg: { calls: 0, usage: agg(0, 0) }, childCount: 0 }));
    assert.equal(paginateGroups(mains, 2, 2).length, 2);
    assert.deepEqual(paginateGroups(mains, 9, 2), []);
    assert.deepEqual(paginateGroups([], 1, 20), []);
  });
});

describe('stats：时间范围', () => {
  it('buildSet 7d 补零且末桶为今天', () => {
    const buckets = buildSet([pt(6, 5), pt(0, 7)], '7d');
    assert.equal(buckets.length, 7);
    assert.equal(buckets[6].t, startOfDay(Date.now()));
    assert.equal(buckets[6].input, 7);
    assert.equal(buckets[3].input, 0);
    assert.equal(buckets[0].t, startOfDay(buckets[0].t));
  });

  it('buildSet 桶按本地日历逐日推进（DST 安全）', () => {
    const buckets = buildSet([pt(0, 1)], '7d');
    for (let i = 0; i < buckets.length - 1; i += 1) {
      const expect = new Date(buckets[i].t);
      expect.setDate(expect.getDate() + 1);
      assert.equal(buckets[i + 1].t, expect.getTime());
    }
  });

  it('buildSet all 从最早日到今天', () => {
    const buckets = buildSet([pt(3, 1), pt(0, 2)], 'all');
    assert.equal(buckets.length, 4);
    assert.equal(buckets[3].input, 2);
  });

  it('todayOf 取今日点', () => {
    assert.equal(todayOf([pt(1, 1), pt(0, 9)]).input, 9);
    assert.equal(todayOf([pt(2, 1), pt(1, 2)]), undefined);
  });

  it('modelRange 映射与 dateRange 复用', () => {
    assert.equal(modelRangeToDays('7d'), 7);
    assert.equal(modelRangeToDays('all'), null);
    const cutoff = modelRangeCutoff('7d');
    assert.equal(cutoff, startOfDay(cutoff));
    assert.equal(Math.round((startOfDay(Date.now()) - cutoff) / DAY_MS), 6);
    assert.equal(modelRangeCutoff('all'), null);
    assert.equal(dateRangeCutoff('all'), null);
  });
});

describe('stats：图表几何', () => {
  it('heatGridOf 空序列与今日格', () => {
    const g = heatGridOf([], 26);
    assert.equal(g.cols, 26);
    assert.equal(g.cells.length, 182);
    assert.equal(g.months.length, 26);
    assert.equal(g.cells.filter((c) => c.today).length, 1);
    assert.ok(g.cells.every((c) => c.lvl === 0));
    assert.equal(g.cells.find((c) => c.today).label, fullDayLabel(startOfDay(Date.now())));
  });

  it('heatGridOf 强度分四档', () => {
    const g = heatGridOf([pt(0, 100), pt(1, 10)], 2);
    const lvls = g.cells.map((c) => c.lvl);
    assert.ok(lvls.every((l) => l >= 0 && l <= 4));
    assert.equal(Math.max(...lvls), 4);
  });

  it('curveOf 空回 null', () => {
    assert.equal(curveOf([]), null);
    const g = curveOf([pt(0, 5)]);
    assert.ok(g.line.startsWith('M'));
    assert.equal(g.hits.length, 1);
  });

  it('pieSlicesOf 最大余数总和 100', () => {
    const models = ['a', 'b', 'c'].map((m) => ({ provider: 'p', model: m, calls: 1, usage: agg(1, 1) }));
    const slices = pieSlicesOf(models);
    assert.equal(slices.length, 3);
    const sum = slices.reduce((s, x) => s + x.share, 0);
    assert.ok(Math.abs(sum - 100) < 1e-9);
    assert.deepEqual(pieSlicesOf([]), []);
  });

  it('pieFullCircleOf 单切片整圆', () => {
    const slices = pieSlicesOf([{ provider: 'p', model: 'only', calls: 1, usage: agg(5, 1) }]);
    assert.equal(pieFullCircleOf(slices), slices[0]);
    assert.equal(pieFullCircleOf([]), null);
  });
});

describe('stats：模型范围过滤与堆叠', () => {
  const mk = (id, series) => ({ provider: 'p', model: id, calls: series.length, usage: agg(series.reduce((s, x) => s + x.input, 0), series.length), series });

  it('all 原样排序，范围按 cutoff 过滤', () => {
    const old = pt(30, 100);
    const rec = pt(1, 10);
    const models = [mk('m1', [old, rec]), mk('m2', [rec])];
    assert.deepEqual(filterModelsByRange(models, 'all').map((m) => m.model), ['m1', 'm2']);
    const f = filterModelsByRange(models, '7d');
    assert.equal(f.length, 2);
    assert.equal(f[0].usage.total, 10);
    assert.equal(f[0].series.length, 1);
  });

  it('无细分旧快照在范围模式下跳过', () => {
    const models = [mk('m1', []), mk('m2', [pt(0, 5)])];
    assert.equal(filterModelsByRange(models, '7d').length, 1);
    assert.equal(filterModelsByRange(models, 'all').length, 2);
  });

  it('buildModelStack 形态与 all 上限 366', () => {
    const series = [];
    for (let i = 399; i >= 0; i -= 1) series.push(pt(i, 1));
    const stack = buildModelStack([mk('m1', series)], 'all');
    assert.equal(stack.days.length, 366);
    assert.ok(stack.maxTotal >= 1);
    assert.ok(stack.days.every((d) => d.segments.length > 0));
  });

  it('buildDateStack all 空回空，上限 366', () => {
    assert.deepEqual(buildDateStack([], 'all'), { days: [], maxTotal: 1 });
    const series = [];
    for (let i = 399; i >= 0; i -= 1) series.push(pt(i, 2));
    const stack = buildDateStack(series, 'all');
    assert.equal(stack.days.length, 366);
  });

  it('buildDateStack 7d 三段与命中率一致', () => {
    const stack = buildDateStack([pt(0, 4, { cacheRead: 12 })], '7d');
    assert.equal(stack.days.length, 7);
    const last = stack.days[6];
    assert.equal(last.segments.length, 2);
    assert.equal(hitRateOfDay(last), 75);
  });
});

describe('snapshot：构建与截断', () => {
  it('快照截断至 366 天且总量不受影响', () => {
    const store = createStore();
    const base = day(399);
    for (let i = 0; i < 400; i += 1) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      const t = d.getTime();
      store.allDaily.set(t, agg(1, 1));
    }
    store.allAgg = agg(400, 400);
    store.models.set('p\0m', agg(400, 400));
    const md = new Map();
    for (const [t, a] of store.allDaily) md.set(t, { ...a });
    store.modelDaily.set('p\0m', md);
    const snap = snapshot(store, { getMeta: () => null }, null);
    assert.equal(snap.series.all.length, 366);
    assert.equal(snap.models[0].series.length, 366);
    assert.equal(snap.all.calls, 400);
    assert.equal(snap.models[0].calls, 400);
  });
});

describe('quota：go', () => {
  it('query 缓存命中只打一次', async () => {
    let calls = 0;
    const restore = mockFetch(async () => {
      calls += 1;
      return jsonResponse(200, { usage: {} });
    });
    try {
      const a = await queryGoQuota(5, false, creds('k'));
      const b = await queryGoQuota(5, false, creds('k'));
      const c = await queryGoQuota(5, true, creds('k'));
      assert.equal(calls, 1);
      assert.equal(a, b);
      assert.equal(b, c);
    } finally {
      restore();
    }
  });

  it('无 key 不请求直接 no-key', async () => {
    let calls = 0;
    const restore = mockFetch(async () => {
      calls += 1;
      return jsonResponse(200, {});
    });
    try {
      const q = await fetchGoQuota(undefined);
      assert.equal(q.status, 'no-key');
      assert.equal(calls, 0);
    } finally {
      restore();
    }
  });

  it('key 去空格后透传', async () => {
    let auth = '';
    const restore = mockFetch(async (_url, init) => {
      auth = init.headers.authorization;
      return jsonResponse(200, { usage: {} });
    });
    try {
      await fetchGoQuota(creds('  k  '));
      assert.equal(auth, 'Bearer k');
    } finally {
      restore();
    }
  });

  it('401 判 no-key，非 2xx 与异构判 error', async () => {
    let restore = mockFetch(async () => jsonResponse(401, {}));
    try {
      assert.equal((await fetchGoQuota(creds('k'))).status, 'no-key');
    } finally {
      restore();
    }
    restore = mockFetch(async () => jsonResponse(500, {}));
    try {
      assert.equal((await fetchGoQuota(creds('k'))).status, 'error');
    } finally {
      restore();
    }
    restore = mockFetch(async () => jsonResponse(200, { usage: null }));
    try {
      assert.equal((await fetchGoQuota(creds('k'))).status, 'error');
    } finally {
      restore();
    }
    restore = mockFetch(async () => { throw new Error('down'); });
    try {
      assert.equal((await fetchGoQuota(creds('k'))).status, 'error');
    } finally {
      restore();
    }
  });

  it('窗口归一化：合法保留、非法置 null', async () => {
    const restore = mockFetch(async () => jsonResponse(200, {
      usage: { rolling: { percent: 10.4, resetsAt: 'r' }, weekly: { percent: 'bad' }, monthly: null },
    }));
    try {
      const q = await fetchGoQuota(creds('k'));
      assert.equal(q.status, 'ok');
      assert.equal(q.rolling.percent, 10.4);
      assert.equal(q.weekly, null);
      assert.equal(q.monthly, null);
    } finally {
      restore();
    }
  });
});

describe('quota：deepseek', () => {
  it('无 key 与 401 判 no-key', async () => {
    assert.equal((await fetchDeepSeekBalance(undefined)).status, 'no-key');
    const restore = mockFetch(async () => jsonResponse(401, {}));
    try {
      assert.equal((await fetchDeepSeekBalance(creds('k'))).status, 'no-key');
    } finally {
      restore();
    }
  });

  it('余额归一化保留字符串、非法条目丢弃', async () => {
    const restore = mockFetch(async () => jsonResponse(200, {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '12.34', granted_balance: 5, topped_up_balance: null },
        { currency: '', total_balance: '1' },
        'x',
      ],
    }));
    try {
      const q = await fetchDeepSeekBalance(creds('k'));
      assert.equal(q.status, 'ok');
      assert.equal(q.isAvailable, true);
      assert.equal(q.balances.length, 1);
      assert.deepEqual(q.balances[0], {
        currency: 'CNY',
        totalBalance: '12.34',
        grantedBalance: '5',
        toppedUpBalance: '0.00',
      });
    } finally {
      restore();
    }
  });

  it('非 boolean true 的 is_available 归一为 false', async () => {
    const restore = mockFetch(async () => jsonResponse(200, { is_available: 1, balance_infos: [] }));
    try {
      const q = await fetchDeepSeekBalance(creds('k'));
      assert.equal(q.status, 'ok');
      assert.equal(q.isAvailable, false);
    } finally {
      restore();
    }
  });

  it('key 按优先级回退', async () => {
    const restore = mockFetch(async () => jsonResponse(200, { is_available: true, balance_infos: [] }));
    try {
      const q = await queryDeepSeekBalance(5, false, seqCreds([new Error('x'), new Error('y'), new Error('z'), 'd']));
      assert.equal(q.status, 'ok');
    } finally {
      restore();
    }
  });
});

describe('quota：zai', () => {
  const T = 1_780_000_000_000;
  const okBody = {
    code: 200,
    success: true,
    data: {
      level: 'pro',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 12.5, nextResetTime: T, currentValue: 10, usage: 100 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 50, nextResetTime: T },
        { type: 'TIME_LIMIT', currentValue: 5, usage: 20, nextResetTime: T },
      ],
    },
  };

  it('ok 三窗口与计划名', async () => {
    const restore = mockFetch(async () => jsonResponse(200, okBody));
    try {
      const q = await fetchZaiQuota(creds('k'));
      assert.equal(q.status, 'ok');
      assert.equal(q.plan, 'Z.ai pro');
      assert.equal(q.session.percent, 12.5);
      assert.equal(q.session.used, 10);
      assert.equal(q.session.limit, 100);
      assert.equal(q.weekly.percent, 50);
      assert.equal(q.webSearches.used, 5);
      assert.equal(q.webSearches.limit, 20);
      assert.equal(q.webSearches.percent, 25);
      assert.equal(new Date(q.session.resetsAt).getTime(), T);
    } finally {
      restore();
    }
  });

  it('无 key 与 401 判 no-key，无 plan 信号判 no-plan', async () => {
    assert.equal((await fetchZaiQuota(undefined)).status, 'no-key');
    let restore = mockFetch(async () => jsonResponse(403, {}));
    try {
      assert.equal((await fetchZaiQuota(creds('k'))).status, 'no-key');
    } finally {
      restore();
    }
    restore = mockFetch(async () => jsonResponse(200, { success: false, msg: '当前用户不存在coding plan' }));
    try {
      assert.equal((await fetchZaiQuota(creds('k'))).status, 'no-plan');
    } finally {
      restore();
    }
  });

  it('空 limits 为 ok 空数据，已识别但非法判 error', async () => {
    let restore = mockFetch(async () => jsonResponse(200, { code: 200, success: true, data: { level: 'pro', limits: [] } }));
    try {
      const q = await fetchZaiQuota(creds('k'));
      assert.equal(q.status, 'ok');
      assert.equal(q.plan, 'Z.ai pro');
      assert.equal(q.session, null);
    } finally {
      restore();
    }
    restore = mockFetch(async () => jsonResponse(200, {
      code: 200,
      success: true,
      data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, nextResetTime: T }] },
    }));
    try {
      assert.equal((await fetchZaiQuota(creds('k'))).status, 'error');
    } finally {
      restore();
    }
  });

  it('全未知类型为 ok 空数据，缺 limits 判 error', async () => {
    let restore = mockFetch(async () => jsonResponse(200, {
      code: 200,
      success: true,
      data: { limits: [{ type: 'NOPE', unit: 1, number: 1 }] },
    }));
    try {
      const q = await fetchZaiQuota(creds('k'));
      assert.equal(q.status, 'ok');
      assert.equal(q.session, null);
    } finally {
      restore();
    }
    restore = mockFetch(async () => jsonResponse(200, { code: 200, success: true, data: {} }));
    try {
      assert.equal((await fetchZaiQuota(creds('k'))).status, 'error');
    } finally {
      restore();
    }
  });

  it('key 优先用 ZAI_CODING_CN', async () => {
    let auth = '';
    const restore = mockFetch(async (_url, init) => {
      auth = init.headers.authorization;
      return jsonResponse(200, okBody);
    });
    try {
      await fetchZaiQuota(seqCreds([new Error('x'), ' second ']));
      assert.equal(auth, 'Bearer second');
    } finally {
      restore();
    }
  });
});
