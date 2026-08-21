/**
 * 偏好设置的 React hook（浏览器端）。
 *
 * 初始化时从 localStorage 读取（loadUsageSettings），更新时同步写入
 * （saveUsageSettings），保证刷新页面后设置仍生效；写入失败静默降级。
 *
 * 返回 [settings, update]：update 接受 Partial 局部合并并做夹取与持久化。
 */

import { useCallback, useState } from 'react'
import {
  clampGoFetchMinutes,
  loadUsageSettings,
  saveUsageSettings,
  type UsageSettings,
} from './settings.ts'

/** 偏好设置 hook：读取即持久（localStorage）。 */
export function useGoSettings(): [UsageSettings, (patch: Partial<UsageSettings>) => void] {
  const [settings, setSettings] = useState<UsageSettings>(() => loadUsageSettings())

  /** 局部合并更新：间隔夹到下限后写入存储。 */
  const update = useCallback((patch: Partial<UsageSettings>) => {
    setSettings((prev) => {
      const next: UsageSettings = {
        ...prev,
        ...patch,
        goFetchMinutes: clampGoFetchMinutes(patch.goFetchMinutes ?? prev.goFetchMinutes),
      }
      saveUsageSettings(next)
      return next
    })
  }, [])

  return [settings, update]
}
