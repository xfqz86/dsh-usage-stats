/**
 * 浏览器端插件偏好存储：绑定服务端注册的 `usage-stats` 设置命名空间。
 *
 * 偏好的事实来源是服务端用户设置文档（`$DSH_HOME/settings.yaml`），浏览器端
 * 只是它的一个视图：`apply` 时经 `ctx.settingsScope.bind` 取到本命名空间作用域
 * （attachUsageSettings），组件经 subscribeUsageSettings 订阅变化、经
 * updateUsageSettings 写回显式改过的字段（路径写入，未改的字段继续跟随
 * schema 默认值）。取值经 normalizeUsageSettings 归一化并夹取，作用域尚未
 * 就绪（加载中或部署无设置后端）时回退 USAGE_SETTINGS_DEFAULTS。
 *
 * 旧版本把偏好存在 localStorage，本模块保留一次性迁移：作用域落定为就绪、可写、
 * 用户文档尚无该命名空间时，把与默认值不同的旧字段写进设置文档并删除旧键；
 * 服务端设置缺席或只读时保留旧键（没有可靠落点，删掉等于丢设置）。
 *
 * 纯逻辑模块，无 React，可单测；React 绑定在 useUsageSettings.ts。
 */

import {
  clampDeepSeekFetchMinutes,
  clampGoFetchMinutes,
  clampZaiFetchMinutes,
  normalizeUsageSettings,
  USAGE_SETTINGS_DEFAULTS,
} from '../utils.ts';

import type { UsageSettings } from '../types.ts';
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';

/** 旧版本 localStorage 存储键，仅用于一次性迁移。 */
export const LEGACY_STORAGE_KEY = 'dsh-usage-stats.settings';

/** 本插件绑定的设置作用域；apply 时 attach，插件卸载时 detach。 */
let scope: SettingsScope<UsageSettings> | undefined;

/** 未绑定作用域时的视图：默认值、状态 unavailable、不可写。 */
const UNBOUND_VIEW: UsageSettingsView = { settings: USAGE_SETTINGS_DEFAULTS, status: 'unavailable', writable: false };

/** 最近一次作用域快照与由它派生的视图，保证同一快照只派生一次（引用稳定）。 */
let viewFrom: SettingsScopeSnapshot<UsageSettings> | undefined;
let view: UsageSettingsView = UNBOUND_VIEW;

/** 偏好视图：取值（已归一化）与存储状态，组件渲染与提示共用。 */
export interface UsageSettingsView {
  /** 当前偏好：作用域未就绪时回退默认值。 */
  settings: UsageSettings
  /** 作用域状态：ready 表示取值来自服务端设置文档。 */
  status: 'loading' | 'ready' | 'unavailable'
  /** 服务端设置文档当前是否接受写入。 */
  writable: boolean
}

/** 未绑定作用域时的空订阅函数：调用它等于什么也不做。 */
function noop(): void {
  // 无作用域：没有可取消的订阅。
}

/** 绑定设置作用域（浏览器端 apply 调用一次），随后可用 hook 读写偏好。 */
export function attachUsageSettings(bound: SettingsScope<UsageSettings>): void {
  scope = bound;
}

/**
 * 解绑设置作用域：插件卸载后 hook 回退默认值，不再读写服务端设置。
 *
 * 传回自己绑定的作用域，只有它仍是当前绑定时才解绑——浏览器端热重载会先挂新
 * 作用域、旧 fiber 的清理再跑，无条件清空会把新作用域一起抹掉。
 * @param bound - 绑定时拿到的那个作用域；省略表示无条件解绑。
 */
export function detachUsageSettings(bound?: SettingsScope<UsageSettings>): void {
  if (bound === undefined || bound === scope) scope = undefined;
}

/** 读取旧版本 localStorage 里的偏好；无键、非 JSON 或坏形状时返回 null。 */
export function readLegacySettings(storage?: Pick<Storage, 'getItem'>): UsageSettings | null {
  try {
    const store = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    const raw = store?.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    return normalizeUsageSettings(JSON.parse(raw) as Partial<UsageSettings>);
  } catch {
    return null;
  }
}

/** 删除旧 localStorage 键；存储不可用（隐私模式）时静默忽略。 */
export function clearLegacySettings(storage?: Pick<Storage, 'removeItem'>): void {
  try {
    const store = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    store?.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // 存储不可用：忽略，不影响本次会话。
  }
}

/** 取出与默认值不同的字段，迁移只写这些字段，设置文档保持最小。 */
export function diffFromDefaults(settings: UsageSettings): Partial<UsageSettings> {
  const patch: Partial<UsageSettings> = {};
  for (const [field, value] of Object.entries(settings) as [keyof UsageSettings, boolean | number][]) {
    if (value !== USAGE_SETTINGS_DEFAULTS[field]) {
      (patch as Record<string, boolean | number>)[field] = value;
    }
  }
  return patch;
}

