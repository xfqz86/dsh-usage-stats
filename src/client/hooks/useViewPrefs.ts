/**
 * 视图偏好的 React 绑定：用 useSyncExternalStore 订阅浏览器本地存储里的分组、时间范围与折叠状态。
 *
 * 存储不可用（隐私模式、无 window）时恒为默认值；setter 仍会更新内存快照并通知，
 * 本次会话内界面照常响应，刷新后回落默认值。
 */

import { useSyncExternalStore } from 'react';

import { subscribeViewPrefs, viewPrefsSnapshot } from '../viewPrefs.ts';

import type { ViewPrefs } from '../viewPrefs.ts';

/** 读取即订阅视图偏好：同一引用稳定，避免每次渲染重绘表格。 */
export function useViewPrefs(): ViewPrefs {
  return useSyncExternalStore(subscribeViewPrefs, viewPrefsSnapshot, viewPrefsSnapshot);
}
