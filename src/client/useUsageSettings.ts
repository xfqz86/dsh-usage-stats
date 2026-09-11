/**
 * 偏好设置的 React hook（浏览器端）。
 *
 * 取值来自服务端设置文档（经 settingsScope 的作用域，见 settings.ts），
 * 用 useSyncExternalStore 订阅作用域快照：作用域未就绪时先渲染默认值，
 * 服务端取值到达后自动刷新；写入走 updateUsageSettings 落服务端设置文档，
 * 于是刷新页面、换浏览器、换机器都保持同一份偏好。
 *
 * 返回 [settings, update]：update 接受 Partial 局部合并并做夹取后写回。
 * 设置页另用 useUsageSettingsView 读存储状态，提示设置落在服务端文档、不可用时明确告知。
 */

import { useCallback, useSyncExternalStore } from 'react';

import { subscribeUsageSettings, updateUsageSettings, usageSettingsView } from './settings.ts';

import type { UsageSettingsView } from './settings.ts';
import type { UsageSettings } from '../types.ts';

/** 偏好设置 hook：读取即订阅服务端设置文档，同时支持 Go、DeepSeek 与 Z.ai 三组偏好。 */
export function useUsageSettings(): [UsageSettings, (patch: Partial<UsageSettings>) => void] {
  const view = useSyncExternalStore(subscribeUsageSettings, usageSettingsView, usageSettingsView);
  const update = useCallback((patch: Partial<UsageSettings>) => {
    updateUsageSettings(patch);
  }, []);
  return [view.settings, update];
}

/** 偏好存储状态 hook：设置页据此提示设置存放在服务端配置文件的何处、当前是否可写。 */
export function useUsageSettingsView(): UsageSettingsView {
  return useSyncExternalStore(subscribeUsageSettings, usageSettingsView, usageSettingsView);
}
