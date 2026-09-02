/**
 * 聚合口径与纯函数：Agg、SessionInfo 结构，折叠原子操作 newAgg、ink，
 * 事件守卫 usable、modelKeyOf。本地日划分 startOfDay 在 utils.ts，
 * host 与 client 共用，避免两处定义漂移。
 *
 * 本模块是纯逻辑：不依赖 ctx / store / I/O，便于单测。
 *
 * 统计口径：assistant/message 事件且其 data.usage.inputTokens 为数字；
 * total = input + output + cacheRead + cacheWrite，reasoning 单列，不计入 total。
 */
import type { Agg } from '../types.ts';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

/** 聚合计数结构定义在 types.ts，与 client 端 UsageAgg 统一。 */
export type { Agg } from '../types.ts';

/** 会话级状态：聚合与去重水位，title、cwd、createdAt 在账本 meta。 */
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

/** 类型守卫：携带可折叠 usage 的 assistant/message 事件。 */
export function usable(
  event: SessionEvent,
): event is SessionEvent<'assistant/message'> & { data: { usage: TokenUsage } } {
  const usage = (event as { data?: { usage?: unknown } })?.data?.usage;
  return event.type === 'assistant/message' && usage != null && typeof usage === 'object';
}

/** assistant/message 事件的模型身份：provider 与 model 以 \0 分隔，缺失记 unknown。 */
export function modelKeyOf(event: SessionEvent<'assistant/message'>): string {
  const source = (event as { data?: { message?: { source?: { provider?: unknown; model?: unknown } } } })?.data?.message?.source;
  const provider = typeof (source as { provider?: unknown })?.provider === 'string' && (source as { provider: string }).provider ? (source as { provider: string }).provider : 'unknown';
  const model = typeof (source as { model?: unknown })?.model === 'string' && (source as { model: string }).model ? (source as { model: string }).model : 'unknown';
  return provider + '\u0000' + model;
}