/** 抓取间隔字段写入前的夹取；非间隔字段原样返回。 */
function clampOf(field: keyof UsageSettings, value: number): number {
  if (field === 'goFetchMinutes') return clampGoFetchMinutes(value);
  if (field === 'deepseekFetchMinutes') return clampDeepSeekFetchMinutes(value);
  if (field === 'zaiFetchMinutes') return clampZaiFetchMinutes(value);
  return value;
}

/** 把局部偏好转成路径写入操作：只写显式给出的字段，间隔字段先夹取。 */
export function settingOps(patch: Partial<UsageSettings>): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = [];
  for (const [field, value] of Object.entries(patch) as [keyof UsageSettings, boolean | number | undefined][]) {
    if (value === undefined) continue;
    ops.push({ op: 'set', path: [field], value: typeof value === 'number' ? clampOf(field, value) : value });
  }
  return ops;
}

/**
 * 等作用域从 loading 落到确定状态（ready / unavailable）：页面刚打开时 describe
 * 还没回来，此时不能判断设置文档里有没有该命名空间，迁移必须等这一拍。
 * @param bound - 已绑定的设置作用域。
 * @param timeoutMs - 最长等待时间，超时按当前快照处理（不阻塞调用方）。
 * @returns 落定后的快照。
 */
export function settleUsageSettings(
  bound: SettingsScope<UsageSettings>,
  timeoutMs = 10_000,
): Promise<SettingsScopeSnapshot<UsageSettings>> {
  const current = bound.getSnapshot();
  if (current.status !== 'loading') return Promise.resolve(current);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { unsubscribe(); resolve(bound.getSnapshot()); }, timeoutMs);
    const unsubscribe = bound.subscribe(() => {
      const next = bound.getSnapshot();
      if (next.status === 'loading') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(next);
    });
  });
}

/**
 * 一次性迁移旧 localStorage 偏好到服务端设置文档。
 *
 * 只在「作用域落定为就绪且可写、用户文档尚无该命名空间、旧值与默认值不同」时写，
 * 因此不会覆盖用户已改过的服务端设置；只写与默认值不同的字段，写成功后删除旧键。
 * 服务端设置不可用或只读时**保留**旧键：此时没有可靠的落点，删掉就等于丢设置。
 * @param bound - 已绑定的设置作用域。
 * @param storage - 可注入的 localStorage 替身，测试用。
 * @param timeoutMs - 等待作用域落定的上限，超过则按当前快照处理。
 * @returns 迁移是否真的写入了设置文档。
 */
export async function migrateLegacySettings(
  bound: SettingsScope<UsageSettings>,
  storage?: Pick<Storage, 'getItem' | 'removeItem'>,
  timeoutMs = 10_000,
): Promise<boolean> {
  const legacy = readLegacySettings(storage);
  if (legacy === null) return false;
  const snapshot = await settleUsageSettings(bound, timeoutMs);
  if (snapshot.status !== 'ready' || !snapshot.writable) return false;
  // 设置文档已有用户段：文档为准，旧键只是上一版的残留，清掉避免第二个浏览器再写。
  if (snapshot.user !== undefined && snapshot.user !== null) {
    clearLegacySettings(storage);
    return false;
  }
  const ops = settingOps(diffFromDefaults(legacy));
  if (ops.length === 0) {
    clearLegacySettings(storage);
    return false;
  }
  await bound.mutate(ops);
  clearLegacySettings(storage);
  return true;
}

/**
 * 当前偏好视图：作用域未就绪时回退默认值，同一份作用域快照返回同一对象
 * （useSyncExternalStore 依赖引用稳定判断是否变化）。
 */
export function usageSettingsView(): UsageSettingsView {
  const snapshot = scope?.getSnapshot();
  if (snapshot === undefined) return UNBOUND_VIEW;
  if (snapshot !== viewFrom) {
    viewFrom = snapshot;
    view = {
      settings: normalizeUsageSettings(snapshot.value),
      status: snapshot.status,
      writable: snapshot.writable,
    };
  }
  return view;
}

/** 订阅偏好变化，返回取消订阅函数；未绑定作用域时订阅为空操作。 */
export function subscribeUsageSettings(listener: () => void): () => void {
  return scope?.subscribe(listener) ?? noop;
}

/**
 * 写入偏好：局部合并语义，只落显式给出的字段（未给出的字段继续跟随默认值）。
 *
 * 作用域已落定为不可用（部署无设置后端、命名空间未注册）或明确只读时直接返回，
 * 不发注定被拒的请求；仍在加载中则照发——服务端可能接受，作用域自己会以最新
 * 一次读取兜底。写入失败不打断界面：作用域会以最新一次读取恢复显示值。
 */
export function updateUsageSettings(patch: Partial<UsageSettings>): void {
  const ops = settingOps(patch);
  if (ops.length === 0 || scope === undefined) return;
  const { status, writable } = scope.getSnapshot();
  if (status === 'unavailable' || (status === 'ready' && !writable)) return;
  void scope.mutate(ops).catch((error: unknown) => {
    console.warn('[usage-stats] 偏好写入失败，界面回退到服务端设置', error);
  });
}
