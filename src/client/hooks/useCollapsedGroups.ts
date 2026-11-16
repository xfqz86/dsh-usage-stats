/**
 * 分组折叠状态 hook：读写某个模型表（scope + 分组模式）在浏览器本地视图偏好里的收起组。
 *
 * 默认全部展开；只清理已消失的组键，绝不把用户收起的键加回来。
 * 分组模式为 none 时没有组头，恒展开且 toggle 为空操作。
 */

import { useEffect } from 'react';

import { pruneCollapsedGroups, toggleGroupCollapsed } from '../viewPrefs.ts';

import { useViewPrefs } from './useViewPrefs.ts';

import type { ModelGroupMode } from '../../types.ts';
import type { CollapseScope } from '../viewPrefs.ts';

/** 无分组时的空收起表：与默认全展开等价。 */
const NO_COLLAPSED: readonly string[] = [];

/**
 * 分组折叠状态：默认全部展开，新组默认展开，只清死键。
 * @param scope - 折叠状态所属的模型表。
 * @param mode - 当前分组模式；'none' 时不读也不写折叠状态。
 * @param keys - 当前存在的组键，用于清理死键。
 */
export function useCollapsedGroups(
  scope: CollapseScope,
  mode: ModelGroupMode,
  keys: string[],
): {
  isExpanded: (k: string) => boolean
  toggle: (k: string) => void
} {
  const prefs = useViewPrefs();
  const collapsed: readonly string[] = mode === 'none' ? NO_COLLAPSED : prefs.collapsed[scope][mode];

  // 只清掉已不在 keys 里的死键，绝不把用户收起的 keys 加回来；无死键时 prune 不写不通知，
  // 因此 keys 每次渲染新建数组、effect 每次跑一遍也不会自激。
  useEffect(() => {
    if (mode === 'none') return;
    pruneCollapsedGroups(scope, mode, keys);
  }, [scope, mode, keys]);

  const toggle = (k: string): void => {
    if (mode === 'none') return;
    toggleGroupCollapsed(scope, mode, k);
  };
  const isExpanded = (k: string): boolean => !collapsed.includes(k);
  return { isExpanded, toggle };
}
