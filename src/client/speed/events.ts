/**
 * 会话事件窗口 → 速度汇总的折叠与增量存储。
 *
 * 为什么只读 durable 事件：`assistant/live-chunk` 等 transient 条目在调用完成前并不完整，
 * 统计只在 `assistant/message` 落盘后发生；重试步则借用 `assistant/attempt` 的首 token
 * 时间，让 TTFT 从 step 起点算起（与 dsh 自身口径一致）。
 *
 * 同一条窗口顺带喂给 phase.ts 的阶段判定器：step/start、tool/call、tool/result、compaction/*
 * 这些不影响统计的事件在阶段变化时也要通知 React，调用完成才通知统计。
 */

import { PhaseTracker, type SessionPhase } from './phase.ts';
import { EMPTY_SPEED_SUMMARY as EMPTY_SUMMARY, firstTokenTimeOf, speedSampleOfMessage, summarizeSamples, type SpeedSample, type SpeedSummary } from './stats.ts';

import type { SessionEventSource, SessionEventLikeEntry, SessionEventWindow, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

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
  ...EMPTY_SUMMARY,
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
