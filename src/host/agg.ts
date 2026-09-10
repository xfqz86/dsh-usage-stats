/**
 * 聚合口径与纯函数：Agg、SessionInfo 结构，折叠原子操作 newAgg、ink，
 * 事件守卫 usable、modelKeyOf。本地日划分 startOfDay 在 utils.ts，
 * host 与 client 共用，避免两处定义漂移。
 *
 * 本模块是纯逻辑：不依赖 ctx / store / I/O，便于单测。
 *
 * 统计口径：带 provider 上报用量（data.usage 为对象）的计量事件即视为可用，
 * 共两类——对话调用 assistant/message（模型身份在 data.message.source）与
 * 压缩调用 compaction/summary（模型身份在 data.provider/data.model）。
 * 数值归一（非有限/负数按 0、向下取整）在 ledger 层完成；
 * total = input + output + cacheRead + cacheWrite，reasoning 单列，不计入 total。
 */
import type { Agg } from '../types.ts';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

/** 聚合计数结构定义在 types.ts，与 client 端 UsageAgg 统一。 */
export type { Agg } from '../types.ts';

/** 会话级状态：聚合与去重水位，标题与归属字段在账本 meta。 */
export interface SessionInfo {
  daily: Map<number, Agg>
  allAgg: Agg
  maxSeq: number
  lastActive: number
}

/** 新建空计数，所有字段归零。 */
export function newAgg(): Agg {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 };
}

/** 把一次用量折进聚合，调用次数加一。 */
export function ink(agg: Agg, u: TokenUsage): void {
  const input = u.inputTokens || 0;
  const output = u.outputTokens || 0;
  const cacheRead = u.cacheReadTokens || 0;
  const cacheWrite = u.cacheWriteTokens || 0;
  const reasoning = u.reasoningTokens || 0;
  agg.input += input;
  agg.output += output;
  agg.cacheRead += cacheRead;
  agg.cacheWrite += cacheWrite;
  agg.reasoning += reasoning;
  agg.total += input + output + cacheRead + cacheWrite;
  agg.calls += 1;
}

/**
 * 计量事件：携带 provider 上报用量事件的最小结构，用于把 usable 的判定结果
 * 传给 modelKeyOf/toLedgerEvent。是 harness `SessionEvent` 的收窄而非新结构。
 */
export type MeteredEvent = SessionEvent & { data: { usage: TokenUsage } };

/**
 * 计量事件的类型名单。assistant/attempt 不列入：其用量是流式中间态，
 * 会在同一 turn/step 的 assistant/message 上再次出现，收进来即双计。
 */
const METERED_TYPES: readonly string[] = ['assistant/message', 'compaction/summary'];

/** 类型守卫：携带 usage 候选的计量事件（零用量也为 true，是否折叠由后续判断）。 */
export function usable(event: SessionEvent): event is MeteredEvent {
  const usage = (event as { data?: { usage?: unknown } })?.data?.usage;
  return METERED_TYPES.includes(event.type) && usage != null && typeof usage === 'object';
}

/**
 * 计量事件的模型身份：provider 与 model 以 \0 分隔，缺失记 unknown。
 * 对话消息取 data.message.source，压缩摘要取 data 顶层的 provider/model。
 */
export function modelKeyOf(event: MeteredEvent): string {
  const data = (event as { data?: { message?: { source?: unknown }; provider?: unknown; model?: unknown } }).data;
  // 计量事件只有这两类，非对话即压缩摘要。压缩事件的类型声明由
  // `dsh-compaction` 的 SessionEventMap 合并提供，本包不装该包，故从对话侧分派。
  const source = event.type === 'assistant/message'
    ? data?.message?.source as { provider?: unknown; model?: unknown } | undefined
    : data as { provider?: unknown; model?: unknown } | undefined;
  const pick = (value: unknown): string => (typeof value === 'string' && value ? value : 'unknown');
  return pick(source?.provider) + '\u0000' + pick(source?.model);
}
