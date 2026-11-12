/**
 * 模型速度纯计算：把会话事件窗口折算成每次模型调用的样本与统计量。
 * 统计口径见 docs/ARCHITECTURE.md §7。
 *
 * 为什么读 `assistant/message` 的持久化 stream 而不是 Chat 节点：Chat 节点在历史会话里不一定
 * 带 `timing`，而消息的 stream 逐 chunk 记录了时间，刷新页面后也能复现同样的 TTFT / ATPS。
 *
 * 类型复用 @deepseek-ai/dsh-llm 与 dsh-session 的导出，这里只定义插件自己的统计结构。
 */

import type { AssistantStreamRecord, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

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
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}
