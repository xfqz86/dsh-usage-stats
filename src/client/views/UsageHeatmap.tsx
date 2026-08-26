/**
 * 概览 Tab 的 26 周热力图：Codex 风格网格（列 = 周，行 = 周一..周日，
 * 4 档强度 + 月份标签 + 今日高亮）。
 * 独立成文件（一个组件一个文件），供 OverviewTab 复用。
 */

import { useMemo } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '../components/Tooltip.tsx'
import css from './UsageHeatmap.module.css'
import shared from '../components/UsageStatsCommon.module.css'
import type { UsageSnapshot } from '../useSnapshot.ts'
import { fmtFull, heatGridOf, pctOf, type HeatGridCell } from '../stats.ts'
import { cacheTotal } from '../../utils.ts'

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
  t: PropsLocale<'dsh-usage-stats'>['t']
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

  /** 单格 tooltip：富插槽排版（日期左对齐 + 标签左对齐/数值右对齐），顺序：日期、缓存、输入、输出、总计、缓存命中率、调用次数、平均每次调用。 */
  const cellContent = (c: HeatGridCell) => {
    const day = byDay.get(c.t)
    const cache = cacheTotal(day ?? {})
    const input = day?.input ?? 0
    const output = day?.output ?? 0
    const total = c.v
    const calls = c.calls
    const cacheRead = day?.cacheRead ?? 0
    const hitRate = (cacheRead + input) > 0 ? Math.round((cacheRead / (cacheRead + input)) * 1000) / 10 : null
    const avg = calls > 0 ? Math.round(total / calls) : 0
    const rows: Array<[string, string]> = [
      [t('table.cacheRead'), fmtFull(cache)],
      [t('table.input'), fmtFull(input)],
      [t('table.output'), fmtFull(output)],
      [t('table.total'), fmtFull(total)],
      [t('footer.cacheHitRate'), pctOf(hitRate)],
      [t('table.calls'), fmtFull(calls)],
      [t('table.avgPerCall'), fmtFull(avg)],
    ]
    return (
      <div style={{ minWidth: 200 }}>
        <div style={{ fontWeight: 600, marginBottom: 6, whiteSpace: 'nowrap', textAlign: 'left' }}>{c.label}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: 12, lineHeight: '18px' }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
              <span style={{ opacity: 0.85, textAlign: 'left' }}>{k}</span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={shared.section}>
      <div className={shared.sectionHead}>
        <span className={css.heatTitle}>
          {t('heat.total', { tokens: fmtFull(totalTokens), calls: fmtFull(totalCalls) })}
        </span>
        <span className={css.heatLegend} aria-hidden="true">
          <span className={css.heatLegendLabel}>{t('heat.legendLess')}</span>
          <span className={css.heatLegendSwatches}>
            <i className={css.hcellLegend} />
            <i className={`${css.hcellLegend} ${css.hl1}`} />
            <i className={`${css.hcellLegend} ${css.hl2}`} />
            <i className={`${css.hcellLegend} ${css.hl3}`} />
            <i className={`${css.hcellLegend} ${css.hl4}`} />
          </span>
          <span className={css.heatLegendLabel}>{t('heat.legendMore')}</span>
        </span>
      </div>
      {hasUsage ? (
        <>
          <div className={css.heatGrid} style={{ gridTemplateColumns: `repeat(${grid.cols},1fr)` }}>
            {grid.cells.map((c, i) => (
              <Tooltip key={i} content={cellContent(c)} side="top" delayMs={150}>
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
        <div className={shared.empty}>{t('state.noUsage')}</div>
      )}
    </div>
  )
}
