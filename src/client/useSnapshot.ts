/**
 * 用量统计浏览器端（Client）的快照轮询。
 *
 * 服务端（Host）提供 POST /usage-stats/api/snapshot（回环围栏 + CSRF 围栏：
 * 所有 /usage-stats/api/* POST 必须携带 x-dsh-usage-stats 请求头，否则 403）。
 * 本 hook 维持一个 4s 轮询，底部角标与模态窗共用同一份数据。
 * UsageAgg / SeriesPoint 协议类型定义在 types.ts（与 host 端 Agg /
 * SeriesPoint 统一，避免两端镜像漂移）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageAgg, SeriesPoint } from '../types.ts'
import { API_HEADERS } from './api.ts'

/** 协议类型单一定义在 types.ts，此处 re-export 保持对外引用面。 */
export type { UsageAgg, SeriesPoint } from '../types.ts'

/** 按模型/Provider 的拆分条目。 */
export interface ModelStat {
  provider: string
  model: string
  calls: number
  usage: UsageAgg
  /** 按日细分（用于时间范围筛选与堆叠柱），可能缺失于旧快照。 */
  series?: SeriesPoint[]
}

/** 按会话的拆分条目（已含子代理归属字段，复用 SessionHeader 语义，序列化为 string|null）。 */
export interface SessionStat {
  id: string
  title: string
  cwd: string
  createdAt: number
  lastActive: number
  calls: number
  usage: UsageAgg
  parentSession: string | null
  origin: string | null
  delegationDepth: number
}

/**
 * 快照业务体：路由响应为 { ok, value } 外层包装（ok 由围栏与处理结果给出），
 * 此处类型对应其中的 value 部分，不再含内层 ok 字段。
 */
export interface UsageSnapshot {
  scanning: boolean
  scans: number
  failed: number
  rawSessions: number
  harnessSessions: number
  foldedEvents: number
  dedupSkipped: number
  lastError: string | null
  scanError: string | null
  lastScanAt: number
  time: number
  sessions: number
  current: { id: string; calls: number; usage: UsageAgg } | null
  all: { calls: number; usage: UsageAgg }
  series: { all: SeriesPoint[]; current: SeriesPoint[] }
  models: ModelStat[]
  sessionsList: SessionStat[]
  sessionsListTotal?: number
}

/** 每 `intervalMs` 轮询一次服务端快照；返回 [快照, 是否出错, 手动刷新]。 */
export function useSnapshot(intervalMs = 4000): [UsageSnapshot | null, boolean, () => void] {
  const [data, setData] = useState<UsageSnapshot | null>(null)
  const [err, setErr] = useState(false)
  const [tick, setTick] = useState(0)
  // 乱序守卫：每次发起请求取递增序号，响应返回时若已有更新的请求发出
  // （自身序号不再是最新），丢弃本次结果，防止旧响应覆盖新数据。
  const seqRef = useRef(0)

  useEffect(() => {
    let live = true
    setErr(false)
    const load = async () => {
      const mine = ++seqRef.current
      let parsed: { ok?: boolean; value?: UsageSnapshot } = {}
      try {
        const response = await fetch('/usage-stats/api/snapshot', {
          method: 'POST',
          headers: API_HEADERS,
          body: JSON.stringify({ sessionId: null, limit: 500 }),
        })
        parsed = await response.json().catch(() => ({}))
      } catch (e) {
        parsed = {}
      }
      if (!live || mine !== seqRef.current) return
      if (parsed.ok === true && parsed.value) {
        setData(parsed.value)
        setErr(false)
      } else {
        setErr(true)
        // 保留旧数据，仅标记错误，避免 4s 轮询抖动导致界面闪烁
      }
    }
    load()
    const timerId = window.setInterval(load, intervalMs)
    return () => { live = false; window.clearInterval(timerId) }
  }, [intervalMs, tick])

  /** 手动触发一次立即刷新（设置页"手动刷新"按钮用）。 */
  const refresh = useCallback(() => setTick(v => v + 1), [])

  return [data, err, refresh]
}
