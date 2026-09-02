/**
 * 浏览器端插件偏好设置：OpenCode Go 额度与 DeepSeek 余额监控的偏好设置。
 *
 * 纯逻辑模块，无 React，负责：
 *   - 偏好形状 `UsageSettings` 与默认值；
 *   - localStorage 的读取 loadUsageSettings，含类型、边界校验与兜底，与
 *     写入 saveUsageSettings；
 *   - 抓取间隔的夹取规则 clampGoFetchMinutes、clampDeepSeekFetchMinutes，整数分钟，下限 3。
 *
 * 写入失败时如隐私模式等情况，静默降级为仅当前会话生效，不抛错。
 */

/** 抓取间隔下限，单位分钟：官方额度接口不短于该间隔打点。 */
export const GO_FETCH_MIN_MINUTES = 3;
/** 抓取间隔默认值，单位分钟。 */
export const GO_FETCH_DEFAULT_MINUTES = 5;
/** DeepSeek 余额抓取间隔下限，单位分钟。 */
export const DEEPSEEK_FETCH_MIN_MINUTES = 3;
/** DeepSeek 余额抓取间隔默认值，单位分钟。 */
export const DEEPSEEK_FETCH_DEFAULT_MINUTES = 5;
/** Z.ai 额度抓取间隔下限，单位分钟。 */
export const ZAI_FETCH_MIN_MINUTES = 3;
/** Z.ai 额度抓取间隔默认值，单位分钟。 */
export const ZAI_FETCH_DEFAULT_MINUTES = 5;

/** 插件偏好设置，包含 OpenCode Go 额度、DeepSeek 余额与 Z.ai 额度监控。 */
export interface UsageSettings {
  /** 是否启用 OpenCode Go 额度监控，关闭后不再请求官方额度接口。 */
  goEnabled: boolean
  /** 是否在侧边栏底部展示 OpenCode Go 剩余额度芯片。 */
  showGoInSidebar: boolean
  /** OpenCode Go 额度抓取间隔，单位分钟，下限 3 分钟。 */
  goFetchMinutes: number
  /** 是否启用 DeepSeek 余额监控，关闭后不再请求官方余额接口。 */
  deepseekEnabled: boolean
  /** 是否在侧边栏底部展示 DeepSeek 余额芯片。 */
  showDeepSeekInSidebar: boolean
  /** DeepSeek 余额抓取间隔，单位分钟，下限 3 分钟。 */
  deepseekFetchMinutes: number
  /** 是否启用 Z.ai 额度监控，关闭后不再请求官方额度接口。 */
  zaiEnabled: boolean
  /** 是否在侧边栏底部展示 Z.ai 额度芯片。 */
  showZaiInSidebar: boolean
  /** Z.ai 额度抓取间隔，单位分钟，下限 3 分钟。 */
  zaiFetchMinutes: number
}

/** 偏好默认值，首次打开、存储缺失或存储损坏时回退。 */
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
};

/** localStorage 存储键。 */
const STORAGE_KEY = 'dsh-usage-stats.settings';

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

/** 读取偏好：字段级类型校验 + 夹取，缺省 / 坏数据回退默认值。 */
export function loadUsageSettings(): UsageSettings {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...USAGE_SETTINGS_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UsageSettings>;
    return {
      goEnabled: typeof parsed.goEnabled === 'boolean'
        ? parsed.goEnabled
        : USAGE_SETTINGS_DEFAULTS.goEnabled,
      showGoInSidebar: typeof parsed.showGoInSidebar === 'boolean'
        ? parsed.showGoInSidebar
        : USAGE_SETTINGS_DEFAULTS.showGoInSidebar,
      goFetchMinutes: typeof parsed.goFetchMinutes === 'number'
        ? clampGoFetchMinutes(parsed.goFetchMinutes)
        : USAGE_SETTINGS_DEFAULTS.goFetchMinutes,
      deepseekEnabled: typeof parsed.deepseekEnabled === 'boolean'
        ? parsed.deepseekEnabled
        : USAGE_SETTINGS_DEFAULTS.deepseekEnabled,
      showDeepSeekInSidebar: typeof parsed.showDeepSeekInSidebar === 'boolean'
        ? parsed.showDeepSeekInSidebar
        : USAGE_SETTINGS_DEFAULTS.showDeepSeekInSidebar,
      deepseekFetchMinutes: typeof parsed.deepseekFetchMinutes === 'number'
        ? clampDeepSeekFetchMinutes(parsed.deepseekFetchMinutes)
        : USAGE_SETTINGS_DEFAULTS.deepseekFetchMinutes,
      zaiEnabled: typeof parsed.zaiEnabled === 'boolean'
        ? parsed.zaiEnabled
        : USAGE_SETTINGS_DEFAULTS.zaiEnabled,
      showZaiInSidebar: typeof parsed.showZaiInSidebar === 'boolean'
        ? parsed.showZaiInSidebar
        : USAGE_SETTINGS_DEFAULTS.showZaiInSidebar,
      zaiFetchMinutes: typeof parsed.zaiFetchMinutes === 'number'
        ? clampZaiFetchMinutes(parsed.zaiFetchMinutes)
        : USAGE_SETTINGS_DEFAULTS.zaiFetchMinutes,
    };
  } catch {
    return { ...USAGE_SETTINGS_DEFAULTS };
  }
}

/** 保存偏好到 localStorage，失败时静默忽略，仅当前会话生效。 */
export function saveUsageSettings(settings: UsageSettings): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 私有模式等存储不可用：忽略，不影响本次会话。
    void 0;
  }
}
