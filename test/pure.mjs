/**
 * 纯函数与额度解析的单测（node:test + 类型剥离直引源码）。
 *
 * 运行 `node --experimental-strip-types test/pure.mjs`（或 `pnpm test:pure`）；
 * 直接 import `src/*.ts` 源码：纯模块仅含可擦除类型语法，Node ≥22 类型剥离可执行。
 * 额度查询的 fetch 经全局 mock，不产生真实外网请求；快照截断用内存 store，不碰 sqlite。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constants, zstdCompressSync } from 'node:zlib';

import { ink, modelKeyOf, newAgg, usable } from '../src/host/agg.ts';
import { fetchDeepSeekBalance, queryDeepSeekBalance } from '../src/host/deepseekBalance.ts';
import { fetchGoQuota, queryGoQuota } from '../src/host/goquota.ts';
import { parseLine, parseLogLines } from '../src/host/logs.ts';
import { UsageSettingsSchema, registerUsageSettings } from '../src/host/settings.ts';
import { decodeSessionLog, parseGenerationName, parseSessionLogName, scanZstdFrames } from '../src/host/rawlog.ts';
import { METHOD_NAMES, USAGE_STATS_REMOTE } from '../src/remote/contribution.ts';
import {
  LEGACY_STORAGE_KEY,
  attachUsageSettings,
  clearLegacySettings,
  detachUsageSettings,
  diffFromDefaults,
  migrateLegacySettings,
  readLegacySettings,
  settingOps,
  subscribeUsageSettings,
  updateUsageSettings,
  usageSettingsView,
} from '../src/client/settings.ts';
import { mountUsageStatsRemote, usageStatsRemote } from '../src/client/remote.ts';
import { createStore, inheritedCountOf, inheritedPrefixOf, liveEventsOf } from '../src/host/store.ts';
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
  DEEPSEEK_FETCH_DEFAULT_MINUTES,
  DEEPSEEK_FETCH_MIN_MINUTES,
  DAY_MS,
  GO_FETCH_DEFAULT_MINUTES,
  GO_FETCH_MIN_MINUTES,
  QUOTA_CACHE_TTL_MS,
  QUOTA_MIN_FETCH_MS,
  SERIES_MAX_DAYS,
  USAGE_SETTINGS_DEFAULTS,
  USAGE_SETTINGS_NAMESPACE,
  ZAI_FETCH_DEFAULT_MINUTES,
  ZAI_FETCH_MIN_MINUTES,
  cacheTotal,
  clampDeepSeekFetchMinutes,
  clampGoFetchMinutes,
  clampZaiFetchMinutes,
  dateKeyOf,
  effectiveQuotaTtl,
  errorMessage,
  goLevelOf,
  goPercent,
  goResetsAt,
  normalizeUsageSettings,
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

  it('usable 放行带 usage 的计量事件（对话与压缩调用）', () => {
    assert.equal(usable({ type: 'assistant/message', data: { usage: {} } }), true);
    assert.equal(usable({ type: 'compaction/summary', data: { usage: {} } }), true);
    assert.equal(usable({ type: 'session' }), false);
    assert.equal(usable({ type: 'assistant/message', data: {} }), false);
    assert.equal(usable({ type: 'assistant/message' }), false);
    assert.equal(usable({ type: 'compaction/summary', data: {} }), false);
    assert.equal(usable({ type: 'compaction/summary' }), false);
    // assistant/attempt 的用量是流式中间态，会与同 turn 的 assistant/message 重复，不收
    assert.equal(usable({ type: 'assistant/attempt', data: { usage: {} } }), false);
  });

  it('modelKeyOf 缺失记 unknown', () => {
    assert.equal(modelKeyOf({ type: 'assistant/message', data: { message: { source: { provider: 'p', model: 'm' } } } }), 'p\0m');
    assert.equal(modelKeyOf({ type: 'assistant/message', data: {} }), 'unknown\0unknown');
    assert.equal(modelKeyOf({ type: 'assistant/message', data: { message: { source: { provider: '', model: '' } } } }), 'unknown\0unknown');
    // 压缩调用的模型身份在 data.provider/data.model，不在 message.source
    assert.equal(modelKeyOf({ type: 'compaction/summary', data: { provider: 'opencode-go', model: 'deepseek-v4-flash' } }), 'opencode-go\0deepseek-v4-flash');
    assert.equal(modelKeyOf({ type: 'compaction/summary', data: {} }), 'unknown\0unknown');
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

/** 压缩一段文本为一帧：与 harness 一致带 checksum，覆盖帧头 checksum 分支。 */
const zstdFrame = (text) => zstdCompressSync(Buffer.from(text, 'utf8'), {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
});

