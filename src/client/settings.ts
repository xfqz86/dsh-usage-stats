/**
 * 浏览器端插件偏好存储：绑定服务端 `usage-stats` 插件条目（profile 配置文档里的 Loader 条目）的设置表单。
 *
 * 偏好的事实来源是 profile 配置文档，浏览器端只是它的一个视图：`apply` 时经
 * `ctx.configForms.get` 取到本条目的表单（attachUsageSettings），组件经
 * subscribeUsageSettings 订阅、经 updateUsageSettings 路径写入显式改过的字段
 * （未改的字段继续跟随 schema 默认值）；取值经 normalizeUsageSettings 归一化并夹取，
 * 表单未就绪（加载中、条目未挂载或部署不支持写入）时回退 USAGE_SETTINGS_DEFAULTS。
 * 点下去先按本地猜测渲染（乐观更新），不等服务端一整圈往返，落盘后对账消掉。
 * 规则表整表写入，不做数组下标级增删，避免并发写时错位。
 *
 * 配置串导入走整份覆盖（replaceUsageSettings）：与默认值相等的字段 unset，其余逐字段 set。
 *
 * 旧版本把偏好存在 localStorage，本模块保留一次性迁移：表单就绪、可写、用户片段不存在时，
 * 把与默认值不同的旧字段写进配置文档并删除旧键；没有可靠落点时保留旧键。
 *
 * 纯逻辑模块，无 React，可单测；React 绑定在 useUsageSettings.ts。
 */

import {
  clampDeepSeekFetchMinutes,
  clampGoFetchMinutes,
  clampZaiFetchMinutes,
  diffFromDefaults,
  normalizeUsageSettings,
  settingsValueEqual,
  USAGE_SETTINGS_DEFAULTS,
} from '../utils.ts';

import type { UsageSettings } from '../types.ts';
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client';
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';

/** 旧版本 localStorage 存储键，仅用于一次性迁移。 */
export const LEGACY_STORAGE_KEY = 'dsh-usage-stats.settings';

/** 路径写入的值类型：SettingsPathOpView 是 set/unset 联合，取 set 分支的 value。 */
type SettingsWriteValue = Extract<SettingsPathOpView, { op: 'set' }>['value'];

/** 本插件绑定的设置表单；apply 时 attach，插件卸载时 detach。 */
let scope: ConfigForm<UsageSettings> | undefined;

/** 未绑定表单时的视图：默认值、状态 unavailable、不可写。 */
const UNBOUND_VIEW: UsageSettingsView = { settings: USAGE_SETTINGS_DEFAULTS, status: 'unavailable', writable: false };

/** 已发出、尚未被服务端快照确认的字段：点下去先按它渲染，不等服务端往返。 */
let pending: Partial<UsageSettings> = {};

/** 本地订阅者集合：热重载解绑时订阅不断，等下次绑定自动恢复转发。 */
const localListeners = new Set<() => void>();

/** 已包转发的那层表单：换绑时重包，保证任何时刻最多包一层。 */
let forwardedScope: ConfigForm<UsageSettings> | undefined;

/** 当前转发层的取消订阅：换绑、无本地订阅者时释放，不占着旧表单不放。 */
let stopForward: (() => void) | undefined;

/** 最近一次表单快照、挂起写入与由它俩派生的视图：任一引用没变就返回同一对象。 */
let viewFrom: ConfigFormSnapshot<UsageSettings> | undefined;
let viewPending: Partial<UsageSettings> = pending;
let view: UsageSettingsView = UNBOUND_VIEW;

/** 上次通知过本地订阅者的视图：服务端回声与本地猜测一致时不再打扰界面。 */
let deliveredView: UsageSettingsView = UNBOUND_VIEW;

/** 偏好视图：取值（已归一化）与存储状态，组件渲染与提示共用。 */
export interface UsageSettingsView {
  /** 当前偏好：表单未就绪时回退默认值。 */
  settings: UsageSettings
  /** 表单状态：ready 表示取值来自 profile 配置文档。 */
  status: 'loading' | 'ready' | 'unavailable'
  /** profile 配置文档当前是否接受写入。 */
  writable: boolean
}

/** 未绑定表单时的空订阅函数：调用它等于什么也不做。 */
function noop(): void {
  // 无表单：没有可取消的订阅。
}

/** 绑定设置表单（浏览器端 apply 调用一次），随后可用 hook 读写偏好。 */
export function attachUsageSettings(bound: ConfigForm<UsageSettings>): void {
  scope = bound;
  rebindForward();
}

/**
 * 解绑设置表单：插件卸载后 hook 回退默认值，不再读写配置文档。
 *
 * 传回自己绑定的表单，只有它仍是当前绑定时才解绑——浏览器端热重载会先挂新
 * 表单、旧 fiber 的清理再跑，无条件清空会把新表单一起抹掉。
 * @param bound - 绑定时拿到的那个表单；省略表示无条件解绑。
 */
