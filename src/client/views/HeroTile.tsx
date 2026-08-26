/**
 * 英雄磁贴（HeroTile）：今日 / 总 tokens 共用的合并磁贴。
 * 展示大数 + 命中率 + 调用次数 + 底部三色比例条（缓存 / 输入 / 输出），
 * tooltip 明细与侧边栏同款口径。独立成文件（一个组件一个文件），
 * 由 OverviewTab 复用两次，避免 TodayTile / TotalTile 重复。
 */

import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HeroTile.module.css'
import shared from '../components/UsageStatsCommon.module.css'
import { fmtFull, pctOf } from '../stats.ts'
import { cacheTotal } from '../../utils.ts'
import { Tooltip } from '../components/Tooltip.tsx'
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

  // 三色比例条 tooltip：顺序与热力图一致（缓存、输入、输出、总计、缓存命中率、调用次数、平均每次调用），标签左、数值右。
  const avgPerCall = calls > 0 ? Math.round(tokens / calls) : 0
  const barContent = tokens > 0
    ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: 12, lineHeight: '18px', minWidth: 180 }}>
        {([
          [t('table.cacheRead'), fmtFull(cache)],
          [t('table.input'), fmtFull(input)],
          [t('table.output'), fmtFull(output)],
          [t('table.total'), fmtFull(tokens)],
          [t('footer.cacheHitRate'), pctOf(cacheHitRate)],
          [t('table.calls'), fmtFull(calls)],
          [t('table.avgPerCall'), fmtFull(avgPerCall)],
        ] as const).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
            <span style={{ opacity: 0.85, textAlign: 'left' }}>{k}</span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
    )
    : null

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
        <Tooltip follow content={barContent} side="bottom" delayMs={300}>
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
        </Tooltip>
      )}
    </div>
  )
}