describe('rawlog：代次识别与多帧 zstd 解码', () => {
  it('parseGenerationName 识别全代次，非规范名 -1', () => {
    assert.equal(parseGenerationName('session.jsonl.zstd'), 0);
    assert.equal(parseGenerationName('session.v2.jsonl.zstd'), 2);
    assert.equal(parseGenerationName('session.v3.jsonl.zstd'), 3);
    assert.equal(parseGenerationName('session.jsonl'), 0);
    assert.equal(parseGenerationName('session.v1.jsonl'), 1);
    assert.equal(parseGenerationName('session.v12.jsonl.zstd'), 12);
    for (const bad of [
      'session.lock', 'session.v0.jsonl.zstd', 'session.v01.jsonl.zstd',
      'SESSION.V2.JSONL.ZSTD', 'session.jsonl.zstd.tmp', 'notes.txt', '',
    ]) {
      assert.equal(parseGenerationName(bad), -1, bad);
    }
    assert.deepEqual(parseSessionLogName('session.v2.jsonl.zstd'), { generation: 2, compression: 'zstd' });
    assert.deepEqual(parseSessionLogName('session.jsonl'), { generation: 0, compression: 'none' });
    assert.equal(parseSessionLogName('session.lock'), null);
  });

  it('单帧解码等于原文，帧数 1', () => {
    const text = '{"type":"session","id":"s"}\n{"type":"assistant/message"}\n';
    const buffer = zstdFrame(text);
    assert.equal(decodeSessionLog(buffer, 'zstd'), text);
    assert.equal(scanZstdFrames(buffer).frames.length, 1);
    assert.equal(scanZstdFrames(buffer).tornStart, undefined);
  });

  it('多帧拼接逐帧解压得到完整文本', () => {
    const chunks = [
      '{"type":"session","id":"s"}\n',
      '{"type":"assistant/message","i":1}\n',
      '{"type":"assistant/message","i":2}\n{"type":"assistant/message","i":3}\n',
    ];
    const buffer = Buffer.concat(chunks.map(zstdFrame));
    assert.equal(decodeSessionLog(buffer, 'zstd'), chunks.join(''));
    assert.equal(scanZstdFrames(buffer).frames.length, chunks.length);
    // 帧区间连续覆盖整个文件且互不重叠
    const scan = scanZstdFrames(buffer);
    assert.equal(scan.frames[0].start, 0);
    assert.equal(scan.frames.at(-1).end, buffer.length);
    for (let i = 1; i < scan.frames.length; i += 1) {
      assert.equal(scan.frames[i].start, scan.frames[i - 1].end);
    }
  });

  it('真实规模形态：1400 段逐帧追加，解出行数一致', () => {
    // 模拟 harness append-only 写入：每帧若干条事件，首帧为会话头。
    const chunks = ['{"type":"session","id":"s"}\n'];
    for (let i = 1; i < 1400; i += 1) chunks.push(`{"type":"assistant/message","i":${i}}\n`);
    const buffer = Buffer.concat(chunks.map(zstdFrame));
    const scan = scanZstdFrames(buffer);
    assert.equal(scan.frames.length, 1400);
    const text = decodeSessionLog(buffer, 'zstd');
    assert.equal(text, chunks.join(''));
    assert.equal(text.split('\n').filter(Boolean).length, 1400);
  });

  it('未压缩明文原样返回，含中文多字节', () => {
    const text = '{"type":"session","title":"中文标题"}\n{"type":"assistant/message"}\n';
    assert.equal(decodeSessionLog(Buffer.from(text, 'utf8'), 'none'), text);
  });

  it('截断尾帧按 harness 语义只保留完整部分', () => {
    const a = '{"type":"session","id":"s"}\n';
    const b = '{"type":"assistant/message","i":1}\n{"type":"assistant/message","i":2}\n';
    const frameA = zstdFrame(a);
    const frameB = zstdFrame(b);
    // 尾帧 payload 被切断：该帧一个 block 都不完整，整帧丢弃
    const cutPayload = Buffer.concat([frameA, frameB.subarray(0, frameB.length - 12)]);
    assert.equal(decodeSessionLog(cutPayload, 'zstd'), a);
    assert.equal(scanZstdFrames(cutPayload).tornStart, frameA.length);
    // 尾帧仅缺 checksum：payload 完整，按 harness 迁移语义恢复明文
    const cutChecksum = Buffer.concat([frameA, frameB.subarray(0, frameB.length - 3)]);
    assert.equal(decodeSessionLog(cutChecksum, 'zstd'), a + b);
    // 只有不完整首帧：不抛错，返回空串
    const tornOnly = frameA.subarray(0, 8);
    assert.equal(scanZstdFrames(tornOnly).tornStart, 0);
    assert.equal(decodeSessionLog(tornOnly, 'zstd'), '');
  });

  it('空文件返回空串，坏帧抛错', () => {
    assert.equal(decodeSessionLog(Buffer.alloc(0), 'zstd'), '');
    assert.deepEqual(scanZstdFrames(Buffer.alloc(0)).frames, []);
    const badMagic = Buffer.from([0, 1, 2, 3]);
    assert.throws(() => scanZstdFrames(badMagic), /invalid frame magic at byte 0/);
    assert.throws(() => decodeSessionLog(badMagic, 'zstd'), /invalid frame magic at byte 0/);
    // 完整帧后跟坏 magic：结构非法，同 harness 语义抛错
    const trailingGarbage = Buffer.concat([zstdFrame('{"type":"a"}\n'), Buffer.from([9, 9, 9, 9])]);
    assert.throws(() => scanZstdFrames(trailingGarbage), /invalid frame magic at byte /);
    // 完整帧被篡改：帧校验失败抛错
    const tampered = Buffer.from(zstdFrame('{"type":"a"}\n'));
    tampered[tampered.length - 6] ^= 0xFF;
    assert.throws(() => decodeSessionLog(tampered, 'zstd'), /failed validation/);
  });
});

