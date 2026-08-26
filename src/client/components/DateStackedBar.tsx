/**
 * 日期堆叠柱状图（DateStackedBar）：每日一柱，按 token 类型堆叠，横向滚动。
 * 复用 stats 的 buildDateStack 与 DATE_TOKEN_META，悬停显示当日分类型明细。
 * 独立成文件（一个组件一个文件），样式见 DateStackedBar.module.css。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DateStackedBar.module.css'
import type { SeriesPoint } from '../../types.ts'
import { buildDateStack, getDateTokenMeta, fmtFull, type DateRange } from '../stats.ts'

/** 日期堆叠柱：每日一柱，token 类型分段堆叠，悬停 tooltip 显示当日明细。 */
export function DateStackedBar({
  series, range, t,
}: {
  series: SeriesPoint[]
  range: DateRange
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  const stack = useMemo(() => buildDateStack(series, range, t as unknown as (k: string, p?: Record<string, unknown>) => string), [series, range, t])
  const [tip, setTip] = useState<{ dayIndex: number; x: number; y: number } | null>(null)
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  // 默认滚动到今日列（最右侧），范围切换或数据更新时重新对齐
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth
    })
    return () => cancelAnimationFrame(raf)
  }, [stack.days.length])

  useEffect(() => {
    if (!tip) { setTipPos(null); return }
    const w = tipRef.current?.offsetWidth ?? 180
    const h = tipRef.current?.offsetHeight ?? 60
    const wrapW = wrapRef.current?.clientWidth ?? 300
    let left = tip.x - w / 2
    const scrollLeft = wrapRef.current?.scrollLeft ?? 0
    const visibleLeft = scrollLeft
    const visibleRight = scrollLeft + wrapW
    left = Math.max(visibleLeft + 4, Math.min(left, visibleRight - w - 4))
    let top = tip.y - h - 10
    top = Math.max(4, top)
    setTipPos({ left, top })
  }, [tip])

  const tipFromEvent = (e: React.MouseEvent, dayIndex: number) => {
    const wrap = wrapRef.current
    if (!wrap) return { x: 0, y: 0, dayIndex }
    const r = wrap.getBoundingClientRect()
    const x = e.clientX - r.left + wrap.scrollLeft
    const y = e.clientY - r.top + wrap.scrollTop
    return { x, y, dayIndex }
  }

  if (stack.days.length === 0) {
    return <div className={css.empty}>{t('state.noUsage')}</div>
  }

  const max = stack.maxTotal || 1
  const H = 100 // 柱高
  const tipDay = tip != null ? stack.days[tip.dayIndex] : null

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{t('panel.trend')}</span>
        <span className={css.legend}>
          {getDateTokenMeta(t as unknown as (k: string, p?: Record<string, unknown>) => string).map((meta) => (
            <span key={meta.key} className={css.legendItem}>
              <span className={css.legendDot} style={{ background: meta.color }} />
              <span>{meta.label}</span>
            </span>
          ))}
        </span>
      </div>
      <div className={css.scroll} ref={wrapRef} onMouseLeave={() => setTip(null)} style={{ position: 'relative' }}>
        <div className={css.grid}>
          {stack.days.map((day, idx) => (
            <div
              key={day.t}
              className={css.barCol}
              onMouseEnter={(e) => setTip(tipFromEvent(e, idx))}
              onMouseMove={(e) => {
                if (!tip || tip.dayIndex !== idx) return
                setTip(tipFromEvent(e, idx))
              }}
            >
              {day.segments.length === 0 ? (
                <span style={{ height: 1, background: 'transparent' }} />
              ) : (
                day.segments.map((seg) => {
                  const h = max > 0 ? (seg.value / max) * H : 0
                  return (
                    <span
                      key={seg.key}
                      className={css.barSeg}
                      style={{ height: Math.max(1, h) + 'px', background: seg.color }}
                    />
                  )
                })
              )}
            </div>
          ))}
          {/* 网格线（25%/50%/75%） */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: '25%', height: 1, background: 'var(--dsw-alias-border-l1)', opacity: 0.35, pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, background: 'var(--dsw-alias-border-l1)', opacity: 0.35, pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', left: 0, right: 0, top: '75%', height: 1, background: 'var(--dsw-alias-border-l1)', opacity: 0.35, pointerEvents: 'none' }} />
        </div>
        <div className={css.axis}>
          {(() => {
            const total = stack.days.length
            const step = Math.max(1, Math.ceil(total / 14))
            return stack.days.map((day, idx) => {
              const isLast = idx === total - 1
              const isFirst = idx === 0
              const visible = isFirst || isLast || idx % step === 0
              return (
                <span key={day.t} className={css.axisLabel} title={new Date(day.t).toLocaleDateString()}>
                  {visible ? day.label : ''}
                </span>
              )
            })
          })()}
        </div>
        {tipDay && (
          <div
            ref={tipRef}
            className={css.tip}
            style={{ left: (tipPos ? tipPos.left : 0) + 'px', top: (tipPos ? tipPos.top : 0) + 'px', opacity: tipPos ? 1 : 0 }}
          >
            <div className={css.tipDate}>{t('dates.tipFull', { date: new Date(tipDay.t).toLocaleDateString(), total: fmtFull(tipDay.total), calls: fmtFull(tipDay.calls) })}</div>
            {tipDay.segments.length === 0 ? (
              <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>—</div>
            ) : (
              tipDay.segments.map((seg) => (
                <div key={seg.key} className={css.tipRow}>
                  <span className={css.tipDot} style={{ background: seg.color }} />
                  <span className={css.tipModel}>{seg.label}</span>
                  <span className={css.tipVal}>{fmtFull(seg.value)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