export function detachUsageSettings(bound?: ConfigForm<UsageSettings>): void {
  if (bound === undefined || bound === scope) scope = undefined;
  rebindForward();
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

/** 抓取间隔字段写入前的夹取；非间隔字段原样返回。 */
function clampOf(field: keyof UsageSettings, value: number): number {
  if (field === 'goFetchMinutes') return clampGoFetchMinutes(value);
  if (field === 'deepseekFetchMinutes') return clampDeepSeekFetchMinutes(value);
  if (field === 'zaiFetchMinutes') return clampZaiFetchMinutes(value);
  return value;
}

/** 把局部偏好转成路径写入操作：只写显式给出的字段，间隔字段先夹取，规则表整表写入。 */
export function settingOps(patch: Partial<UsageSettings>): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = [];
  for (const [field, value] of Object.entries(patch) as [keyof UsageSettings, UsageSettings[keyof UsageSettings] | undefined][]) {
    if (value === undefined) continue;
    ops.push({ op: 'set', path: [field], value: settingValueOf(field, value) });
  }
  return ops;
}

/**
 * 单个偏好字段的写入值：间隔字段先夹取；规则表逐条展开成普通对象字面量——
 * `ModelRedirect` 是 interface，没有隐式索引签名，直接当写入值传会报类型错，
 * 展开后每条都是纯字符串字段的对象字面量，正是设置文档里要存的东西。
 */
function settingValueOf(field: keyof UsageSettings, value: UsageSettings[keyof UsageSettings]): SettingsWriteValue {
  if (typeof value === 'number') return clampOf(field, value);
  if (Array.isArray(value)) return value.map((rule) => ({ ...rule }));
  return value;
}

/**
 * 整份偏好覆盖的路径操作：与默认值相等的字段 unset（记录里不留该字段、继续跟随
 * schema 默认值），不相等的字段 set（间隔沿用既有夹取，规则表整表写入）。
 * 字段序取 USAGE_SETTINGS_DEFAULTS 的声明序，每次覆盖提交的 ops 顺序一致。
 */
export function replacementOps(settings: UsageSettings): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = [];
  for (const field of Object.keys(USAGE_SETTINGS_DEFAULTS) as (keyof UsageSettings)[]) {
    if (settingsValueEqual(settings[field], USAGE_SETTINGS_DEFAULTS[field])) {
      ops.push({ op: 'unset', path: [field] });
    } else {
      ops.push({ op: 'set', path: [field], value: settingValueOf(field, settings[field]) });
    }
  }
  return ops;
}

/**
 * 等表单从 loading 落到确定状态（ready / unavailable）：页面刚打开时 describe
 * 还没回来，此时不能判断配置文档里有没有该条目，迁移必须等这一拍。
 * @param bound - 已绑定的设置表单。
 * @param timeoutMs - 最长等待时间，超时按当前快照处理（不阻塞调用方）。
 * @returns 落定后的快照。
 */