describe('fork 继承前缀：只折本会话自有事件', () => {
  it('inheritedPrefixOf 取最后一个 inherited 标记之后偏移一位', () => {
    const records = [
      { type: 'session', id: 'child', parentSession: 'parent' },
      { type: 'assistant/message', seq: 0 },
      { type: 'session/end-seed', seq: 1, data: { inherited: true } },
      { type: 'assistant/message', seq: 2 },
    ];
    assert.equal(inheritedPrefixOf(records), 2);
    // 无标记（普通会话）与自身 seed（resume，inherited 非 true）都不算继承
    assert.equal(inheritedPrefixOf([{ type: 'assistant/message', seq: 0 }]), 0);
    assert.equal(inheritedPrefixOf([{ type: 'session/end-seed', seq: 3, data: {} }]), 0);
    assert.equal(inheritedPrefixOf([]), 0);
    // 多个标记取最大 seq，坏记录跳过
    assert.equal(inheritedPrefixOf([null, 7, { type: 'session/end-seed', seq: 5, data: { inherited: true } }, { type: 'session/end-seed', seq: 3, data: { inherited: true } }]), 6);
  });

  it('liveEventsOf 丢继承前缀，保留无 seq 的 header 记录', () => {
    const records = [
      { type: 'session', id: 'child' },
      { type: 'assistant/message', seq: 0, data: { usage: { inputTokens: 1 } } },
      { type: 'session/end-seed', seq: 1, data: { inherited: true } },
      { type: 'assistant/message', seq: 2, data: { usage: { inputTokens: 9 } } },
    ];
    const live = liveEventsOf(records, 2);
    assert.deepEqual(live.map((r) => r.seq ?? 'header'), ['header', 2]);
    // inherited 为 0 时原样返回，不做拷贝
    assert.equal(liveEventsOf(records, 0), records);
  });

  it('inheritedCountOf 归一 harness 元数据', () => {
    assert.equal(inheritedCountOf(3), 3);
    assert.equal(inheritedCountOf(0), 0);
    assert.equal(inheritedCountOf(undefined), 0);
    assert.equal(inheritedCountOf(-2), 0);
    assert.equal(inheritedCountOf(Number.NaN), 0);
    assert.equal(inheritedCountOf('4'), 4);
  });
});

