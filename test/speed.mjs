/**
 * 模型速度纯逻辑单测：事件折叠、统计口径、格式化、图表几何、增量存储、阶段判定与历史分页。
 * 运行 `node --experimental-strip-types test/speed.mjs`（类型剥离，直接 import 源码 TS）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildChartGeometry,
  createSpeedStore,
  drainOlderHistory,
  firstTokenTimeOf,
  formatRate,
  formatTtft,
  PhaseTracker,
  SpeedFold,
  summarizeEvents,
  summarizeSamples,
} from '../src/client/modelSpeed.ts';

/** durable step/start 条目。 */
function step(turn, stepNo, time) {
  return { type: 'event', event: { type: 'step/start', time, data: { turn, step: stepNo } } };
}

/** durable assistant/message 条目；first 为首 token 时间，缺省时不产生 token。 */
function message({ turn = 1, step = 1, time, first, output, stream }) {
  const records = stream ?? (first === undefined
    ? [{ type: 'chunk', time, chunk: { type: 'text-delta', index: 0, text: '' } }]
    : [{ type: 'chunk', time: first, chunk: { type: 'text-delta', index: 0, text: 'x' } }]);
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      time,
      data: {
        turn,
        step,
        message: { role: 'assistant', content: [], source: { kind: 'model' } },
        stream: records,
        usage: output === undefined ? undefined : { inputTokens: 10, outputTokens: output },
      },
    },
  };
}

/** durable assistant/attempt 条目（失败/重试尝试的 stream）。 */
function attempt({ turn = 1, step = 1, first, time }) {
  return {
    type: 'event',
    event: {
      type: 'assistant/attempt',
      time,
      data: {
        turn,
        step,
        stream: [{ type: 'chunk', time: first, chunk: { type: 'text-delta', index: 0, text: 'x' } }],
      },
    },
  };
}

/** 客户端即时出现的 live chunk 条目（应被忽略）。 */
function liveChunk(time) {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      time,
      seq: 99,
      data: { attemptId: 'a', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } },
    },
  };
}

describe('summarizeEvents', () => {
  it('逐次折算 TTFT/ATPS，TTFT 等权平均、ATPS 加权平均', () => {
    const summary = summarizeEvents([
      step(1, 1, 1_000),
      message({ time: 2_100, first: 1_100, output: 50 }),
      step(1, 2, 3_000),
      message({ turn: 1, step: 2, time: 4_200, first: 3_200, output: 25 }),
      step(1, 3, 5_000),
      message({ turn: 1, step: 3, time: 5_800, first: 5_300, output: 10 }),
    ]);
    assert.equal(summary.calls, 3);
    assert.deepEqual(summary.samples.map((sample) => sample.ttftMs), [100, 200, 300]);
    assert.deepEqual(summary.ttft, { average: 200, last: 300, min: 100, max: 300 });
    // ATPS 用整次调用总用时：50/1.1 + 25/1.2 + 10/0.8，加权后 85/3.1s
    assert.deepEqual(summary.samples.map((sample) => sample.totalMs), [1_100, 1_200, 800]);
    assert.deepEqual(summary.samples.map((sample) => sample.atps), [50 / 1.1, 25 / 1.2, 10 / 0.8]);
    assert.deepEqual(summary.atps, { average: 85 / 3.1, last: 10 / 0.8, min: 10 / 0.8, max: 50 / 1.1 });
  });

  it('缺少 step/start 或 usage 时记为不可测量', () => {
    const summary = summarizeEvents([
      message({ time: 1_000, first: 900, output: 30 }), // 无 step/start
      step(1, 2, 2_000),
      message({ turn: 1, step: 2, time: 2_500, first: 2_300 }), // 无 usage
      step(1, 3, 3_000),
      message({ turn: 1, step: 3, time: 3_500, first: 3_500, output: 30 }), // 解码 0
      step(1, 4, 4_000),
      message({ turn: 1, step: 4, time: 5_000, first: 4_200, output: 40 }),
    ]);
    assert.equal(summary.calls, 4);
    assert.deepEqual(summary.samples.map((sample) => sample.ttftMs), [null, 300, 500, 200]);
    assert.deepEqual(summary.ttft, { average: 1_000 / 3, last: 200, min: 200, max: 500 });
    // 没有 step/start 或 usage 时 ATPS 不可测量；首 token 与消息同时刻但总用时有效时仍可测。
    assert.deepEqual(summary.samples.map((sample) => sample.atps), [null, null, 60, 40]);
    assert.deepEqual(summary.atps, { average: 70 / 1.5, last: 40, min: 40, max: 60 });
  });

  it('重试步用第一次 attempt 的首 token 计算 TTFT（与 dsh 口径一致）', () => {
    const summary = summarizeEvents([
      step(1, 1, 1_000),
      attempt({ first: 1_200, time: 1_300 }),
      message({ time: 2_200, first: 1_500, output: 20 }),
    ]);
    assert.equal(summary.calls, 1);
    assert.equal(summary.samples[0].ttftMs, 200);
    // ATPS 从 step/start 算到消息结束（含重试等待）：20 tokens / 1.2s
    assert.equal(summary.samples[0].totalMs, 1_200);
    assert.equal(summary.samples[0].atps, 20 / 1.2);
  });

  it('忽略 transient live chunk，空窗口返回空汇总', () => {
    assert.deepEqual(summarizeEvents([]), { samples: [], calls: 0, ttft: null, atps: null });
    const summary = summarizeEvents([step(1, 1, 0), liveChunk(50), message({ time: 1_000, first: 100, output: 10 })]);
    assert.equal(summary.calls, 1);
  });
});

