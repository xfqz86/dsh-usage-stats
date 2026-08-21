/**
 * 概览 Tab 的「今日」汇总磁贴：今日 tokens + 今日调用 + 三色比例条
 * （缓存 / 输入 / 输出，tooltip 明细与侧边栏同款口径）合并到一个磁贴。
 * 独立成文件（一个组件一个文件）。
 */

import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SeriesPoint } from '../../types.ts'
import css from './TodayTile.module.css'
import shared from './UsageStatsCommon.module.css'
import { alignedRows, dayTotal, fmtFull, pctOf } from '../stats.ts'
import { cacheTotal } from '../../utils.ts'
import { FollowTooltip } from './FollowTooltip.tsx'

/** 今日磁贴：tokens / 调用 / 比例条（tooltip 给各类明细与缓存命中率）。 */
export function TodayTile({
  today, t,
}: {
  today: SeriesPoint | undefined
  t: PropsLocale<'dsh-usage-statistics'>['t']
}) {
  const tokens = today ? dayTotal(today) : 0
  const calls = today?.calls ?? 0
  // 各分类 token（缓存 = cacheRead + cacheWrite，与侧边栏共用 cacheTotal）。
  const cache = cacheTotal(today ?? {})
  const input = today?.input || 0
  const output = today?.output || 0
  const cacheRead = today?.cacheRead || 0
  // 缓存命中率 = cacheRead / (cacheRead + input)。
  const cacheHitRate = (cacheRead + input) > 0
    ? Math.round((cacheRead / (cacheRead + input)) * 1000) / 10
    : null

  // 三色比例条 tooltip：与侧边栏同一套对齐明细。
  const barLabel = tokens > 0
    ? alignedRows([
      [t('footer.cacheTip', { n: '' }).trim(), fmtFull(cache)],
      [t('footer.inputTip', { n: '' }).trim(), fmtFull(input)],
      [t('footer.outputTip', { n: '' }).trim(), fmtFull(output)],
      [t('footer.cacheHitRate'), pctOf(cacheHitRate)],
    ])
    : ''

  // 调用量文本：中文带后缀"次"，英文回退到 "351 Calls"
  const callsSuffix = t('panel.summary.callsSuffix')
  const callsText = callsSuffix ? fmtFull(calls) + callsSuffix : fmtFull(calls) + ' ' + t('table.calls')

  return (
    <div className={`${shared.cell} ${css.cellToday}`}>
      <div className={css.todayHead}>
        <span className={shared.cellIcon}><IconSparkle16 /></span>
        <span className={css.todayLabel}>{t('footer.todayLabel')}</span>
      </div>
      <div className={css.todayMain}>
        <span className={css.todayValue}>{fmtFull(tokens)}</span>
        <span className={css.todayHitRate}>{t('footer.cacheHitRate')} {pctOf(cacheHitRate)}</span>
        <span className={css.todayCallsRight}>{callsText}</span>
      </div>
      {tokens > 0 && (
        <FollowTooltip label={barLabel} side="bottom" delayMs={300}>
          <span className={css.todayBar}>
            {cache > 0 && (
              <span className={`${css.todayBarSeg} ${css.todayBarCache}`} style={{ flex: cache }} />
            )}
            {input > 0 && (
              <span className={`${css.todayBarSeg} ${css.todayBarInput}`} style={{ flex: input }} />
            )}
            {output > 0 && (
              <span className={`${css.todayBarSeg} ${css.todayBarOutput}`} style={{ flex: output }} />
            )}
          </span>
        </FollowTooltip>
      )}
    </div>
  )
}
