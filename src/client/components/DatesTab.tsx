/**
 * 日期 Tab：每日趋势曲线 + 时间范围切换，悬停 tooltip 显示当日明细。
 * 独立成文件（一个组件一个文件）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SeriesPoint } from '../../types.ts'
import css from './DatesTab.module.css'
import shared from './UsageStatsCommon.module.css'
import { buildSet, curveOf, dayTotal, fmtFull, fullDayLabel } from '../stats.ts'

/** 时间范围选项：值 + 对应文案键。 */
const RANGE_KEYS = [
  ['7d', 'range.7d'],
  ['14d', 'range.14d'],
  ['30d', 'range.30d'],
  ['all', 'range.all'],
] as const
type RangeKey = typeof RANGE_KEYS[number][0]

/** 日期 Tab：每日趋势（曲线 + 时间范围），悬停 tooltip 显示当日明细。 */
export function DatesTab({
  series, t,
}: {
  series: SeriesPoint[]
  t: PropsLocale<'dsh-usage-statistics'>['t']
}) {
  const [range, setRange] = useState<RangeKey>('7d')
  const [tip, setTip] = useState<{ x: number; y: number; label: string; total: number; calls: number } | null>(null)
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  const buckets = useMemo(() => buildSet(series, range), [range, series])
  const curve = useMemo(() => curveOf(buckets, 300, 130), [buckets])

  // 把 tooltip 约束在图表区域内。
  useEffect(() => {
    if (!tip) { setTipPos(null); return }
    const w = tipRef.current?.offsetWidth ?? 180
    const h = tipRef.current?.offsetHeight ?? 40
    const chartW = 300
    let left = tip.x - w / 2
    left = Math.max(6, Math.min(left, chartW - w - 6))
    let top = tip.y - h - 10
    top = Math.max(6, Math.min(top, 130))
    setTipPos({ left, top })
  }, [tip])

  /** 由鼠标事件换算图表内的坐标。 */
  const tipFromEvent = (e: React.MouseEvent) => {
    let x = 20, y = 20
    const el = chartRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      x = e.clientX - r.left
      y = e.clientY - r.top
    }
    return { x, y }
  }

  return (
    <div className={shared.section}>
      <div className={shared.sectionHead}>
        <span className={shared.sectionLabel}>{t('panel.trend')}</span>
        <span className={css.chips}>
          {RANGE_KEYS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={range === value ? `${css.chip} ${css.chipOn}` : css.chip}
              onClick={() => setRange(value)}
            >{t(label)}</button>
          ))}
        </span>
      </div>
      <div
        className={css.chart}
        ref={chartRef}
        onMouseLeave={() => setTip(null)}
      >
        {!curve
          ? <div className={shared.empty}>{t('state.noUsage')}</div>
          : (
            <svg className={css.svg} viewBox={`0 0 ${curve.W} ${curve.H}`}>
                {[0.25, 0.5, 0.75].map(f => (
                  <line key={'g' + f} x1={0} x2={curve.W} y1={curve.H * f} y2={curve.H * f} className={css.gridline} />
                ))}
                <defs>
                  <linearGradient id="usu-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--dsw-alias-brand-primary,#4d6bfe)" stopOpacity=".25" />
                    <stop offset="100%" stopColor="var(--dsw-alias-brand-primary,#4d6bfe)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={curve.area} fill="url(#usu-area)" stroke="none" />
                <path d={curve.line} fill="none" stroke="var(--dsw-alias-brand-primary,#4d6bfe)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                {curve.hits.map((h, i) => (
                  <g
                    key={'h' + i}
                    onMouseEnter={(e: React.MouseEvent) => {
                      e.stopPropagation()
                      const p = tipFromEvent(e)
                      setTip({ x: p.x, y: p.y, label: fullDayLabel(h.b.t), total: dayTotal(h.b), calls: h.b.calls })
                    }}
                  >
                    <circle cx={h.cx} cy={h.cy} r={7} fill="transparent" />
                    <circle cx={h.cx} cy={h.cy} r={2.5} fill="var(--dsw-alias-brand-primary,#4d6bfe)" />
                  </g>
                ))}
                {(function () {
                  const n = curve.hits.length
                  const idxs = n === 1 ? [0] : n === 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1]
                  return idxs.map((i, k) => (
                    <text key={'l' + k} x={curve.hits[i].cx} y={curve.H - 3} className={css.axisLabel} textAnchor="middle">
                      {curve.hits[i].label}
                    </text>
                  ))
                })()}
              </svg>
          )}
        {tip && (
          <div
            ref={tipRef}
            className={css.tip}
            style={{ left: (tipPos ? tipPos.left : 0) + 'px', top: (tipPos ? tipPos.top : 0) + 'px', opacity: tipPos ? 1 : 0 }}
          >
            <div>{tip.label}</div>
            <div>总 <b>{fmtFull(tip.total)}</b> tokens · 调 {fmtFull(tip.calls)}</div>
          </div>
        )}
      </div>
    </div>
  )
}