describe('firstTokenTimeOf', () => {
  it('识别 raw delta 与打包 delta run 的第一个非空片段', () => {
    assert.equal(firstTokenTimeOf([
      { type: 'chunk', time: 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'chunk', time: 120, chunk: { type: 'text-delta', index: 0, text: '' } },
      { type: 'chunk', time: 130, chunk: { type: 'text-delta', index: 0, text: 'a' } },
    ]), 130);
    assert.equal(firstTokenTimeOf([
      { type: 'text-chunks', time0: 1_000, index: 0, dt: [10, 20], texts: ['', 'a', 'b'] },
    ]), 1_010);
    assert.equal(firstTokenTimeOf([
      { type: 'tool-call-chunks', time0: 2_000, index: 0, dt: [], id: 'call', name: 'bash', args: [''] },
    ]), 2_000);
    assert.equal(firstTokenTimeOf([]), null);
  });
});

describe('SpeedFold / createSpeedStore', () => {
  it('增量 append 只在调用完成时通知，step/start 与 live chunk 不通知', () => {
    let snapshot = {
      entries: [step(1, 1, 0), message({ time: 1_000, first: 100, output: 10 })],
      hasMore: false,
      revision: 0,
      change: { kind: 'replace', entries: [] },
    };
    const listeners = new Set();
    const source = {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const publish = (entries, change) => {
      snapshot = { entries: [...snapshot.entries, ...entries], hasMore: false, revision: snapshot.revision + 1, change };
      for (const listener of listeners) listener();
    };
    const handle = createSpeedStore(source);
    const seen = [];
    handle.store.subscribe(() => seen.push(handle.store.getSnapshot().calls));
    assert.equal(handle.store.getSnapshot().calls, 1);

    publish([step(1, 2, 2_000)], { kind: 'append', entries: [step(1, 2, 2_000)] });
    assert.deepEqual(seen, [], 'step/start 不应触发通知');
    publish([liveChunk(2_500)], { kind: 'append', entries: [liveChunk(2_500)] });
    assert.deepEqual(seen, [], 'live chunk 不应触发通知');
    const before = handle.store.getSnapshot();
    const done = message({ turn: 1, step: 2, time: 3_000, first: 2_200, output: 20 });
    publish([done], { kind: 'append', entries: [done] });
    assert.deepEqual(seen, [2], '调用完成应通知一次');
    assert.equal(handle.store.getSnapshot().calls, 2);
    // 旧快照的 samples 不能被后续 append 污染（否则图表 useMemo 会冻结）。
    assert.equal(before.samples.length, 1);
    assert.notEqual(before.samples, handle.store.getSnapshot().samples);

    handle.dispose();
  });

  it('settle-assistant 携带 durable message 时才计入调用', () => {
    const start = step(1, 1, 0);
    let snapshot = { entries: [start], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } };
    const listeners = new Set();
    const source = {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const handle = createSpeedStore(source);
    const done = message({ time: 1_000, first: 100, output: 10 });
    snapshot = {
      entries: [start, done],
      hasMore: false,
      revision: 1,
      change: { kind: 'settle-assistant', attemptId: 'a', entry: done },
    };
    for (const listener of listeners) listener();
    assert.equal(handle.store.getSnapshot().calls, 1);
    assert.equal(handle.store.getSnapshot().ttft.last, 100);
    handle.dispose();
  });

  it('reset 用完整窗口重建（处理前插历史与窗口替换）', () => {
    const fold = new SpeedFold([step(1, 1, 0), message({ time: 1_000, first: 100, output: 10 })]);
    assert.equal(fold.current.calls, 1);
    fold.reset([
      step(1, 1, 0),
      message({ time: 1_000, first: 100, output: 10 }),
      step(1, 2, 2_000),
      message({ turn: 1, step: 2, time: 3_000, first: 2_100, output: 20 }),
    ]);
    assert.equal(fold.current.calls, 2);
    assert.equal(fold.current.ttft.last, 100);
    assert.equal(fold.current.atps.last, 20 / 1);
  });
});

describe('格式化', () => {
  it('TTFT 按毫秒/秒切换精度', () => {
    assert.equal(formatTtft(0), '0ms');
    assert.equal(formatTtft(849.6), '850ms');
    assert.equal(formatTtft(1_000), '1.00s');
    assert.equal(formatTtft(12_340), '12.3s');
    assert.equal(formatTtft(Number.POSITIVE_INFINITY), '—');
  });

  it('tok/s 在 100 以上取整', () => {
    assert.equal(formatRate(8.44), '8.4');
    assert.equal(formatRate(42.25), '42.3');
    assert.equal(formatRate(127.8), '128');
    assert.equal(formatRate(Number.NaN), '—');
  });

  it('summarizeSamples 对空样本返回 null 指标', () => {
    assert.deepEqual(summarizeSamples([]), { samples: [], calls: 0, ttft: null, atps: null });
  });

  it('输出快照的 samples 是副本，不受源数组后续变更影响', () => {
    const source = [{ index: 1, time: 1, ttftMs: 100, atps: 8, outputTokens: 10, totalMs: 1_250 }];
    const summary = summarizeSamples(source);
    source.push({ index: 2, time: 2, ttftMs: 200, atps: 16, outputTokens: 20, totalMs: 1_250 });
    assert.equal(summary.samples.length, 1);
    assert.equal(summary.calls, 1);
  });
});

describe('PhaseTracker', () => {
  it('生成中 / 工具调用中 / 空闲随 running 与工具结果切换', () => {
    const tracker = new PhaseTracker();
    assert.equal(tracker.phase(false), 'idle');
    tracker.apply({ type: 'step/start', time: 1, data: { turn: 1, step: 1 } });
    assert.equal(tracker.phase(true), 'generating');
    assert.equal(tracker.phase(false), 'idle');
    tracker.apply({
      type: 'tool/call',
      time: 2,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' },
    });
    assert.equal(tracker.phase(true), 'tools');
    tracker.apply({
      type: 'tool/result',
      time: 3,
      data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [] } },
    });
    assert.equal(tracker.phase(true), 'generating');
  });

  it('上下文压缩进行中与完成后', () => {
    const tracker = new PhaseTracker();
    tracker.apply({ type: 'compaction/start', time: 1, data: {} });
    assert.equal(tracker.phase(true), 'compacting');
    assert.equal(tracker.phase(false), 'idle');
    tracker.apply({ type: 'compaction/end', time: 2, data: {} });
    assert.equal(tracker.phase(false), 'compacted');
    assert.equal(tracker.phase(true), 'compacted');
    tracker.apply({ type: 'step/start', time: 3, data: { turn: 1, step: 1 } });
    assert.equal(tracker.phase(true), 'generating');
    assert.equal(tracker.phase(false), 'idle');
  });
});

