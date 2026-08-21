/**
 * 英雄磁贴（HeroTile）：今日 / 总 tokens 共用的合并磁贴。
 * 展示大数 + 命中率 + 调用次数 + 底部三色比例条（缓存 / 输入 / 输出），
 * tooltip 明细与侧边栏同款口径。独立成文件（一个组件一个文件），
 * 由 OverviewTab 复用两次，避免 TodayTile / TotalTile 重复。
 */

import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HeroTile.module.css'
import shared from './UsageStatsCommon.module.css'
import { alignedRows, fmtFull, pctOf } from '../stats.ts'
import { cacheTotal } from '../../utils.ts'
import { FollowTooltip } from './FollowTooltip.tsx'
import type { UsageAgg } from '../../types.ts'

/** 英雄磁贴：标题图标 + 大数 / 命中率 / 调用 / 比例条。 */
export function HeroTile({
  icon, label, usage, calls, t, side,
}: {
  icon: ReactNode
  label: ReactNode
  usage: UsageAgg
  calls: number
  t: PropsLocale<'dsh-usage-stats'>['t']
  /** 标题行右侧的补充信息（如总计卡片的会话数）。 */
  side?: ReactNode
}) {
  const tokens = usage.total || 0
  const cache = cacheTotal(usage)
  const input = usage.input || 0
  const output = usage.output || 0
  const cacheRead = usage.cacheRead || 0
  // 缓存命中率 = cacheRead / (cacheRead + input)，与侧边栏同口径。
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
    <div className={`${shared.cell} ${css.cellHero}`}>
      <div className={css.heroHead}>
        <span className={shared.cellIcon}>{icon}</span>
        <span className={css.heroLabel}>{label}</span>
        {side != null && side !== '' && <span className={css.heroSide}>{side}</span>}
      </div>
      <div className={css.heroMain}>
        <span className={css.heroValue}>{fmtFull(tokens)}</span>
        <span className={css.heroHitRate}>{t('footer.cacheHitRate')} {pctOf(cacheHitRate)}</span>
        <span className={css.heroCallsRight}>{callsText}</span>
      </div>
      {tokens > 0 && (
        <FollowTooltip label={barLabel} side="bottom" delayMs={300}>
          <span className={css.heroBar}>
            {cache > 0 && (
              <span className={`${css.heroBarSeg} ${css.heroBarCache}`} style={{ flex: cache }} />
            )}
            {input > 0 && (
              <span className={`${css.heroBarSeg} ${css.heroBarInput}`} style={{ flex: input }} />
            )}
            {output > 0 && (
              <span className={`${css.heroBarSeg} ${css.heroBarOutput}`} style={{ flex: output }} />
            )}
          </span>
        </FollowTooltip>
      )}
    </div>
  )
}
