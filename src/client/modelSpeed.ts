/**
 * 模型速度纯逻辑：把会话事件窗口折叠成每次调用的 TTFT / ATPS 样本与汇总，附带阶段判定与详情卡图表几何。
 * 统计口径见 docs/ARCHITECTURE.md §7；不 import React，组件只负责画。
 *
 * 为什么读 `assistant/message` 的持久化 stream 而不是 Chat 节点：Chat 节点在历史会话里不一定
 * 带 `timing`，而消息的 stream 逐 chunk 记录了时间，刷新页面后也能复现同样的 TTFT / ATPS。
 *
 * 为什么只读 durable 事件：`assistant/live-chunk` 等 transient 条目在调用完成前并不完整，
 * 统计只在 `assistant/message` 落盘后发生；重试步则借用 `assistant/attempt` 的首 token
 * 时间，让 TTFT 从 step 起点算起（与 dsh 自身口径一致）。同一条窗口顺带喂给阶段判定器：
 * step/start、tool/call、tool/result、compaction/* 这些不影响统计的事件在阶段变化时也要
 * 通知 React，调用完成才通知统计。
 */

import { clamp, round1 } from '../utils.ts';

import type { SessionEventSource, SessionEventLikeEntry, SessionEventWindow, SessionFace, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { AssistantStreamRecord, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

// ---- 统计口径：事件窗口 → 每次调用的样本与汇总 ----

/** 一次模型调用的速度样本。 */
export interface SpeedSample {
  /** 在本次统计范围内的调用序号（从 1 开始）。 */
  index: number;
  /** `assistant/message` 的时间（Unix epoch ms）。 */
  time: number;
  /** 首 token 延迟（ms）；未记录时为 null。 */
  ttftMs: number | null;
  /** 整次调用的平均输出速度（输出 tokens ÷ 总用时，tok/s）；不可测量时为 null。 */
  atps: number | null;
  /** provider 报告的输出 tokens；无 usage 时为 null。 */
  outputTokens: number | null;
  /** 整次调用的总用时（ms，`step/start` → `assistant/message`）；缺 step/start 时为 null。 */
  totalMs: number | null;
}

/** 一个指标在有效样本上的汇总。 */
export interface MetricSummary {
  /** 平均：TTFT 为等权平均，ATPS 为加权平均（见 docs/ARCHITECTURE.md §7）。 */
  average: number;
  /** 最后一次有有效值的调用。 */
  last: number;
  min: number;
  max: number;
}

/** 当前会话的完整速度汇总。 */
export interface SpeedSummary {
  /** 全部模型调用，按事件顺序排列。 */
  samples: readonly SpeedSample[];
  /** TTFT 汇总；没有有效样本时为 null。 */
  ttft: MetricSummary | null;
  /** ATPS 汇总；没有有效样本时为 null。 */
  atps: MetricSummary | null;
  /** 调用总数。 */
  calls: number;
}

/** 空汇总常量：多次读取保持同一引用，供 useSyncExternalStore 使用。 */
export const EMPTY_SPEED_SUMMARY: SpeedSummary = Object.freeze({
  samples: Object.freeze([]) as readonly SpeedSample[],
  ttft: null,
  atps: null,
  calls: 0,
});

/** provider 报告的 outputTokens；字段不是有限非负数时视为不可用。 */
export function outputTokensOf(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const value = (usage as Partial<TokenUsage>).outputTokens;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 单个 chunk 是否携带模型的第一个输出 token（与 dsh 的 isTokenDelta 同口径）。 */
function chunkIsTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== '';
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined;
    default:
      return false;
  }
}

/** 紧凑 stream 里第一个 token 增量的时间；没有 token 时返回 null。 */
export function firstTokenTimeOf(stream: readonly AssistantStreamRecord[]): number | null {
  for (const record of stream) {
    if (record.type === 'chunk') {
      if (chunkIsTokenDelta(record.chunk)) return record.time;
      continue;
    }
    // 打包的 delta run：time0 是第一个片段的时间，后续片段用 dt 累加。
    if (record.type === 'tool-call-chunks' && record.name !== undefined) return record.time0;
    const fragments = record.type === 'tool-call-chunks' ? record.args : record.texts;
    let time = record.time0;
    for (let index = 0; index < fragments.length; index += 1) {
      if (index > 0) time += record.dt[index - 1] as number;
      if ((fragments[index] as string) !== '') return time;
    }
  }
  return null;
}

/**
 * 把一个 `assistant/message` 事件折算成速度样本。
 * @param event - 已完成的 assistant 消息事件。
 * @param stepStartTime - 该调用对应的 `step/start` 时间；窗口外加载不到时为 undefined。
 * @param index - 1 起的调用序号。
 * @param firstTokenTime - 该 step 的首 token 时间（可能来自更早的 assistant/attempt）；
 *   省略时取本条消息自己的 stream。
 */
export function speedSampleOfMessage(
  event: SessionEvent<'assistant/message'>,
  stepStartTime: number | undefined,
  index: number,
  firstTokenTime: number | null = firstTokenTimeOf(event.data.stream),
): SpeedSample {
  const outputTokens = outputTokensOf(event.data.usage);
  let ttftMs: number | null = null;
  if (stepStartTime !== undefined && firstTokenTime !== null) {
    ttftMs = Math.max(0, firstTokenTime - stepStartTime);
  }
  const totalMs = stepStartTime === undefined ? null : Math.max(0, event.time - stepStartTime);
  let atps: number | null = null;
  if (outputTokens !== null && totalMs !== null && totalMs > 0) {
    atps = outputTokens / (totalMs / 1_000);
  }
  return { index, time: event.time, ttftMs, atps, outputTokens, totalMs };
}

/** 在有效值上计算平均/最近/最小/最大；TTFT 与 ATPS 的平均口径不同，由调用方传入。 */
function metricOf(values: readonly number[], average: number): MetricSummary | null {
  if (values.length === 0) return null;
  let min = values[0] as number;
  let max = values[0] as number;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { average, last: values[values.length - 1] as number, min, max };
}

/** 汇总样本：TTFT 等权平均，ATPS 按 token/总用时加权（口径见 docs/ARCHITECTURE.md §7）。 */
export function summarizeSamples(samples: readonly SpeedSample[]): SpeedSummary {
  const ttftValues = samples.flatMap((sample) => (sample.ttftMs === null ? [] : [sample.ttftMs]));
  const atpsValues = samples.flatMap((sample) => (sample.atps === null ? [] : [sample.atps]));
  let ttftAverage = 0;
  if (ttftValues.length > 0) ttftAverage = ttftValues.reduce((sum, value) => sum + value, 0) / ttftValues.length;
  let totalMs = 0;
  let atpsWeighted = 0;
  for (const sample of samples) {
    if (sample.atps !== null && sample.totalMs !== null && sample.totalMs > 0) {
      totalMs += sample.totalMs;
      atpsWeighted += sample.atps * sample.totalMs;
    }
  }
  let atpsAverage = 0;
  if (totalMs > 0) {
    atpsAverage = atpsWeighted / totalMs;
  } else if (atpsValues.length > 0) {
    atpsAverage = atpsValues.reduce((sum, value) => sum + value, 0) / atpsValues.length;
  }
  return {
    // 对外快照必须不可变：store 的 samples 是内部可变数组，直接暴露会让旧快照随
    // 后续调用增长，也让 React 的依赖比较永远命中同一引用（图表会冻结）。
    samples: [...samples],
    calls: samples.length,
    ttft: metricOf(ttftValues, ttftAverage),
    atps: metricOf(atpsValues, atpsAverage),
  };
}

// ---- 历史分页 ----

/** 分页读历史所需的最小会话能力：会话状态快照 + 载入更早一页。 */
export type HistoryPager = Pick<SessionFace, 'getSnapshot' | 'loadOlder'>;

/**
 * 把会话历史一页页读完：DSH 首次只加载尾部 50 条消息，滚动到顶才继续加载；
 * 模型速度要覆盖整条会话，因此挂载后主动补齐，读数随每页到达逐步变大。
 * @param session - 已打开的会话面。
 * @param loadedEntries - 当前事件窗口的条目数，用于判断一页是否真的载入。
 * @param cancelled - 卸载或切走会话后停止。
 */
export async function drainOlderHistory(
  session: HistoryPager,
  loadedEntries: () => number,
  cancelled: () => boolean,
): Promise<void> {
  for (;;) {
    if (cancelled()) return;
    const snapshot = session.getSnapshot();
    if (snapshot.openState !== 'open' || !snapshot.hasMore) return;
    const before = loadedEntries();
    await session.loadOlder();
    if (cancelled()) return;
    const after = session.getSnapshot();
    if (!after.hasMore) return;
    // 没有新条目说明这一页没有进展（被替换或并发请求吞掉），退出避免空转。
    if (loadedEntries() === before) return;
  }
}

// ---- 展示格式 ----

/**
 * TTFT 的紧凑展示：1 秒内用毫秒，10 秒内保留两位小数，再长保留一位。
 * @param ms - 毫秒。
 * @returns 例如 `850ms`、`1.24s`、`12.3s`；非法值回退 `—`。
 */
export function formatTtft(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const value = Math.max(0, ms);
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
}

/**
 * 速度（tok/s）的紧凑展示：100 以上取整，其余保留一位小数。
 * @param rate - tok/s。
 * @returns 例如 `42.3`、`128`；非法值回退 `—`。
 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  const value = Math.max(0, rate);
  return value >= 100 ? String(Math.round(value)) : String(round1(value));
}

// ---- 阶段判定：状态行图标与详情卡状态文案共用的口径 ----

/**
 * 只看 durable 事件与 `binding.session` 的 running，不读 Chat 节点，历史会话回放时也能复现
 * 最后一次的阶段。compacted 只在压缩结束后还没有新请求或步骤时成立，所以除 compactionOpen
 * 之外还要记一个一次性标记。
 */

/** 会话阶段。 */
export type SessionPhase = 'generating' | 'tools' | 'compacting' | 'compacted' | 'idle';

/** 增量阶段判定器：窗口回放与实时追加共用。 */
export class PhaseTracker {
  private readonly openTools = new Set<string>();
  private compactionOpen = false;
  private compactionJustEnded = false;

  /** 清空状态（窗口替换时整体重放）。 */
  reset(): void {
    this.openTools.clear();
    this.compactionOpen = false;
    this.compactionJustEnded = false;
  }

  /** 记录一条 durable 事件。 */
  apply(event: SessionEvent): void {
    // compaction/* 不在本插件依赖的事件类型表里，按字符串判断。
    const type: string = event.type;
    if (type === 'compaction/start') {
      this.compactionOpen = true;
      this.compactionJustEnded = false;
      return;
    }
    if (type === 'compaction/end') {
      this.compactionOpen = false;
      this.compactionJustEnded = true;
      return;
    }
    if (event.type === 'tool/call') {
      this.openTools.add(String(event.data.callId));
      this.compactionJustEnded = false;
      return;
    }
    if (event.type === 'tool/result') {
      this.openTools.delete(String(event.data.message.toolCallId));
      this.compactionJustEnded = false;
      return;
    }
    if (
      event.type === 'user/message'
      || event.type === 'step/start'
      || event.type === 'assistant/message'
      || event.type === 'turn/start'
    ) {
      this.compactionJustEnded = false;
    }
  }

  /**
   * 当前阶段。
   * @param running - 会话是否在运行（`binding.session` 的 running）。
   */
  phase(running: boolean): SessionPhase {
    if (this.compactionOpen) return running ? 'compacting' : 'idle';
    if (this.compactionJustEnded) return 'compacted';
    if (!running) return 'idle';
    if (this.openTools.size > 0) return 'tools';
    return 'generating';
  }
}

// ---- 折叠与增量存储 ----

/** 一个 step 的边界（起点 + 已经出现过的首 token）。 */
interface StepBoundary {
  startTime: number;
  firstTokenTime: number | null;
}

/** 速度汇总 + 当前会话阶段。 */
export interface SpeedSnapshot extends SpeedSummary {
  /** 当前阶段（驱动状态行图标与详情卡状态文案）。 */
  phase: SessionPhase;
}

/** 空快照：还没有任何事件时的稳定引用。 */
export const EMPTY_SPEED_SNAPSHOT: SpeedSnapshot = Object.freeze({
  ...EMPTY_SPEED_SUMMARY,
  phase: 'idle' as SessionPhase,
});

/** turn/step 组合键。 */
export function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

/**
 * 折叠一个事件窗口的全部 durable 事件。
 * @param entries - 会话事件窗口条目。
 * @returns 调用样本与汇总。
 */
export function summarizeEvents(entries: readonly SessionEventLikeEntry[]): SpeedSummary {
  const steps = new Map<string, StepBoundary>();
  const samples: SpeedSample[] = [];
  for (const entry of entries) {
    if (entry.type !== 'event') continue;
    foldEvent(entry.event, steps, samples);
  }
  return summarizeSamples(samples);
}

/** 处理一条 durable 事件；返回是否新增了一次调用。 */
function foldEvent(
  event: SessionEvent,
  steps: Map<string, StepBoundary>,
  samples: SpeedSample[],
): boolean {
  if (event.type === 'step/start') {
    steps.set(stepKey(event.data.turn, event.data.step), { startTime: event.time, firstTokenTime: null });
    return false;
  }
  if (event.type === 'assistant/attempt') {
    const step = steps.get(stepKey(event.data.turn, event.data.step));
    if (step === undefined || step.firstTokenTime !== null) return false;
    const first = firstTokenTimeOf(event.data.stream);
    if (first !== null) step.firstTokenTime = first;
    return false;
  }
  if (event.type !== 'assistant/message') return false;
  const key = stepKey(event.data.turn, event.data.step);
  const step = steps.get(key);
  const first = step?.firstTokenTime ?? firstTokenTimeOf(event.data.stream);
  samples.push(speedSampleOfMessage(event, step?.startTime, samples.length + 1, first));
  steps.delete(key);
  return true;
}

/** 增量折叠器：append 只处理新事件，replace/prepend 全量重建。 */
export class SpeedFold {
  private readonly steps = new Map<string, StepBoundary>();
  private readonly samples: SpeedSample[] = [];
  private readonly tracker = new PhaseTracker();
  private summary: SpeedSummary = summarizeSamples(this.samples);

  /** @param entries - 初始窗口（通常是首次加载的完整历史）。 */
  constructor(entries: readonly SessionEventLikeEntry[]) {
    this.reset(entries);
  }

  /** 当前汇总（引用随每次调用完成而变化；samples 是不可变副本）。 */
  get current(): SpeedSummary {
    return this.summary;
  }

  /**
   * 当前会话阶段。
   * @param running - 会话是否在运行。
   */
  phase(running: boolean): SessionPhase {
    return this.tracker.phase(running);
  }

  /** 全量重建。 */
  reset(entries: readonly SessionEventLikeEntry[]): void {
    this.steps.clear();
    this.samples.length = 0;
    this.tracker.reset();
    for (const entry of entries) {
      if (entry.type !== 'event') continue;
      this.tracker.apply(entry.event);
      foldEvent(entry.event, this.steps, this.samples);
    }
    this.summary = summarizeSamples(this.samples);
  }

  /** 追加一条窗口条目；返回是否新增了一次调用。 */
  appendEntry(entry: SessionEventLikeEntry): boolean {
    if (entry.type !== 'event') return false;
    return this.appendEvent(entry.event);
  }

  /** 追加一条 durable 事件；返回是否新增了一次调用。 */
  appendEvent(event: SessionEvent): boolean {
    this.tracker.apply(event);
    const changed = foldEvent(event, this.steps, this.samples);
    if (changed) this.summary = summarizeSamples(this.samples);
    return changed;
  }
}

/** 可被 React 订阅的速度存储（复用 client-store 的可观察快照契约）。 */
export type SpeedStore = ObservableSnapshot<SpeedSnapshot>;

/** 存储句柄：store 给 UI，dispose 解绑会话事件源。 */
export interface SpeedStoreHandle {
  store: SpeedStore;
  dispose: () => void;
}

/**
 * 为一个会话事件源创建增量速度存储。
 * 调用完成（新增 assistant/message）或阶段变化时通知订阅者；流式 chunk 不会引起重渲染。
 * @param source - 会话事件窗口。
 * @param session - 会话快照（提供 running）；省略时按未运行处理。
 * @returns store 与解绑函数。
 */
export function createSpeedStore(
  source: SessionEventSource,
  session?: ObservableSnapshot<SessionSnapshot>,
): SpeedStoreHandle {
  const initial: SessionEventWindow = source.getSnapshot();
  const fold = new SpeedFold(initial.entries);
  let revision = initial.revision;
  const listeners = new Set<() => void>();
  const running = (): boolean => session?.getSnapshot().running === true;
  let current: SpeedSnapshot = { ...fold.current, phase: fold.phase(running()) };

  const publish = (): void => {
    for (const listener of [...listeners]) listener();
  };

  /** 重算快照；只有统计或阶段真的变了才通知。 */
  const refresh = (): void => {
    const next: SpeedSnapshot = { ...fold.current, phase: fold.phase(running()) };
    if (next.samples === current.samples && next.phase === current.phase) return;
    current = next;
    publish();
  };

  const update = (): void => {
    const window = source.getSnapshot();
    if (window.revision === revision) return;
    revision = window.revision;
    const { change } = window;
    if (change.kind === 'replace' || change.kind === 'prepend') {
      fold.reset(window.entries);
      refresh();
      return;
    }
    if (change.kind === 'append') {
      for (const entry of change.entries) fold.appendEntry(entry);
    } else if (change.kind === 'settle-assistant') {
      const entry = change.entry;
      if (entry !== undefined) fold.appendEntry(entry);
    }
    refresh();
  };

  const disposeSource = source.subscribe(update);
  const disposeSession = session?.subscribe(refresh) ?? (() => {});
  return {
    store: {
      getSnapshot: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    dispose: () => {
      disposeSource();
      disposeSession();
    },
  };
}

// ---- 详情卡图表几何 ----

/**
 * 每次调用一根 ATPS 柱 + TTFT 折线，两套纵轴各自缩放；只输出数字与 SVG 点串，组件只负责画。
 */

/** 一根 ATPS 柱。 */
export interface ChartBar {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 对应样本下标（从 0 开始）。 */
  sample: number;
}

/** 一次调用的整列命中区（透明矩形，便于鼠标悬停到细柱）。 */
export interface ChartHit {
  x: number;
  width: number;
  /** 对应样本下标（从 0 开始）。 */
  sample: number;
}

/** 一个 TTFT 折线点。 */
export interface ChartDot {
  cx: number;
  cy: number;
  /** 对应样本下标（从 0 开始）。 */
  sample: number;
}

/** 图表几何结果。 */
export interface ChartGeometry {
  bars: readonly ChartBar[];
  /** 连续有效 TTFT 点组成的折线段（点为 `x,y`）。 */
  segments: readonly string[];
  dots: readonly ChartDot[];
  /** 每个样本一列透明命中区。 */
  hits: readonly ChartHit[];
  /** 横轴基线 y。 */
  baseline: number;
  /** 中间参考线 y。 */
  midline: number;
}

/** 图表内边距：左右贴边，顶部留一点给圆点，底部留基线空间。 */
const PAD_X = 2;
const PAD_TOP = 7;
const PAD_BOTTOM = 5;

/**
 * 计算柱与折线的坐标。
 * @param samples - 全部调用样本，顺序即横轴。
 * @param width - SVG 视图宽度。
 * @param height - SVG 视图高度。
 * @returns 柱、折线段与圆点。
 */
export function buildChartGeometry(
  samples: readonly SpeedSample[],
  width: number,
  height: number,
): ChartGeometry {
  const plotHeight = Math.max(1, height - PAD_TOP - PAD_BOTTOM);
  if (samples.length === 0 || width <= 0 || height <= 0) {
    return { bars: [], segments: [], dots: [], hits: [], baseline: 0, midline: 0 };
  }
  const baseline = PAD_TOP + plotHeight;
  const slot = (width - PAD_X * 2) / samples.length;
  const barWidth = clamp(slot * 0.54, 2, 14);

  const hits: ChartHit[] = samples.map((_, index) => ({ x: PAD_X + slot * index, width: slot, sample: index }));
  const maxTtft = Math.max(1, ...samples.map((sample) => sample.ttftMs ?? 0)) * 1.08;
  const maxAtps = Math.max(0.1, ...samples.map((sample) => sample.atps ?? 0)) * 1.08;

  const bars: ChartBar[] = [];
  const dots: ChartDot[] = [];
  const segments: string[] = [];
  let run: string[] = [];

  const flush = (): void => {
    if (run.length >= 2) segments.push(run.join(' '));
    run = [];
  };

  samples.forEach((sample, index) => {
    const center = PAD_X + slot * (index + 0.5);
    if (sample.atps !== null) {
      const barHeight = Math.max(1, (sample.atps / maxAtps) * plotHeight);
      bars.push({
        x: round1(center - barWidth / 2),
        y: round1(baseline - barHeight),
        width: round1(barWidth),
        height: round1(barHeight),
        sample: index,
      });
    }
    if (sample.ttftMs !== null) {
      const y = round1(baseline - (sample.ttftMs / maxTtft) * plotHeight);
      dots.push({ cx: round1(center), cy: y, sample: index });
      run.push(`${round1(center)},${y}`);
    } else {
      flush();
    }
  });
  flush();

  return { bars, segments, dots, hits, baseline, midline: PAD_TOP + plotHeight / 2 };
}