describe('remote：手写严格贡献', () => {
  it('7 个一元方法与服务一致', () => {
    assert.deepEqual([...METHOD_NAMES], [
      'snapshot', 'rebuild', 'clear', 'seal', 'goQuota', 'deepseekBalance', 'zaiQuota',
    ]);
    assert.equal(USAGE_STATS_REMOTE.package, '@xfqz86/dsh-usage-stats');
    assert.deepEqual(
      USAGE_STATS_REMOTE.descriptors.map((d) => d.method),
      [...METHOD_NAMES],
    );
    for (const d of USAGE_STATS_REMOTE.descriptors) {
      assert.equal(d.service, 'usageStats');
      assert.equal(d.namespace, 'usageStats');
      assert.deepEqual(d.invocation, { kind: 'direct' });
      assert.equal(d.cancellation, undefined);
      for (const p of d.parameters) assert.equal(p.codec.mode, 'strict');
      assert.equal(d.result.mode, 'strict');
    }
  });

  it('请求 schema 收发合法、拒非法', () => {
    const snap = USAGE_STATS_REMOTE.descriptors.find((d) => d.method === 'snapshot');
    assert.ok(snap && snap.parameters.length === 1);
    const codec = snap.parameters[0].codec;
    assert.equal(codec.mode, 'strict');
    if (codec.mode !== 'strict') throw new Error('unreachable');
    codec.schema.parse({ sessionId: null });
    codec.schema.parse({ sessionId: 's-1', limit: 500 });
    assert.throws(() => codec.schema.parse({ sessionId: 42 }));
    assert.throws(() => codec.schema.parse({ sessionId: null, limit: 'x' }));
  });

  it('结果信封成功分支严格、错误分支透传', () => {
    const quota = USAGE_STATS_REMOTE.descriptors.find((d) => d.method === 'goQuota');
    assert.ok(quota);
    assert.equal(quota.result.mode, 'strict');
    if (quota.result.mode !== 'strict') throw new Error('unreachable');
    const { schema } = quota.result;
    // 成功分支缺字段必须拒绝（值分支精确）。
    assert.throws(() => schema.parse({ ok: true, value: {} }));
    // 错误分支接受已知码与未知码（网关透传不断信封解析）。
    schema.parse({ ok: false, error: { code: 'usageStats/busy', message: 'busy', details: { operation: 'rebuild' } } });
    schema.parse({ ok: false, error: { code: 'gateway/internal', message: 'boom', details: {} } });
  });
});