describe('buildChartGeometry', () => {
  const samples = [0, 1, 2, 3].map((index) => ({
    index: index + 1,
    time: index,
    ttftMs: index === 1 ? null : 100 * (index + 1),
    atps: index === 3 ? null : 5 * (index + 1),
    outputTokens: 10,
    totalMs: 1_400,
  }));

  it('只给有效值画柱/点，TTFT 断点处断开折线', () => {
    const geometry = buildChartGeometry(samples, 272, 88);
    assert.equal(geometry.bars.length, 3);
    assert.equal(geometry.dots.length, 3);
    assert.equal(geometry.segments.length, 1);
    assert.equal(geometry.hits.length, 4);
    assert.equal(geometry.hits[0].width, geometry.hits[1].width);
    assert.ok(geometry.baseline > 0 && geometry.baseline < 88);
    assert.ok(geometry.midline > 0 && geometry.midline < geometry.baseline);
    for (const bar of geometry.bars) {
      assert.ok(bar.x >= 0 && bar.x + bar.width <= 272);
      assert.ok(bar.y >= 0 && bar.y + bar.height <= geometry.baseline + 0.01);
      assert.ok(bar.width >= 2);
    }
  });

  it('空样本与非法尺寸返回空几何', () => {
    const empty = { bars: [], segments: [], dots: [], hits: [], baseline: 0, midline: 0 };
    assert.deepEqual(buildChartGeometry([], 272, 88), empty);
    assert.deepEqual(buildChartGeometry(samples, 0, 88), empty);
  });
});


