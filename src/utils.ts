/**
 * 跨端共用的纯函数与共享常量，host 与 client 两个 bundle 各自内联所需子集。
 *
 * 本模块只放纯函数与数值常量；协议类型 GoWindow、GoQuota、UsageAgg、Agg、
 * SeriesPoint、UsageSettings 定义在 types.ts。这里是插件
 * 自有逻辑中「多文件共用」部分的单一事实来源：本地日划分、单行 JSON 解析、错误消息提取、模型键拆分、Go 额度档位、插件偏好的默认值与夹取、模型统计重定向规则的归一化等。
 *
 * 设计约束：
 *   - 只允许纯 JS 运行时能力 Date、Math、JSON、String，禁止 import
 *     node 内置模块，会破坏浏览器端 bundle，或 react、harness 包，会破坏
 *     服务端 bundle（import type 例外，构建时剥离）；
 *   - 归属说明：聚合口径与折叠 agg.ts、store.ts，账本存储 ledger.ts，
 *     会话发现 logs.ts，客户端格式化、分桶、图表几何 client/stats.ts
 *     等仍留在各自模块，这里只放「多文件共用的」部分。
 */
import type { ModelRedirect, GoWindow, UsageSettings } from './types.ts';

/** 时间戳对应的本地零点，避免 UTC 漂移，host 折叠与会话图共用同一套日划分。 */
export function startOfDay(timeMs: number): number {
  const d = new Date(timeMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地日期键 YYYY-MM-DD，客户端日期标签用。 */
export function dateKeyOf(t: number): string {
  const d = new Date(t);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

/** 额度抓取强制下限：官方端点任何情况下不低于该间隔打一次，与客户端设置下限对齐。 */
export const QUOTA_MIN_FETCH_MS = 3 * 60 * 1000;
/** 额度结果缓存上限：默认 5 分钟；客户端可按抓取间隔调短有效缓存。 */
export const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 额度有效 TTL：`min(上限, max(下限, 间隔))`，让实际打官方端点的频率与
 * 设置一致且不短于下限；未提供间隔时用默认上限。三额度查询共用同一公式。
 */
export function effectiveQuotaTtl(intervalMinutes?: number): number {
  if (typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes)) {
    return Math.min(QUOTA_CACHE_TTL_MS, Math.max(QUOTA_MIN_FETCH_MS, Math.round(intervalMinutes * 60 * 1000)));
  }
  return QUOTA_CACHE_TTL_MS;
}

/** 快照与图表序列上限：`all` 范围最多回看的天数，快照截断与客户端建桶共用。 */
export const SERIES_MAX_DAYS = 366;

/** 一日毫秒数：仅用于日期差换算（`Math.round(毫秒差 / DAY_MS)`），绝不用于逐日推进（夏令时日不是 24h，推进一律 `setDate`）。 */
export const DAY_MS = 86_400_000;

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

// ---- 插件偏好设置：设置命名空间名、默认值、夹取与字段级归一化 ----
// host 侧按这些常量建 schemastery schema（src/host/settings.ts），client 侧
// 用它做取值兜底与写入夹取，两侧共用同一份数值，避免默认值分叉。

/** 设置命名空间名，服务端 ctx.settings 注册键，即 settings.yaml 里的一级键。 */
export const USAGE_SETTINGS_NAMESPACE = 'usage-stats';
/** OpenCode Go 额度抓取间隔下限，单位分钟：官方额度接口不短于该间隔打点。 */
export const GO_FETCH_MIN_MINUTES = 3;
/** OpenCode Go 额度抓取间隔默认值，单位分钟。 */
export const GO_FETCH_DEFAULT_MINUTES = 5;
/** DeepSeek 余额抓取间隔下限，单位分钟。 */
export const DEEPSEEK_FETCH_MIN_MINUTES = 3;
/** DeepSeek 余额抓取间隔默认值，单位分钟。 */
export const DEEPSEEK_FETCH_DEFAULT_MINUTES = 5;
/** Z.ai 额度抓取间隔下限，单位分钟。 */
export const ZAI_FETCH_MIN_MINUTES = 3;
/** Z.ai 额度抓取间隔默认值，单位分钟。 */
export const ZAI_FETCH_DEFAULT_MINUTES = 5;
/** 模型统计重定向规则条数上限：约束浏览器端归并成本与偏好文档体积。 */
export const MODEL_REDIRECT_MAX_RULES = 50;

/** 偏好默认值：设置命名空间未覆盖的字段、取值尚未到达浏览器时都用它。 */
export const USAGE_SETTINGS_DEFAULTS: UsageSettings = {
  goEnabled: true,
  showGoInSidebar: true,
  goFetchMinutes: GO_FETCH_DEFAULT_MINUTES,
  deepseekEnabled: true,
  showDeepSeekInSidebar: true,
  deepseekFetchMinutes: DEEPSEEK_FETCH_DEFAULT_MINUTES,
  zaiEnabled: true,
  showZaiInSidebar: true,
  zaiFetchMinutes: ZAI_FETCH_DEFAULT_MINUTES,
  modelRedirects: [],
};

/** 把任意数值夹成合法抓取间隔：整数分钟、不低于下限，非法值回退为默认值。 */
export function clampGoFetchMinutes(value: number): number {
  const n = Number.isFinite(value) ? value : GO_FETCH_DEFAULT_MINUTES;
  return Math.max(GO_FETCH_MIN_MINUTES, Math.round(n));
}

/** 把任意数值夹成合法 DeepSeek 抓取间隔：整数分钟、不低于下限，非法值回退为默认值。 */
export function clampDeepSeekFetchMinutes(value: number): number {
  const n = Number.isFinite(value) ? value : DEEPSEEK_FETCH_DEFAULT_MINUTES;
  return Math.max(DEEPSEEK_FETCH_MIN_MINUTES, Math.round(n));
}

/** 把任意数值夹成合法 Z.ai 抓取间隔：整数分钟、不低于下限，非法值回退为默认值。 */
export function clampZaiFetchMinutes(value: number): number {
  const n = Number.isFinite(value) ? value : ZAI_FETCH_DEFAULT_MINUTES;
  return Math.max(ZAI_FETCH_MIN_MINUTES, Math.round(n));
}

/**
 * 模型统计重定向规则归一化：只收数组，元素必须是对象，四个字段取字符串并去首尾空白，
 * 非字符串字段记空串；四项全空的条目是编辑器里的空行，直接丢弃；半填的保留
 * （界面继续填，归并时按 isCompleteRedirect 跳过）；超过上限截断。
 * 归一化对象是设置命名空间的解析值，手改 settings.yaml 或旧版本残留都可能给出坏形状。
 */
export function normalizeModelRedirects(raw: unknown): ModelRedirect[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelRedirect[] = [];
  for (const item of raw) {
    if (out.length >= MODEL_REDIRECT_MAX_RULES) break;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const src = item as Record<string, unknown>;
    const field = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    const rule: ModelRedirect = {
      fromProvider: field(src.fromProvider),
      fromModel: field(src.fromModel),
      toProvider: field(src.toProvider),
      toModel: field(src.toModel),
    };
    if (!rule.fromProvider && !rule.fromModel && !rule.toProvider && !rule.toModel) continue;
    out.push(rule);
  }
  return out;
}

/** 规则四项是否填齐：不完整的规则不参与归并（界面保留，等填完再生效）。 */
export function isCompleteRedirect(rule: ModelRedirect): boolean {
  return rule.fromProvider !== '' && rule.fromModel !== ''
    && rule.toProvider !== '' && rule.toModel !== '';
}

/**
 * 字段级归一化：布尔字段只收布尔，间隔字段只收有限数并夹取，其余回退默认值。
 * 归一化对象为设置命名空间的解析值——写入方（浏览器端 settingsScope）与服务端
 * schema 都保证字段齐备，但手改 settings.yaml 或旧版本残留仍可能给出坏值。
 */
export function normalizeUsageSettings(raw: Partial<UsageSettings> | null | undefined): UsageSettings {
  const src = raw ?? {};
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  const minutes = (v: unknown, clamp: (n: number) => number, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v) ? clamp(v) : fallback);
  return {
    goEnabled: bool(src.goEnabled, USAGE_SETTINGS_DEFAULTS.goEnabled),
    showGoInSidebar: bool(src.showGoInSidebar, USAGE_SETTINGS_DEFAULTS.showGoInSidebar),
    goFetchMinutes: minutes(src.goFetchMinutes, clampGoFetchMinutes, USAGE_SETTINGS_DEFAULTS.goFetchMinutes),
    deepseekEnabled: bool(src.deepseekEnabled, USAGE_SETTINGS_DEFAULTS.deepseekEnabled),
    showDeepSeekInSidebar: bool(src.showDeepSeekInSidebar, USAGE_SETTINGS_DEFAULTS.showDeepSeekInSidebar),
    deepseekFetchMinutes: minutes(src.deepseekFetchMinutes, clampDeepSeekFetchMinutes, USAGE_SETTINGS_DEFAULTS.deepseekFetchMinutes),
    zaiEnabled: bool(src.zaiEnabled, USAGE_SETTINGS_DEFAULTS.zaiEnabled),
    showZaiInSidebar: bool(src.showZaiInSidebar, USAGE_SETTINGS_DEFAULTS.showZaiInSidebar),
    zaiFetchMinutes: minutes(src.zaiFetchMinutes, clampZaiFetchMinutes, USAGE_SETTINGS_DEFAULTS.zaiFetchMinutes),
    modelRedirects: normalizeModelRedirects(src.modelRedirects),
  };
}
