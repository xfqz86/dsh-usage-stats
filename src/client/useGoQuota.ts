/**
 * OpenCode Go 订阅额度轮询（浏览器端）。
 *
 * 服务端（Host）提供 POST /usage-stats/api/go-quota（回环围栏 + TTL 缓存），
 * 本 hook 定期轮询；额度窗口（滚动 5 小时 / 本周 / 本月）显示在底部角标
 * 与模态窗详情里。服务端缓存 5 分钟，本地 60s 轮询几乎不触达官方端点。
 */

import { useCallback, useEffect, useState } from 'react'

/** 单个额度窗口（用量百分比 + 重置时间）。 */
export interface GoWindow {
  percent: number
  resetsAt: string
}

/** 服务端 go-quota 路由的返回体（status 决定本地化文案）。 */
export interface GoQuota {
  status: 'ok' | 'no-key' | 'error'
  fetchedAt: number
  rolling: GoWindow | null
  weekly: GoWindow | null
  monthly: GoWindow | null
}

/** 每 `intervalMs` 轮询一次额度；未加载 / 请求失败时为 null。返回 [数据, 手动刷新]。 */
export function useGoQuota(intervalMs = 60000): [GoQuota | null, () => void] {
  const [data, setData] = useState<GoQuota | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    const load = async () => {
      let parsed: { ok?: boolean; value?: GoQuota } = {}
      try {
        const response = await fetch('/usage-stats/api/go-quota', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        parsed = await response.json().catch(() => ({}))
      } catch (e) {
        parsed = {}
      }
      if (!live) return
      if (parsed.ok === true && parsed.value) setData(parsed.value)
    }
    load()
    const timerId = window.setInterval(load, intervalMs)
    return () => { live = false; window.clearInterval(timerId) }
  }, [intervalMs, tick])

  /** 手动触发一次立即刷新。 */
  const refresh = useCallback(() => setTick(v => v + 1), [])

  return [data, refresh]
}