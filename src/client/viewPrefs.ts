/**
 * 浏览器端视图偏好：模型表分组、时间范围与分组折叠状态的 localStorage 读写、归一化与订阅。
 *
 * 这些只是「看表习惯」，不属于部署配置：同一份部署在不同浏览器可各看各的，所以不进
 * profile 配置文档、也不进配置串（见 src/client/settings.ts 与 src/client/configTransfer.ts）。
 * 纯逻辑、无 React，可被 node --experimental-strip-types 直接引用；React 绑定在
 * hooks/useViewPrefs.ts。
 *
 * 存储协议（键 dsh-usage-stats.view）：{ version, modelGroupMode, timeRange, collapsed }，
 * 读取对一切坏形状逐字段归一化（详见 docs/API.md §5.2）。存储不可用（隐私模式、无 window、
 * 配额满）时不抛错——读回落默认值、写静默丢弃，内存快照照常更新，本次会话内仍然生效。
 *
 * 模块持有唯一内存快照（viewPrefsSnapshot 引用稳定），setter 先改内存再尽力写盘并通知，
 * 界面用 useSyncExternalStore 订阅即可；旧配置残留里的两项由 adoptLegacyViewPrefs 一次性种入。
 */

import type { ModelGroupMode, TimeRange } from '../types.ts';

/** 视图偏好的 localStorage 键。 */
export const VIEW_PREFS_STORAGE_KEY = 'dsh-usage-stats.view';

/** 存储载荷版本：结构演进时递增，读侧暂不校验（字段已逐个归一化）。 */
const VIEW_PREFS_VERSION = 1;

/** 单数组（某个 scope + mode 下收起的组键）条数上限：约束存储体积与折叠判断成本。 */
const MAX_COLLAPSED_KEYS = 200;

/** 折叠状态所属的模型表：模型页、日期明细的按模型表、会话明细的按模型表各一份。 */
export type CollapseScope = 'models' | 'dateDetail' | 'sessionDetail';

/** 折叠状态对应的分组模式：不分组时没有组头，无需记忆。 */
export type CollapseMode = Exclude<ModelGroupMode, 'none'>;

/** 一种分组模式下收起的组键（组键为供应商名或模型名）。 */
export interface CollapsedByMode {
  provider: string[]
  model: string[]
}

/** 三个模型表各自的折叠状态。 */
export interface CollapsedGroups {
  models: CollapsedByMode
  dateDetail: CollapsedByMode
  sessionDetail: CollapsedByMode
}

/** 浏览器端视图偏好：模型表分组、时间范围与各模型表的折叠状态。 */
export interface ViewPrefs {
  modelGroupMode: ModelGroupMode
  timeRange: TimeRange
  collapsed: CollapsedGroups
}

/** 分组模式的三档取值，归一化只收其中之一。 */
const MODEL_GROUP_MODES: readonly ModelGroupMode[] = ['none', 'provider', 'model'];

/** 时间范围的七档取值，归一化只收其中之一。 */
const TIME_RANGES: readonly TimeRange[] = ['7d', '14d', '30d', '90d', '180d', '365d', 'all'];

/** 折叠状态共有的三个 scope，与 CollapseScope 声明保持一致。 */
const COLLAPSE_SCOPES: readonly CollapseScope[] = ['models', 'dateDetail', 'sessionDetail'];

/** 折叠状态共有的两个 mode，与 CollapseMode 声明保持一致。 */
const COLLAPSE_MODES: readonly CollapseMode[] = ['provider', 'model'];

/** 空的单模式折叠表：默认全展开。 */
function emptyCollapsedByMode(): CollapsedByMode {
  return { provider: [], model: [] };
}

/** 空的折叠状态：三 scope 六数组全空，默认全展开。 */
function emptyCollapsedGroups(): CollapsedGroups {
  return {
    models: emptyCollapsedByMode(),
    dateDetail: emptyCollapsedByMode(),
    sessionDetail: emptyCollapsedByMode(),
  };
}

/** 视图偏好默认值：键缺失、坏值、存储不可用或旧值尚未到达时都用它。 */
export const VIEW_PREFS_DEFAULTS: ViewPrefs = {
  modelGroupMode: 'none',
  timeRange: '365d',
  collapsed: emptyCollapsedGroups(),
};

/** 普通对象判定：排除 null 与数组，其余对象都按记录读字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从白名单里取一个合法字符串，非法返回 undefined（调用方决定回落值）。 */
function readAllowed<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') return undefined;
  for (const item of allowed) {
    if (item === value) return item;
  }
  return undefined;
}

/**
 * 收起键数组归一化：必须是数组（否则按空），非字符串元素丢弃，字符串去首尾空白、
 * 丢空串、去重保序，最多 200 条——手改存储或旧版本残留都可能给出重复/超长列表。
 */
function normalizeCollapsedKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_COLLAPSED_KEYS) break;
  }
  return out;
}

