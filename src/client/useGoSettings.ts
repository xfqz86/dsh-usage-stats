/**
 * 偏好设置的 React hook（浏览器端）。
 *
 * 初始化时从 localStorage 读取（loadUsageSettings），更新时同步写入
 * （saveUsageSettings），保证刷新页面后设置仍生效；写入失败静默降级。
 *
 * 返回 [settings, update]：update 接受 Partial 局部合并并做夹取与持久化。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampGoFetchMinutes,
  loadUsageSettings,
  saveUsageSettings,
  type UsageSettings,
} from './settings.ts'

/** 偏好设置 hook：读取即持久（localStorage）。 */
export function useGoSettings(): [UsageSettings, (patch: Partial<UsageSettings>) => void] {
  const [settings, setSettings] = useState<UsageSettings>(() => loadUsageSettings())
  const isFirstRef = useRef(true)

  // 副作用移出 setState updater，避免 StrictMode 双写；通过 effect 持久化
  useEffect(() => {
    if (isFirstRef.current) { isFirstRef.current = false; return }
    saveUsageSettings(settings)
  }, [settings])

  /** 局部合并更新：间隔夹到下限后写入存储。 */
  const update = useCallback((patch: Partial<UsageSettings>) => {
    setSettings((prev) => ({
      ...prev,
      ...patch,
      goFetchMinutes: clampGoFetchMinutes(patch.goFetchMinutes ?? prev.goFetchMinutes),
    }))
  }, [])

  return [settings, update]
}
