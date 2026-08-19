/**
 * 概览 Tab 的 26 周热力图：Codex 风格网格（列 = 周，行 = 周一..周日，
 * 4 档强度 + 月份标签 + 今日高亮）。
 * 独立成文件（一个组件一个文件），供 OverviewTab 复用。
 */

import { useMemo } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './UsageStatsPanel.module.css'
import type { UsageSnapshot } from './useSnapshot.ts'
import { fmtFull, heatGridOf, type HeatGridCell } from './stats.ts'
import { cacheTotal } from '../utils.ts'

/** 月份文案键：每列（周）首月变化时显示。 */
const MONTH_KEYS = [
  'month.1', 'month.2', 'month.3', 'month.4', 'month.5', 'month.6',
  'month.7', 'month.8', 'month.9', 'month.10', 'month.11', 'month.12',
] as const

/** 热力图强度 1..4 对应的 scoped 类名（0 = 无用量底色）。 */
const HEAT_LEVELS = [null, css.hl1, css.hl2, css.hl3, css.hl4] as const

/** 26 周热力图（概览 Tab：每格 tooltip 显示当日明细）。 */
export function UsageHeatmap({
  series, t,
}: {
  series: UsageSnapshot['series']['all']
  t: PropsLocale<'dsh-usage-statistics'>['t']
}) {
  const grid = useMemo(() => heatGridOf(series, 26), [series])
  // 按天索引序列，供 tooltip 取每日明细（缓存 = cacheRead + cacheWrite）。
  const byDay = useMemo(() => new Map(series.map(s => [s.t, s])), [series])
  const totalTokens = useMemo(() => grid.cells.reduce((s, c) => s + c.v, 0), [grid])
  const totalCalls = useMemo(() => grid.cells.reduce((s, c) => s + c.calls, 0), [grid])
  const hasUsage = totalTokens > 0

  const cellClass = (c: HeatGridCell): string => {
    const lvl = HEAT_LEVELS[c.lvl] ?? ''
    const cls = `${css.hcell}${lvl ? ' ' + lvl : ''}`
    return c.today ? `${cls} ${css.hcellToday}` : cls
  }

  /** 单格 tooltip 文案：日期 + 明细（与曲线 tooltip 同口径）。 */
  const cellTip = (c: HeatGridCell): string => {
    const day = byDay.get(c.t)
    return t('heat.tip', {
      date: c.label,
      tokens: fmtFull(c.v),
      input: fmtFull(day?.input ?? 0),
      cache: fmtFull(cacheTotal(day ?? {})),
      output: fmtFull(day?.output ?? 0),
      calls: fmtFull(c.calls),
    })
  }

  return (
    <div className={css.section}>
      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('heat.title')}</span>
      </div>
      <span className={css.heatTotal}>
        {t('heat.total', { tokens: fmtFull(totalTokens), calls: fmtFull(totalCalls) })}
      </span>
      {hasUsage ? (
        <>
          <div className={css.heatGrid} style={{ gridTemplateColumns: `repeat(${grid.cols},1fr)` }}>
            {grid.cells.map((c, i) => (
              <Tooltip key={i} label={cellTip(c)} side="top" delayMs={150}>
                <div className={cellClass(c)} />
              </Tooltip>
            ))}
          </div>
          <div className={css.heatMonths} style={{ gridTemplateColumns: `repeat(${grid.cols},1fr)` }}>
            {grid.months.map((m, i) => (
              <span key={i} className={css.heatMonth}>{m === null ? '' : t(MONTH_KEYS[m])}</span>
            ))}
          </div>
        </>
      ) : (
        <div className={css.empty}>{t('state.noUsage')}</div>
      )}
    </div>
  )
}