/** 折叠状态归一化：只认三个 scope 与两个 mode，未知 scope/mode 丢弃。 */
function normalizeCollapsedGroups(raw: unknown): CollapsedGroups {
  const source = isRecord(raw) ? raw : {};
  const readScope = (scope: CollapseScope): CollapsedByMode => {
    const value = source[scope];
    const modes = isRecord(value) ? value : {};
    return {
      provider: normalizeCollapsedKeys(modes.provider),
      model: normalizeCollapsedKeys(modes.model),
    };
  };
  return {
    models: readScope('models'),
    dateDetail: readScope('dateDetail'),
    sessionDetail: readScope('sessionDetail'),
  };
}

/**
 * 任意原始值 → 视图偏好：非普通对象整体回落默认值，缺字段回落默认值，非法模式/范围
 * 回落默认值，折叠状态逐 scope/mode 归一化，未知键丢弃。返回的新对象可直接当快照。
 */
export function normalizeViewPrefs(raw: unknown): ViewPrefs {
  const source = isRecord(raw) ? raw : {};
  return {
    modelGroupMode: readAllowed(source.modelGroupMode, MODEL_GROUP_MODES) ?? VIEW_PREFS_DEFAULTS.modelGroupMode,
    timeRange: readAllowed(source.timeRange, TIME_RANGES) ?? VIEW_PREFS_DEFAULTS.timeRange,
    collapsed: normalizeCollapsedGroups(source.collapsed),
  };
}

/** 浏览器默认存储：无 window（Node / 测试）或访问被隐私策略拒绝时返回 undefined。 */
function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** 一份存储快照：归一化后的偏好 + 存储里是否已有显式记录（旧值采纳据此让位）。 */
interface StoredViewPrefs {
  prefs: ViewPrefs
  explicit: boolean
}

/** 从存储读一次：无键 / 坏 JSON / 非对象都按默认值，且不算「已有显式值」。 */
function readStoredViewPrefs(store: Pick<Storage, 'getItem'> | undefined): StoredViewPrefs {
  try {
    const raw = store?.getItem(VIEW_PREFS_STORAGE_KEY);
    if (!raw) return { prefs: VIEW_PREFS_DEFAULTS, explicit: false };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { prefs: VIEW_PREFS_DEFAULTS, explicit: false };
    return { prefs: normalizeViewPrefs(parsed), explicit: true };
  } catch {
    return { prefs: VIEW_PREFS_DEFAULTS, explicit: false };
  }
}

/** 读取存储里的视图偏好；存储不可用、无键或坏数据时回落默认值，从不返回 null。 */
export function readViewPrefs(storage?: Pick<Storage, 'getItem'>): ViewPrefs {
  return readStoredViewPrefs(storage ?? browserStorage()).prefs;
}

/** 两个折叠键数组是否逐项相同（归一化保持顺序，引用比较不可用）。 */
function sameKeys(first: readonly string[], second: readonly string[]): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}

/** 两份视图偏好是否等值：setter 据此决定要不要写盘与通知。 */
function sameViewPrefs(first: ViewPrefs, second: ViewPrefs): boolean {
  if (first.modelGroupMode !== second.modelGroupMode || first.timeRange !== second.timeRange) return false;
  return COLLAPSE_SCOPES.every((scope) => COLLAPSE_MODES.every(
    (mode) => sameKeys(first.collapsed[scope][mode], second.collapsed[scope][mode]),
  ));
}

/** 当前内存快照：未 attach 或读不到值时为默认值，setter 直接替换引用。 */
let current: ViewPrefs = VIEW_PREFS_DEFAULTS;

/** 绑定的存储：apply 调 attachViewPrefs 时确定；缺席时写操作静默跳过。 */
let boundStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined;

/** 本地是否已有显式值：存储里有记录或本次会话改过分组/时间范围后，旧值不再采纳。 */
let explicit = false;

/** 本地订阅者集合：setter 与 attach 读到变化时逐个通知。 */
const listeners = new Set<() => void>();

