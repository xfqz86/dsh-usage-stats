/**
 * 统一堆叠柱状图（StackedBar）：合并 DateStackedBar 与 ModelStackedBar 为单一组件。
 * 每日一柱、按 token 类型（date 模式）或按模型（model 模式）堆叠，横向滚动。
 * 抽提公共壳逻辑：wrapRef/tipRef、tip/tipPos 状态、滚动到末尾、悬浮定位、空状态、
 * header+图例容器、scroll+grid+axis+tip 壳；差异仅在图例、柱段与 tooltip 的分支渲染。
 * 样式已合并至 StackedBar.module.css（单文件承载公共壳与变体类）。
 * 独立成文件（一个组件一个文件）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StackedBar.module.css'
import type { SeriesPoint } from '../../types.ts'
import type { ModelStat } from '../useSnapshot.ts'
import { buildDateStack, buildModelStack, fmtFull, getDateTokenMeta, modelColorAt, type DateRange, type ModelRange } from '../stats.ts'

/** 统一堆叠柱：discriminated union，date 模式按 token 类型堆叠，model 模式按模型堆叠。 */
export type StackedBarProps =
  | {
      mode: 'date'
      series: SeriesPoint[]
      range: DateRange
      t: PropsLocale<'dsh-usage-stats'>['t']
    }
  | {
      mode: 'model'
      models: ModelStat[]
      range: ModelRange
      t: PropsLocale<'dsh-usage-stats'>['t']
    }

export function StackedBar(props: StackedBarProps) {
  const { mode, t } = props
  const isDate = mode === 'date'

  // 分支所需的原始输入（保证 hooks 调用顺序稳定）
  const dateSeries = isDate ? (props as Extract<StackedBarProps, { mode: 'date' }>).series : null
  const dateRange = isDate ? (props as Extract<StackedBarProps, { mode: 'date' }>).range : null
  const modelModels = !isDate ? (props as Extract<StackedBarProps, { mode: 'model' }>).models : null
  const modelRange = !isDate ? (props as Extract<StackedBarProps, { mode: 'model' }>).range : null

  const dateStack = useMemo(() => {
    if (!isDate || dateSeries == null || dateRange == null) return null
    return buildDateStack(dateSeries, dateRange, t as unknown as (k: string, p?: Record<string, unknown>) => string)
  }, [isDate, dateSeries, dateRange, t])

  const modelStack = useMemo(() => {
    if (isDate || modelModels == null || modelRange == null) return null
    return buildModelStack(modelModels, modelRange)
  }, [isDate, modelModels, modelRange])

  // 模型模式的配色映射（与饼图一致，按过滤后 total 降序）
  const colorMap = useMemo(() => {
    if (isDate || !modelStack) return null
    const m = new Map<string, string>()
    modelStack.models.forEach((mod, idx) => {
      m.set(mod.provider + '\u0000' + mod.model, modelColorAt(idx))
    })
    return m
  }, [isDate, modelStack])

  const [tip, setTip] = useState<{ dayIndex: number; x: number; y: number } | null>(null)
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  const days = isDate ? (dateStack?.days ?? []) : (modelStack?.days ?? [])
  const max = isDate ? (dateStack?.maxTotal ?? 1) : (modelStack?.maxTotal ?? 1)
  const H = 100 // 柱高

  // 默认滚动到今日列（最右侧），范围切换或数据更新时重新对齐
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth
    })
    return () => cancelAnimationFrame(raf)
  }, [days.length])

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

  if (days.length === 0) {
    return <div className={css.empty}>{t('state.noUsage')}</div>
  }

  const tipDay = tip != null ? (days[tip.dayIndex] as (typeof days)[number]) : null

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{t('panel.trend')}</span>
        <span className={`${css.legend} ${isDate ? css.legendDate : css.legendModel}`}>
          {isDate
            ? getDateTokenMeta(t as unknown as (k: string, p?: Record<string, unknown>) => string).map((meta) => (
                <span key={meta.key} className={css.legendItem}>
                  <span className={css.legendDot} style={{ background: meta.color }} />
                  <span>{meta.label}</span>
                </span>
              ))
            : (
                <>
                  {modelStack!.models.slice(0, 6).map((m) => (
                    <span key={m.provider + '\u0000' + m.model} className={css.legendItem}>
                      <span className={css.legendDot} style={{ background: colorMap!.get(m.provider + '\u0000' + m.model) }} />
                      <span>{m.model}</span>
                    </span>
                  ))}
                  {modelStack!.models.length > 6 && <span className={css.legendItem}>+{modelStack!.models.length - 6}</span>}
                </>
              )}
        </span>
      </div>
      <div className={css.scroll} ref={wrapRef} onMouseLeave={() => setTip(null)} style={{ position: 'relative' }}>
        <div className={css.grid}>
          {days.map((day, idx) => (
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
              ) : isDate ? (
                (day.segments as Array<{ key: string; label: string; value: number; color: string }>).map((seg) => {
                  const h = max > 0 ? (seg.value / max) * H : 0
                  return (
                    <span
                      key={seg.key}
                      className={css.barSeg}
                      style={{ height: Math.max(1, h) + 'px', background: seg.color }}
                    />
                  )
                })
              ) : (
                (day.segments as Array<{ provider: string; model: string; total: number }>).map((seg) => {
                  const h = max > 0 ? (seg.total / max) * H : 0
                  const color = colorMap!.get(seg.provider + '\u0000' + seg.model) ?? '#8a8a8a'
                  return (
                    <span
                      key={seg.provider + '\u0000' + seg.model}
                      className={css.barSeg}
                      style={{ height: Math.max(1, h) + 'px', background: color }}
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
            const total = days.length
            const step = Math.max(1, Math.ceil(total / 14))
            return days.map((day, idx) => {
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
            {isDate ? (
              <>
                <div className={css.tipDate}>{t('dates.tipFull', { date: new Date((tipDay as { t: number; total: number; calls: number }).t).toLocaleDateString(), total: fmtFull((tipDay as { total: number }).total), calls: fmtFull((tipDay as { calls: number }).calls) })}</div>
                {tipDay.segments.length === 0 ? (
                  <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>—</div>
                ) : (
                  (tipDay.segments as Array<{ key: string; label: string; value: number; color: string }>).map((seg) => (
                    <div key={seg.key} className={css.tipRow}>
                      <span className={css.tipDot} style={{ background: seg.color }} />
                      <span className={css.tipModel}>{seg.label}</span>
                      <span className={css.tipVal}>{fmtFull(seg.value)}</span>
                    </div>
                  ))
                )}
              </>
            ) : (
              <>
                <div className={css.tipDate}>{new Date(tipDay.t).toLocaleDateString()} · {fmtFull((tipDay as { total: number }).total)} tokens</div>
                {tipDay.segments.length === 0 ? (
                  <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>—</div>
                ) : (
                  (tipDay.segments as Array<{ provider: string; model: string; total: number }>).map((seg) => (
                    <div key={seg.provider + '\u0000' + seg.model} className={css.tipRow}>
                      <span className={css.tipDot} style={{ background: colorMap!.get(seg.provider + '\u0000' + seg.model) }} />
                      <span className={css.tipModel}>{seg.model} · {seg.provider}</span>
                      <span className={css.tipVal}>{fmtFull(seg.total)}</span>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