export function settleUsageSettings(
  bound: ConfigForm<UsageSettings>,
  timeoutMs = 10_000,
): Promise<ConfigFormSnapshot<UsageSettings>> {
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
 * 一次性迁移旧 localStorage 偏好到 profile 配置文档。
 *
 * 只在「表单落定为就绪且可写、用户片段尚不存在、旧值与默认值不同」时写，
 * 因此不会覆盖用户已改过的服务端设置；只写与默认值不同的字段，写成功后删除旧键。
 * 服务端设置不可用或只读时**保留**旧键：此时没有可靠的落点，删掉就等于丢设置。
 * @param bound - 已绑定的设置表单。
 * @param storage - 可注入的 localStorage 替身，测试用。
 * @param timeoutMs - 等待表单落定的上限，超过则按当前快照处理。
 * @returns 迁移是否真的写入了配置文档。
 */
export async function migrateLegacySettings(
  bound: ConfigForm<UsageSettings>,
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

/** 通知本地订阅者：退订发生在通知中途也不影响其余订阅者。 */
function notifyLocalListeners(): void {
  for (const listener of Array.from(localListeners)) {
    listener();
  }
}

/** 两份视图内容是否一致：字段逐个按值比，数组引用每次都变故不能直接比。 */
function sameSettingsView(first: UsageSettingsView, second: UsageSettingsView): boolean {
  if (first.status !== second.status || first.writable !== second.writable) return false;
  for (const field of Object.keys(USAGE_SETTINGS_DEFAULTS) as (keyof UsageSettings)[]) {
    if (!settingsValueEqual(first.settings[field], second.settings[field])) return false;
  }
  return true;
}

/** 视图内容变化才通知：服务端回声与本地猜测一致时省一次重渲染。 */
function publishIfChanged(): void {
  const next = usageSettingsView();
  if (sameSettingsView(next, deliveredView)) return;
  deliveredView = next;
  notifyLocalListeners();
}

/** 快照到达即对账：与服务端一致的猜测视为落盘，不再覆盖显示。 */
function reconcilePending(form: ConfigForm<UsageSettings>): void {
  const confirmed = normalizeUsageSettings(form.getSnapshot().value);
  const rest: Partial<UsageSettings> = { ...pending };
  let changed = false;
  for (const field of Object.keys(rest) as (keyof UsageSettings)[]) {
    const guess = rest[field];
    if (guess !== undefined && settingsValueEqual(guess, confirmed[field])) {
      delete rest[field];
      changed = true;
    }
  }
  if (changed) pending = rest;
}

/** 对齐转发层与当前绑定：换绑重包，保证任何时刻最多包一层。 */
function rebindForward(): void {
  if (forwardedScope !== undefined && (forwardedScope !== scope || localListeners.size === 0)) {
    if (stopForward !== undefined) {
      stopForward();
      stopForward = undefined;
    }
    forwardedScope = undefined;
  }
  if (scope !== undefined && forwardedScope === undefined && localListeners.size > 0) {
    const form = scope;
    forwardedScope = form;
    stopForward = form.subscribe(() => {
      reconcilePending(form);
      publishIfChanged();
    });
  }
}

/**
 * 当前偏好视图：表单未就绪时回退默认值，同一份表单快照返回同一对象
 * （useSyncExternalStore 依赖引用稳定判断是否变化）。
 */
export function usageSettingsView(): UsageSettingsView {
  const snapshot = scope?.getSnapshot();
  if (snapshot === undefined) return UNBOUND_VIEW;
  if (snapshot !== viewFrom || pending !== viewPending) {
    viewFrom = snapshot;
    viewPending = pending;
    const base = normalizeUsageSettings(snapshot.value);
    view = {
      settings: Object.keys(pending).length === 0 ? base : { ...base, ...pending },
      status: snapshot.status,
      writable: snapshot.writable,
    };
  }
  return view;
}

/** 订阅偏好变化，返回取消订阅函数；未绑定表单时沿旧语义不跟踪。 */
export function subscribeUsageSettings(listener: () => void): () => void {
  if (scope === undefined) return noop;
  localListeners.add(listener);
  rebindForward();
  return () => {
    localListeners.delete(listener);
    rebindForward();
  };
}

/** 把路径写入换算成写后服务端应有的取值：set 按写入值，unset 按默认值回落。 */
function optimisticPatch(ops: SettingsPathOpView[]): Partial<UsageSettings> {
  const patch: Partial<UsageSettings> = {};
  for (const op of ops) {
    const field = op.path[0] as keyof UsageSettings;
    (patch as Record<string, unknown>)[field] =
      op.op === 'set' ? op.value : USAGE_SETTINGS_DEFAULTS[field];
  }
  return patch;
}

/**
 * 公共提交：无操作或无表单时不发；表单已落定为不可用（条目未挂载、连接非本机
 * 回环）或明确只读时直接返回，不发注定被拒的请求；仍在加载中则照发——服务端
 * 可能接受，表单自己会以最新一次读取兜底。真发时先同步挂起本地猜测让界面当拍
 * 变，写入失败只回滚本次字段、界面退回服务端值。
 */
function commitOps(ops: SettingsPathOpView[]): void {
  if (ops.length === 0 || scope === undefined) return;
  const { status, writable } = scope.getSnapshot();
  if (status === 'unavailable' || (status === 'ready' && !writable)) return;
  const target = scope;
  const written = optimisticPatch(ops);
  pending = { ...pending, ...written };
  publishIfChanged();
  void target.mutate(ops).catch((error: unknown) => {
    const rolled: Partial<UsageSettings> = { ...pending };
    let changed = false;
    for (const field of Object.keys(written) as (keyof UsageSettings)[]) {
      const mine = written[field];
      const latest = rolled[field];
      if (mine !== undefined && latest !== undefined && settingsValueEqual(latest, mine)) {
        delete rolled[field];
        changed = true;
      }
    }
    if (changed) {
      pending = rolled;
      publishIfChanged();
    }
    console.warn('[usage-stats] 偏好写入失败，界面回退到服务端设置', error);
  });
}

/**
 * 写入偏好：局部合并语义，只落显式给出的字段（未给出的字段继续跟随默认值）。
 * 提交守卫与失败处理见 commitOps。
 */
export function updateUsageSettings(patch: Partial<UsageSettings>): void {
  commitOps(settingOps(patch));
}

/**
 * 整份覆盖偏好（配置串导入）：与默认值相等的字段回默认值，其余按给定取值写入。
 * 覆盖范围由界面在调用前向用户确认；提交守卫与失败处理见 commitOps。
 */
export function replaceUsageSettings(settings: UsageSettings): void {
  commitOps(replacementOps(settings));
}
