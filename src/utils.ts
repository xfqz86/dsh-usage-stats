/**
 * 跨端共用的纯函数，host 与 client 两个 bundle 各自内联所需子集。
 *
 * 本模块只放纯函数；协议类型 GoWindow、GoQuota、UsageAgg、Agg、
 * SeriesPoint 定义在 types.ts。这里是插件
 * 自有逻辑中「多文件共用」部分的单一事实来源：本地日划分、NDJSON 行解析、错误消息提取、模型键拆分、Go 额度档位等。
 *
 * 设计约束：
 *   - 只允许纯 JS 运行时能力 Date、Math、JSON、String，禁止 import
 *     node 内置模块，会破坏浏览器端 bundle，或 react、harness 包，会破坏
 *     服务端 bundle；
 *   - 归属说明：聚合口径与折叠 agg.ts、store.ts，账本存储 ledger.ts，
 *     会话发现 logs.ts，客户端格式化、分桶、图表几何 client/stats.ts
 *     等仍留在各自模块，这里只放「多文件共用的」部分。
 */
import type { GoWindow } from './types.ts';

/** 时间戳对应的本地零点，避免 UTC 漂移，host 折叠与会话图共用同一套日划分。 */
export function startOfDay(timeMs: number): number {
  const d = new Date(timeMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地日期键 YYYY-MM-DD，账本事件分片名与客户端日期标签共用。 */
export function dateKeyOf(t: number): string {
  const d = new Date(t);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 任意异常 → 可读消息字符串，Error 取 message，对象取 message 字段，其余原样字符串化。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(error);
}

/** 解析一行 NDJSON：修剪空白后 JSON.parse；空行、坏行返回 null，不中断调用方读取。 */
export function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 把 `provider\0model` 键拆回 provider 与 model，无分隔符时都记 unknown。 */
export function splitModelKey(key: string): { provider: string; model: string } {
  const sep = key.indexOf('\u0000');
  if (sep === -1) return { provider: 'unknown', model: 'unknown' };
  return { provider: key.slice(0, sep), model: key.slice(sep + 1) };
}

/** 用量百分比四舍五入并夹在 0..100，底部角标与模态窗进度条共用。 */
export function goPercent(win: GoWindow): number {
  return Math.round(Math.max(0, Math.min(100, win.percent)));
}

/** 额度档位：≥100% 超支、≥80% 预警、其余正常。 */
export function goLevelOf(pct: number): 'over' | 'warn' | 'ok' {
  if (pct >= 100) return 'over';
  if (pct >= 80) return 'warn';
  return 'ok';
}

/** 重置时间文案：无重置时间返回空串；否则用调用方 t 做本地化，参数为 {time}。 */
export function goResetsAt(
  t: (key: 'go.resetsAt', params?: Record<string, unknown>) => string,
  win: GoWindow,
): string {
  return win.resetsAt ? t('go.resetsAt', { time: new Date(win.resetsAt).toLocaleString() }) : '';
}

/** 每日缓存总量 cacheRead + cacheWrite，角标与热力图 tooltip 共用。 */
export function cacheTotal(b: { cacheRead?: number | null; cacheWrite?: number | null }): number {
  return (b.cacheRead || 0) + (b.cacheWrite || 0);
}