describe('remote句柄：经 get 取命名空间服务', () => {
  it('不暂存 ctx.remote：子 scope 里对暂存句柄的属性访问报 without-inject', async () => {
    // 命名空间服务桩：只有 get 能拿到，remote 上故意不挂 usageStats 属性。
    const ns = { snapshot: async () => ({ ok: true, value: {} }) };
    let alive = false;
    const fakeCtx = {
      remote: { $mount: async () => { alive = true; return async () => { alive = false; }; } },
      get: (key) => (alive && key === 'remote.usageStats' ? ns : undefined),
    };
    assert.throws(() => usageStatsRemote(), /尚未挂载/);
    const dispose = await mountUsageStatsRemote(fakeCtx);
    // 若实现改回暂存 ctx.remote 再读 .usageStats，这里拿到的是 undefined。
    assert.equal(usageStatsRemote(), ns);
    await dispose();
    assert.throws(() => usageStatsRemote(), /尚未挂载/);
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

// ---- 偏好设置：归一化、夹取、作用域存储与旧 localStorage 迁移（服务端设置文档为准）----

/** 构造设置作用域替身：持有一份快照，mutate 记录操作并按路径写回取值。 */
function fakeScope(initial) {
  const state = {
    status: initial?.status ?? 'ready',
    value: initial?.value,
    user: initial?.user,
    base: undefined,
    revision: 1,
    writable: initial?.writable ?? true,
    mode: 'host',
  };
  const listeners = new Set();
  const calls = [];
  // 快照对象引用稳定（与真实 settingsScope 的 store 一致）：状态变更时才换新对象。
  let snapshot = { ...state };
  const publish = () => {
    snapshot = { ...state };
    for (const fn of listeners) fn();
  };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    mutate: async (ops) => {
      calls.push(ops);
      for (const op of ops) {
        if (op.op === 'set') state.value = { ...state.value, [op.path[0]]: op.value };
      }
      state.user = { ...(state.user ?? {}), ...Object.fromEntries(ops.filter(o => o.op === 'set').map(o => [o.path[0], o.value])) };
      state.revision += 1;
      publish();
    },
  };
  return {
    scope,
    calls,
    state,
    listeners,
    /** 模拟异步落定：改状态并通知订阅者。 */
    apply: (patch) => { Object.assign(state, patch); publish(); },
  };
}

/** localStorage 替身：只有 getItem/removeItem 两个被用到的能力。 */
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    store: map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    removeItem: (key) => { map.delete(key); },
    has: (key) => map.has(key),
  };
}

describe('偏好设置：归一化与写入操作', () => {
  it('命名空间名与默认值自洽，坏值逐字段回退', () => {
    assert.equal(USAGE_SETTINGS_NAMESPACE, 'usage-stats');
    assert.deepEqual(normalizeUsageSettings(null), USAGE_SETTINGS_DEFAULTS);
    assert.deepEqual(normalizeUsageSettings(undefined), USAGE_SETTINGS_DEFAULTS);
    assert.deepEqual(normalizeUsageSettings({}), USAGE_SETTINGS_DEFAULTS);
    assert.deepEqual(
      normalizeUsageSettings({ goEnabled: 'on', showZaiInSidebar: 1, zaiFetchMinutes: 'soon' }),
      USAGE_SETTINGS_DEFAULTS,
    );
  });

  it('间隔夹到下限、小数取整，非有限值回退默认', () => {
    assert.equal(normalizeUsageSettings({ goFetchMinutes: 1 }).goFetchMinutes, GO_FETCH_MIN_MINUTES);
    assert.equal(normalizeUsageSettings({ goFetchMinutes: 12.6 }).goFetchMinutes, 13);
    assert.equal(normalizeUsageSettings({ goFetchMinutes: Number.NaN }).goFetchMinutes, GO_FETCH_DEFAULT_MINUTES);
    assert.equal(normalizeUsageSettings({ deepseekFetchMinutes: 0 }).deepseekFetchMinutes, DEEPSEEK_FETCH_MIN_MINUTES);
    assert.equal(normalizeUsageSettings({ zaiFetchMinutes: -5 }).zaiFetchMinutes, ZAI_FETCH_MIN_MINUTES);
    assert.equal(ZAI_FETCH_DEFAULT_MINUTES, 5);
    assert.equal(clampGoFetchMinutes(Number.POSITIVE_INFINITY), GO_FETCH_DEFAULT_MINUTES);
    assert.equal(clampDeepSeekFetchMinutes(4.4), 4);
    assert.equal(clampZaiFetchMinutes(2), ZAI_FETCH_MIN_MINUTES);
  });

  it('局部偏好只生成显式字段的路径写入，间隔先夹取', () => {
    assert.deepEqual(settingOps({ goEnabled: false }), [{ op: 'set', path: ['goEnabled'], value: false }]);
    assert.deepEqual(settingOps({ zaiFetchMinutes: 1 }), [{ op: 'set', path: ['zaiFetchMinutes'], value: ZAI_FETCH_MIN_MINUTES }]);
    assert.deepEqual(settingOps({ goEnabled: undefined, deepseekEnabled: true }), [{ op: 'set', path: ['deepseekEnabled'], value: true }]);
    assert.deepEqual(settingOps({}), []);
  });

  it('迁移只写与默认值不同的字段', () => {
    assert.deepEqual(diffFromDefaults(USAGE_SETTINGS_DEFAULTS), {});
    assert.deepEqual(
      diffFromDefaults({ ...USAGE_SETTINGS_DEFAULTS, showGoInSidebar: false, zaiFetchMinutes: 9 }),
      { showGoInSidebar: false, zaiFetchMinutes: 9 },
    );
  });
});

describe('偏好设置：作用域视图与写入', () => {
  afterEach(() => { detachUsageSettings(); });

  it('未绑定作用域时视图为默认值且不可写状态为 unavailable', () => {
    assert.deepEqual(usageSettingsView(), { settings: USAGE_SETTINGS_DEFAULTS, status: 'unavailable', writable: false });
    // 未绑定作用域：写入与订阅都不抛错
    updateUsageSettings({ goEnabled: false });
    assert.equal(typeof subscribeUsageSettings(() => {}), 'function');
  });

  it('绑定后视图取自作用域快照，同一快照引用稳定、坏值归一化', () => {
    const { scope } = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS, goFetchMinutes: 1 } });
    attachUsageSettings(scope);
    const first = usageSettingsView();
    assert.equal(first.status, 'ready');
    assert.equal(first.writable, true);
    assert.equal(first.settings.goFetchMinutes, GO_FETCH_MIN_MINUTES);
    assert.equal(usageSettingsView(), first);
  });

  it('写入走作用域 mutate，订阅转发作用域变更', async () => {
    const { scope, calls, listeners } = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS } });
    attachUsageSettings(scope);
    let notified = 0;
    const unsubscribe = subscribeUsageSettings(() => { notified += 1; });
    updateUsageSettings({ goFetchMinutes: 2, showDeepSeekInSidebar: false });
    await new Promise((r) => { setTimeout(r, 0); });
    assert.deepEqual(calls, [[
      { op: 'set', path: ['goFetchMinutes'], value: GO_FETCH_MIN_MINUTES },
      { op: 'set', path: ['showDeepSeekInSidebar'], value: false },
    ]]);
    assert.equal(notified, 1);
    unsubscribe();
    assert.equal(listeners.size, 0);
    assert.equal(usageSettingsView().settings.showDeepSeekInSidebar, false);
  });

  it('作用域落定为不可用或只读时不发注定被拒的写入，加载中照发', async () => {
    const unavailable = fakeScope({ value: undefined, status: 'unavailable' });
    attachUsageSettings(unavailable.scope);
    updateUsageSettings({ goEnabled: false });
    await new Promise((r) => { setTimeout(r, 0); });
    assert.deepEqual(unavailable.calls, []);

    const readOnly = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS }, writable: false });
    attachUsageSettings(readOnly.scope);
    updateUsageSettings({ goEnabled: false });
    await new Promise((r) => { setTimeout(r, 0); });
    assert.deepEqual(readOnly.calls, []);

    // 仍在加载：服务端可能接受，照发
    const loading = fakeScope({ value: undefined, status: 'loading' });
    attachUsageSettings(loading.scope);
    updateUsageSettings({ goEnabled: false });
    await new Promise((r) => { setTimeout(r, 0); });
    assert.deepEqual(loading.calls, [[{ op: 'set', path: ['goEnabled'], value: false }]]);
  });

  it('解绑带作用域身份：旧清理不会抹掉后挂上的新作用域（热重载）', () => {
    const first = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS, goFetchMinutes: 9 } });
    const second = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS, zaiFetchMinutes: 7 } });
    attachUsageSettings(first.scope);
    attachUsageSettings(second.scope);
    // 旧 fiber 的清理跑在新 apply 之后：只解绑自己那一个。
    detachUsageSettings(first.scope);
    assert.equal(usageSettingsView().settings.zaiFetchMinutes, 7);
    detachUsageSettings(second.scope);
    assert.deepEqual(usageSettingsView().settings, USAGE_SETTINGS_DEFAULTS);
    assert.equal(usageSettingsView().status, 'unavailable');
    // 省略参数仍是无条件解绑（测试与手动复位用）
    attachUsageSettings(first.scope);
    detachUsageSettings();
    assert.equal(usageSettingsView().status, 'unavailable');
  });

  it('解绑后写入不再落作用域，视图回退默认值', async () => {
    const { scope, calls } = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS } });
    attachUsageSettings(scope);
    detachUsageSettings();
    updateUsageSettings({ goEnabled: false });
    await new Promise((r) => { setTimeout(r, 0); });
    assert.deepEqual(calls, []);
    assert.deepEqual(usageSettingsView().settings, USAGE_SETTINGS_DEFAULTS);
  });
});

