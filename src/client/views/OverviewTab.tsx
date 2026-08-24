/**
 * 概览 Tab（Bento 磁贴网格）：「今日」+「总计」英雄磁贴
 * （共用 HeroTile，各 2 列，等宽，均含三色比例条、命中率与调用；
 * 总计标题右侧附会话数）+ OpenCode Go 额度磁贴（窄列，纵向堆叠三档
 * 窗口进度，标题右侧带立即刷新按钮）+ 26 周热力磁贴（宽列）+ 扫描页脚。
 * 独立成文件（一个组件一个文件）。
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconArchiveOutline20,
  IconRefreshOutline16,
  IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './OverviewTab.module.css'
import shared from '../components/UsageStatsCommon.module.css'
import type { UsageSnapshot } from '../useSnapshot.ts'
import type { GoQuota } from '../useGoQuota.ts'
import { dayTotal, fmtFull, todayOf } from '../stats.ts'
import { goLevelOf, goPercent, goResetsAt } from '../../utils.ts'
import { HeroTile } from './HeroTile.tsx'
import { UsageHeatmap } from './UsageHeatmap.tsx'

/** OpenCode Go 额度行定义：键 + 完整文案键。 */
const GO_ROWS = [
  ['rolling', 'go.rolling'],
  ['weekly', 'go.weekly'],
  ['monthly', 'go.monthly'],
] as const

/** 概览 Tab：Bento 磁贴网格 = 今日/总计（同款英雄磁贴，总计标题右侧附会话数）+ Go 额度磁贴 + 26 周热力磁贴 + 页脚。 */
export function OverviewTab({
  value, go, t, onRefreshGo,
}: {
  value: UsageSnapshot
  go: GoQuota | null
  t: PropsLocale<'dsh-usage-stats'>['t']
  /** 立即刷新 Go 额度（不受抓取间隔控制）。 */
  onRefreshGo: () => void
}) {
  const all = value?.all ?? { calls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 } }
  const todayPoint = todayOf(value.series.all ?? [])
  // 今日转 UsageAgg 供 HeroTile 复用（与总计同款口径）
  const todayUsage = todayPoint
    ? { input: todayPoint.input, output: todayPoint.output, cacheRead: todayPoint.cacheRead, cacheWrite: todayPoint.cacheWrite, reasoning: todayPoint.reasoning, total: dayTotal(todayPoint) }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
  const todayCalls = todayPoint?.calls ?? 0
  // 总计标题右侧显示会话数，首行今日 2 列 + 总计 2 列占满 4 列；
  // 第二行：有 Go 时 Go 1 列 + 热力 3 列，无 Go 时热力整行
  const heatCls = go === null ? css.tileHeatFull : go.status === 'ok' ? css.tileHeat : css.tileHeatFull
  const totalSide = `${fmtFull(value.sessions)} ${t('panel.summary.sessions')}`

  return (
    <>
      {/* Bento 磁贴网格：「今日」(2 列) +「总计」(2 列，等宽同款，标题右侧含会话数) + Go 磁贴 + 热力磁贴 */}
      <div className={css.bento}>
        {/* 汇总磁贴（display:contents，子磁贴直接参与 bento 网格） */}
        <div className={css.summary}>
          <HeroTile icon={<IconSparkle16 />} label={t('footer.todayLabel')} usage={todayUsage} calls={todayCalls} t={t} />
          <HeroTile icon={<IconArchiveOutline20 size={16} />} label={t('panel.summary.totalTokens')} usage={all.usage} calls={all.calls} t={t} side={totalSide} />
        </div>

        {/* OpenCode Go 额度磁贴（占 1 列，纵向堆叠三档窗口） */}
        {go !== null && go.status === 'ok' && (
          <div className={`${css.tile} ${css.tileGo}`}>
            <div className={shared.sectionHead}>
              <span className={shared.sectionLabel}>{t('go.title')}</span>
              <button
                type="button"
                className={css.goRefresh}
                aria-label={t('go.refresh')}
                title={t('go.refresh')}
                onClick={onRefreshGo}
              >
                <IconRefreshOutline16 size={12} />
              </button>
            </div>
            <div className={css.goTileRows}>
              {GO_ROWS.map(([key, labelKey]) => {
                const win = go[key]
                if (win === null) return null
                const pct = goPercent(win)
                const level = goLevelOf(pct)
                return (
                  <div className={css.goTileRow} key={key}>
                    <span className={css.goTileTop}>
                      <span className={css.goLabel}>{t(labelKey)}</span>
                      <span className={level === 'over' ? `${css.goPct} ${css.goPctOver}` : level === 'warn' ? `${css.goPct} ${css.goPctWarn}` : css.goPct}>{pct}%</span>
                    </span>
                    <span className={css.goBar}>
                      <span
                        className={level === 'over' ? `${css.goBarFill} ${css.goFillOver}` : level === 'warn' ? `${css.goBarFill} ${css.goFillWarn}` : css.goBarFill}
                        style={{ width: pct + '%' }}
                      />
                    </span>
                    <span className={css.goReset}>{goResetsAt(t, win)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {/* 未配置 / 查询失败：整行提示磁贴（占满 4 列），热力磁贴随之整行下移 */}
        {go !== null && go.status === 'no-key' && (
          <div className={`${css.tile} ${css.tileGoWide}`}>
            <div className={shared.sectionHead}>
              <span className={shared.sectionLabel}>{t('go.title')}</span>
            </div>
            <span className={shared.goHint}>{t('go.notConfigured')}</span>
          </div>
        )}
        {go !== null && go.status === 'error' && (
          <div className={`${css.tile} ${css.tileGoWide}`}>
            <div className={shared.sectionHead}>
              <span className={shared.sectionLabel}>{t('go.title')}</span>
            </div>
            <span className={shared.goHint}>{t('go.unavailable')}</span>
          </div>
        )}

        {/* 26 周热力图（Codex 风格）磁贴 */}
        <div className={`${css.tile} ${heatCls}`}>
          <UsageHeatmap series={value.series.all} t={t} />
        </div>
      </div>

      {/* 页脚：扫描信息 */}
      <div className={css.footer}>
        <span>{t('scanInfo')} {fmtFull(value.rawSessions)}/{fmtFull(value.harnessSessions)} · {t('events')} {fmtFull(value.foldedEvents)}</span>
        <span>{t('updatedAt')} {value.time ? new Date(value.time).toTimeString().slice(0, 8) : '--'}</span>
      </div>
    </>
  )
}