/** 通知所有订阅者：退订发生在通知中途也不影响其余订阅者。 */
function notifyViewPrefs(): void {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

/** 尽力写盘：存储不可用（隐私模式、配额满）时静默丢弃，内存快照已先行更新。 */
function persistViewPrefs(prefs: ViewPrefs): void {
  try {
    boundStorage?.setItem(VIEW_PREFS_STORAGE_KEY, JSON.stringify({
      version: VIEW_PREFS_VERSION,
      modelGroupMode: prefs.modelGroupMode,
      timeRange: prefs.timeRange,
      collapsed: prefs.collapsed,
    }));
  } catch {
    // 存储不可用：本次会话内仍按内存快照生效。
  }
}

/** 提交一份新快照：与旧值等值则完全不动作（不写盘、不通知），否则写盘并通知。 */
function publishViewPrefs(next: ViewPrefs): void {
  if (sameViewPrefs(current, next)) return;
  current = next;
  persistViewPrefs(next);
  notifyViewPrefs();
}

/** 返回替换了某个 scope + mode 折叠键数组的新快照，其余字段保持原引用。 */
function withCollapsedKeys(prefs: ViewPrefs, scope: CollapseScope, mode: CollapseMode, keys: string[]): ViewPrefs {
  return {
    ...prefs,
    collapsed: {
      ...prefs.collapsed,
      [scope]: { ...prefs.collapsed[scope], [mode]: keys },
    },
  };
}

/**
 * 绑定存储并读取一次（浏览器端 apply 调用一次）。
 *
 * 读到与当前快照不同的值时通知订阅者；返回的 detach 只解绑本次绑定的存储，
 * 不清空内存快照——热重载时新绑定先装、旧 detach 后跑也不会抹掉新值。
 * @param storage - 可注入的 localStorage 替身，测试用；省略用 window.localStorage。
 * @returns 解除绑定的函数。
 */
export function attachViewPrefs(storage?: Pick<Storage, 'getItem' | 'setItem'>): () => void {
  const store = storage ?? browserStorage();
  boundStorage = store;
  const stored = readStoredViewPrefs(store);
  explicit = stored.explicit;
  if (!sameViewPrefs(current, stored.prefs)) {
    current = stored.prefs;
    notifyViewPrefs();
  }
  return () => {
    if (boundStorage === store) boundStorage = undefined;
  };
}

/** 当前视图偏好快照：引用稳定，只在真正变化时替换（useSyncExternalStore 依赖它判等）。 */
export function viewPrefsSnapshot(): ViewPrefs {
  return current;
}

/** 订阅视图偏好变化，返回取消订阅函数。 */
export function subscribeViewPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 切换模型表分组模式：写入内存快照并尽力落盘，刷新页面后保持。 */
export function setModelGroupMode(mode: ModelGroupMode): void {
  // 本次会话的选择也算显式值：存储不可用时，后到的旧配置残留不得把它盖掉。
  explicit = true;
  if (current.modelGroupMode === mode) return;
  publishViewPrefs({ ...current, modelGroupMode: mode });
}

/** 切换时间范围：模型页与日期页共用同一份记忆，刷新页面后保持。 */
export function setTimeRange(range: TimeRange): void {
  explicit = true;
  if (current.timeRange === range) return;
  publishViewPrefs({ ...current, timeRange: range });
}

/**
 * 切换某个模型表在某种分组模式下的组折叠状态：已收起则展开、未收起则收起。
 * 组键先 trim，空串忽略；单个数组达到上限时不再追加（避免无限增长）。
 */
export function toggleGroupCollapsed(scope: CollapseScope, mode: CollapseMode, key: string): void {
  const target = key.trim();
  if (!target) return;
  const keys = current.collapsed[scope][mode];
  const index = keys.indexOf(target);
  if (index >= 0) {
    publishViewPrefs(withCollapsedKeys(current, scope, mode, keys.filter((item) => item !== target)));
    return;
  }
  if (keys.length >= MAX_COLLAPSED_KEYS) return;
  publishViewPrefs(withCollapsedKeys(current, scope, mode, [...keys, target]));
}

/**
 * 清理某个模型表里已消失的组键（keys 是当前存在的组键）。
 *
 * 只删死键，绝不把用户收起的键加回来；没有死键时不写盘、不通知。
 */
export function pruneCollapsedGroups(scope: CollapseScope, mode: CollapseMode, keys: readonly string[]): void {
  const alive = new Set(keys);
  const currentKeys = current.collapsed[scope][mode];
  const nextKeys = currentKeys.filter((key) => alive.has(key));
  if (nextKeys.length === currentKeys.length) return;
  publishViewPrefs(withCollapsedKeys(current, scope, mode, nextKeys));
}

/**
 * 采纳旧版本 localStorage 键（dsh-usage-stats.settings）里的分组模式与时间范围。
 *
 * 旧键在 0.4.x 之后已由 migrateLegacySettings 迁到配置文档并删除，这里只兜住还没迁完
 * 的浏览器；配置文档里的历史残留不参与（schema 已不声明，投影后的值读不到，也不该
 * 把配置文档当成视图偏好的来源）。
 *
 * 只在本地尚无显式值时种入：存储里已有记录、或本次会话已改过这两项，就整体跳过——
 * 旧值不得覆盖用户当前的显式选择。两个字段逐个校验，非法字段忽略；两者都非法时
 * 完全不动作。与当前快照等值时不写盘也不通知，但视为已处理，后续旧来源不再覆盖。
 * @param legacy - 旧 localStorage 键的原始解析值。
 */
export function adoptLegacyViewPrefs(legacy: unknown): void {
  if (explicit || !isRecord(legacy)) return;
  const mode = readAllowed(legacy.modelGroupMode, MODEL_GROUP_MODES);
  const range = readAllowed(legacy.timeRange, TIME_RANGES);
  if (mode === undefined && range === undefined) return;
  explicit = true;
  publishViewPrefs({
    modelGroupMode: mode ?? current.modelGroupMode,
    timeRange: range ?? current.timeRange,
    collapsed: current.collapsed,
  });
}