describe('偏好设置：旧 localStorage 迁移', () => {
  afterEach(() => { detachUsageSettings(); });

  it('读取旧值做归一化，坏 JSON 返回 null', () => {
    const storage = fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ goFetchMinutes: 1, zaiEnabled: false }) });
    assert.deepEqual(readLegacySettings(storage), { ...USAGE_SETTINGS_DEFAULTS, goFetchMinutes: GO_FETCH_MIN_MINUTES, zaiEnabled: false });
    assert.equal(readLegacySettings(fakeStorage({ [LEGACY_STORAGE_KEY]: '{oops' })), null);
    assert.equal(readLegacySettings(fakeStorage({})), null);
  });

  it('作用域就绪且无用户段时把旧偏好写进设置文档并删键', async () => {
    const { scope, calls } = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS } });
    const storage = fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ ...USAGE_SETTINGS_DEFAULTS, showGoInSidebar: false, zaiFetchMinutes: 9 }) });
    assert.equal(await migrateLegacySettings(scope, storage), true);
    assert.deepEqual(calls, [[
      { op: 'set', path: ['showGoInSidebar'], value: false },
      { op: 'set', path: ['zaiFetchMinutes'], value: 9 },
    ]]);
    assert.equal(storage.has(LEGACY_STORAGE_KEY), false);
  });

  it('用户已改过设置文档时不覆盖，旧键仍删除', async () => {
    const { scope, calls } = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS }, user: { goEnabled: false } });
    const storage = fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ ...USAGE_SETTINGS_DEFAULTS, showGoInSidebar: false }) });
    assert.equal(await migrateLegacySettings(scope, storage), false);
    assert.deepEqual(calls, []);
    assert.equal(storage.has(LEGACY_STORAGE_KEY), false);
  });

  it('作用域一直 loading 时等落定，超时后不写文档也不删旧键', async () => {
    const notReady = fakeScope({ value: undefined, status: 'loading' });
    const storage = fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ ...USAGE_SETTINGS_DEFAULTS, goEnabled: false }) });
    assert.equal(await migrateLegacySettings(notReady.scope, storage, 20), false);
    assert.deepEqual(notReady.calls, []);
    // 保留旧键：此刻没有可靠落点，删掉等于丢设置。
    assert.equal(storage.has(LEGACY_STORAGE_KEY), true);
  });

  it('loading 期间落定为就绪则照常迁移', async () => {
    const pending = fakeScope({ value: undefined, status: 'loading' });
    const storage = fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ ...USAGE_SETTINGS_DEFAULTS, goEnabled: false }) });
    const migrating = migrateLegacySettings(pending.scope, storage, 1_000);
    setTimeout(() => { pending.apply({ status: 'ready', value: { ...USAGE_SETTINGS_DEFAULTS } }); }, 10);
    assert.equal(await migrating, true);
    assert.deepEqual(pending.calls, [[{ op: 'set', path: ['goEnabled'], value: false }]]);
    assert.equal(storage.has(LEGACY_STORAGE_KEY), false);
  });

  it('服务端设置不可用或只读时保留旧键', async () => {
    const unavailable = fakeScope({ value: undefined, status: 'unavailable' });
    const storageA = fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ ...USAGE_SETTINGS_DEFAULTS, goEnabled: false }) });
    assert.equal(await migrateLegacySettings(unavailable.scope, storageA, 20), false);
    assert.deepEqual(unavailable.calls, []);
    assert.equal(storageA.has(LEGACY_STORAGE_KEY), true);

    const readOnly = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS }, writable: false });
    const storageB = fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ ...USAGE_SETTINGS_DEFAULTS, goEnabled: false }) });
    assert.equal(await migrateLegacySettings(readOnly.scope, storageB, 20), false);
    assert.deepEqual(readOnly.calls, []);
    assert.equal(storageB.has(LEGACY_STORAGE_KEY), true);
  });

  it('无旧键时不动作；旧值与默认值相同也不写文档', async () => {
    const { scope, calls } = fakeScope({ value: { ...USAGE_SETTINGS_DEFAULTS } });
    assert.equal(await migrateLegacySettings(scope, fakeStorage({})), false);
    const storage = fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify(USAGE_SETTINGS_DEFAULTS) });
    assert.equal(await migrateLegacySettings(scope, storage), false);
    assert.deepEqual(calls, []);
    assert.equal(storage.has(LEGACY_STORAGE_KEY), false);
    // clearLegacySettings 幂等且存储缺席时不抛错
    clearLegacySettings(storage);
    clearLegacySettings(undefined);
  });
});

