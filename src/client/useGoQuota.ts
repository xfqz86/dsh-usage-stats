/**
 * OpenCode Go 订阅额度轮询（浏览器端）。
 *
 * 服务端（Host）提供 POST /usage-stats/api/go-quota（回环围栏 + TTL 缓存），
 * 本 hook 定期轮询；额度窗口（滚动 5 小时 / 本周 / 本月）显示在底部角标
 * 与模态窗详情里。轮询间隔与开关来自偏好设置（settings.ts）：
 *   - enabled 为 false 时不发起任何请求（关闭 Go 额度抓取）；
 *   - 间隔按分钟配置（下限 3 分钟，默认 5 分钟），请求体携带 intervalMinutes，
 *     服务端据此把 TTL 缓存调成 min(5 分钟, 间隔)，让实际打官方端点的频率
 *     与设置的抓取间隔一致。
 * GoWindow / GoQuota 协议类型定义在 types.ts（与 host 端 goquota 统一）。
 */

import { useCallback, useEffect, useState } from 'react'
import type { GoQuota } from '../types.ts'
import { clampGoFetchMinutes } from './settings.ts'

/** 协议类型单一定义在 types.ts，此处 re-export 保持对外引用面。 */
export type { GoQuota, GoWindow } from '../types.ts'

/**
 * 每 `intervalMinutes` 分钟轮询一次额度；未启用 / 请求失败 / 尚未加载时为
 * null。返回 [数据, 手动刷新]。
 */
export function useGoQuota(
  enabled: boolean,
  intervalMinutes: number,
): [GoQuota | null, () => void] {
  const [data, setData] = useState<GoQuota | null>(null)

  useEffect(() => {
    if (!enabled) {
      // 未启用额度抓取：清空已拉数据、不发起任何请求。
      setData(null)
      return
    }
    // 防御性夹取：偏好已夹到下限，这里再兜底一次防止误用。
    const minutes = clampGoFetchMinutes(intervalMinutes)
    let live = true
    const load = async () => {
      let parsed: { ok?: boolean; value?: GoQuota } = {}
      try {
        const response = await fetch('/usage-stats/api/go-quota', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ intervalMinutes: minutes }),
        })
        parsed = await response.json().catch(() => ({}))
      } catch {
        parsed = {}
      }
      if (!live) return
      if (parsed.ok === true && parsed.value) setData(parsed.value)
    }
    load()
    const timerId = window.setInterval(load, minutes * 60 * 1000)
    return () => { live = false; window.clearInterval(timerId) }
    // intervalMinutes 参与夹取，effect 依赖用原始值以感知变化。
  }, [enabled, intervalMinutes])

  /** 手动触发一次立即刷新（未启用时忽略）：直接带 force 抓取，绕过服务端
   *   TTL 缓存与本地轮询间隔，不重置轮询定时器。 */
  const refresh = useCallback(() => {
    if (!enabled) return
    const minutes = clampGoFetchMinutes(intervalMinutes)
    void (async () => {
      try {
        const response = await fetch('/usage-stats/api/go-quota', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ intervalMinutes: minutes, force: true }),
        })
        const parsed = await response.json().catch(() => ({}))
        if (parsed.ok === true && parsed.value) setData(parsed.value)
      } catch {
        // 强制抓取失败：保留旧数据，等待下一个轮询周期自然恢复。
      }
    })()
  }, [enabled, intervalMinutes])

  return [data, refresh]
}