describe('speed：历史分页读完', () => {
  /** 造一个按页返回条目的会话面；页为每页新增的条目数。 */
  function historySession(pages, { open = 'open', noProgress = false } = {}) {
    let loaded = 0;
    let calls = 0;
    let pageIndex = 0;
    let hasMore = pages.length > 0;
    const session = {
      getSnapshot: () => ({ openState: open, hasMore, loadingOlder: false }),
      async loadOlder() {
        calls += 1;
        if (noProgress) return;
        const page = pages[pageIndex];
        if (page === undefined) { hasMore = false; return; }
        pageIndex += 1;
        loaded += page;
        hasMore = pageIndex < pages.length;
      },
    };
    return { session, loaded: () => loaded, calls: () => calls };
  }

  it('逐页读到 hasMore 为 false', async () => {
    const fake = historySession([2, 3, 4]);
    await drainOlderHistory(fake.session, fake.loaded, () => false);
    assert.equal(fake.loaded(), 9);
    assert.equal(fake.calls(), 3);
  });

  it('取消后不再继续加载', async () => {
    const fake = historySession([2, 3, 4]);
    await drainOlderHistory(fake.session, fake.loaded, () => fake.calls() >= 1);
    assert.equal(fake.loaded(), 2);
    assert.equal(fake.calls(), 1);
  });

  it('会话未打开时不加载', async () => {
    const fake = historySession([2, 3], { open: 'loading' });
    await drainOlderHistory(fake.session, fake.loaded, () => false);
    assert.equal(fake.calls(), 0);
  });

  it('一页没有进展时退出，避免空转', async () => {
    const fake = historySession([2, 3], { noProgress: true });
    await drainOlderHistory(fake.session, fake.loaded, () => false);
    assert.equal(fake.calls(), 1);
  });
});