// ---- 服务端偏好设置：命名空间注册与降级 ----

describe('偏好设置：服务端命名空间注册', () => {
  it('注册 usage-stats 命名空间与 schema，schema 解析值等于共享默认值', () => {
    const injected = [];
    const registered = [];
    const ctx = {
      inject: (deps, callback) => {
        injected.push(deps);
        return callback({ settings: { register: (...args) => { registered.push(args); } } });
      },
    };
    registerUsageSettings(ctx);
    assert.deepEqual(injected, [['settings']]);
    assert.equal(registered.length, 1);
    assert.equal(registered[0][0], USAGE_SETTINGS_NAMESPACE);
    assert.equal(registered[0][1], UsageSettingsSchema);
    // schema 默认值与 utils.ts 的 USAGE_SETTINGS_DEFAULTS 同源：两处漂移即失败。
    assert.deepEqual(UsageSettingsSchema({}), USAGE_SETTINGS_DEFAULTS);
    assert.deepEqual(UsageSettingsSchema({ showZaiInSidebar: false }), { ...USAGE_SETTINGS_DEFAULTS, showZaiInSidebar: false });
  });

  it('注册失败只降级偏好，不向调用方抛错（统计主职责不受影响）', () => {
    const ctx = { inject: (_deps, callback) => callback({ settings: { register: () => { throw new Error('namespace already registered'); } } }) };
    const realWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args); };
    try {
      assert.doesNotThrow(() => { registerUsageSettings(ctx); });
    } finally {
      console.warn = realWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /偏好设置命名空间注册失败/);
  });
});
