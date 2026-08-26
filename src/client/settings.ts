/**
 * 插件偏好设置（浏览器端）：当前是 OpenCode Go 额度监控相关三项设置。
 *
 * 纯逻辑模块（无 React），负责：
 *   - 偏好形状 `UsageSettings` 与默认值；
 *   - localStorage 的读取（loadUsageSettings，含类型/边界校验与兜底）与
 *     写入（saveUsageSettings）；
 *   - 抓取间隔的夹取规则（clampGoFetchMinutes：整数分钟，下限 3）。
 *
 * 写入失败（隐私模式等）静默降级为仅当前会话生效，不抛错。
 */

/** 抓取间隔下限（分钟）：官方额度接口不短于该间隔打点。 */
export const GO_FETCH_MIN_MINUTES = 3
/** 抓取间隔默认值（分钟）。 */
export const GO_FETCH_DEFAULT_MINUTES = 5

/** 插件偏好设置（OpenCode Go 额度监控相关三项）。 */
export interface UsageSettings {
  /** 是否启用 OpenCode Go 额度监控（关闭后不再请求官方额度接口）。 */
  goEnabled: boolean
  /** 是否在侧边栏底部展示 OpenCode Go 剩余额度芯片。 */
  showGoInSidebar: boolean
  /** OpenCode Go 额度抓取间隔（分钟），下限 3 分钟。 */
  goFetchMinutes: number
}

/** 偏好默认值（首次打开 / 存储缺失 / 存储损坏时回退）。 */
export const USAGE_SETTINGS_DEFAULTS: UsageSettings = {
  goEnabled: true,
  showGoInSidebar: true,
  goFetchMinutes: GO_FETCH_DEFAULT_MINUTES,
}

/** localStorage 存储键。 */
const STORAGE_KEY = 'dsh-usage-stats.settings'
/** 旧版存储键（兼容迁移）。 */
const LEGACY_STORAGE_KEY = 'dsh-usage-statistics.settings'

/** 把任意数值夹成合法抓取间隔：整数分钟、不低于下限（非法值回退默认）。 */
export function clampGoFetchMinutes(value: number): number {
  const n = Number.isFinite(value) ? value : GO_FETCH_DEFAULT_MINUTES
  return Math.max(GO_FETCH_MIN_MINUTES, Math.round(n))
}

/** 读取偏好：字段级类型校验 + 夹取，缺省 / 坏数据回退默认值。 */
export function loadUsageSettings(): UsageSettings {
  try {
    let raw = window.localStorage?.getItem(STORAGE_KEY)
    // 兼容旧版存储键：新键不存在时尝试读取旧键并迁移
    if (!raw) {
      const legacyRaw = window.localStorage?.getItem(LEGACY_STORAGE_KEY)
      if (legacyRaw) {
        raw = legacyRaw
        try { window.localStorage?.setItem(STORAGE_KEY, legacyRaw) } catch {}
      }
    }
    if (!raw) return { ...USAGE_SETTINGS_DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<UsageSettings>
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
    }
  } catch {
    return { ...USAGE_SETTINGS_DEFAULTS }
  }
}

/** 保存偏好到 localStorage（失败静默忽略，仅当前会话生效）。 */
export function saveUsageSettings(settings: UsageSettings): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 私有模式等存储不可用：忽略，不影响本次会话。
  }
}
