/**
 * 模型堆叠柱状图（ModelStackedBar）：每日一柱，按模型堆叠，横向滚动。
 * 复用 stats 的 buildModelStack 与 MODEL_PALETTE，悬停显示当日分模型明细。
 * 独立成文件（一个组件一个文件），样式见 ModelStackedBar.module.css。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ModelStackedBar.module.css'
import type { ModelStat } from '../useSnapshot.ts'
import { fmtFull, buildModelStack, modelColorAt, type ModelRange } from '../stats.ts'

/** 堆叠柱：每日一柱，模型分段堆叠，悬停 tooltip 显示当日明细。 */
export function ModelStackedBar({
  models, range, t,
}: {
  models: ModelStat[]
  range: ModelRange
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  const stack = useMemo(() => buildModelStack(models, range), [models, range])
  const [tip, setTip] = useState<{ dayIndex: number; x: number; y: number } | null>(null)
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  // 维持与饼图一致的配色顺序：stack.models 已为过滤后 total 降序
  const colorMap = useMemo(() => {
    const m = new Map<string, string>()
    stack.models.forEach((mod, idx) => {
      m.set(mod.provider + '\u0000' + mod.model, modelColorAt(idx))
    })
    return m
  }, [stack.models])

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
    // tip.x/y 为容器内坐标（scroll 容器相对）
    // 需要约束在容器可见区内
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
    // 容器内坐标（包含滚动偏移）
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
          {stack.models.slice(0, 6).map((m) => (
            <span key={m.provider + '\u0000' + m.model} className={css.legendItem}>
              <span className={css.legendDot} style={{ background: colorMap.get(m.provider + '\u0000' + m.model) }} />
              <span>{m.model}</span>
            </span>
          ))}
          {stack.models.length > 6 && <span className={css.legendItem}>+{stack.models.length - 6}</span>}
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
                  const h = max > 0 ? (seg.total / max) * H : 0
                  const color = colorMap.get(seg.provider + '\u0000' + seg.model) ?? '#8a8a8a'
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
            <div className={css.tipDate}>{new Date(tipDay.t).toLocaleDateString()} · {fmtFull(tipDay.total)} tokens</div>
            {tipDay.segments.length === 0 ? (
              <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>—</div>
            ) : (
              tipDay.segments.map((seg) => (
                <div key={seg.provider + '\u0000' + seg.model} className={css.tipRow}>
                  <span className={css.tipDot} style={{ background: colorMap.get(seg.provider + '\u0000' + seg.model) }} />
                  <span className={css.tipModel}>{seg.model} · {seg.provider}</span>
                  <span className={css.tipVal}>{fmtFull(seg.total)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
