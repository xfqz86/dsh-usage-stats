/**
 * 模型分组折叠状态：默认全部展开，记住用户收起的行。
 */

import { useEffect, useState } from 'react';

/** 模型分组折叠状态：默认全部展开，新 key 默认展开，只清死 key。 */
export function useCollapsedGroups(keys: string[]): {
  isExpanded: (k: string) => boolean
  toggle: (k: string) => void
} {
  // 默认全部展开：初始空集，新 key 默认展开。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set<string>());
  // 只清掉已不在 keys 里的死 key，绝不把用户收起的 key 加回来。
  useEffect(() => {
    setCollapsed((prev) => {
      let stale = false;
      for (const k of prev) {
        if (!keys.includes(k)) {
          stale = true;
          break;
        }
      }
      if (!stale) return prev;
      const next = new Set<string>();
      for (const k of prev) {
        if (keys.includes(k)) next.add(k);
      }
      return next;
    });
  }, [keys]);
  const toggle = (k: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const isExpanded = (k: string): boolean => !collapsed.has(k);
  return { isExpanded, toggle };
}
