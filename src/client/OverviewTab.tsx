/**
 * 概览 Tab：汇总网格 + OpenCode Go 额度（三档窗口进度条）+ 26 周热力图
 * + 扫描页脚。独立成文件（一个组件一个文件）。
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './UsageStatsPanel.module.css'
import type { UsageSnapshot } from './useSnapshot.ts'
import type { GoQuota } from './useGoQuota.ts'
import { fmtFull, dayTotal, todayOf, usageTotal } from './stats.ts'
import { goLevelOf, goPercent, goResetsAt } from '../utils.ts'
import { StatCell } from './StatCell.tsx'
import { UsageHeatmap } from './UsageHeatmap.tsx'

/** OpenCode Go 额度行定义：键 + 完整文案键。 */
const GO_ROWS = [
  ['rolling', 'go.rolling'],
  ['weekly', 'go.weekly'],
  ['monthly', 'go.monthly'],
] as const

/** 概览 Tab：汇总网格 + Go 额度 + 26 周热力图 + 扫描页脚。 */
export function OverviewTab({
  value, go, t,
}: {
  value: UsageSnapshot
  go: GoQuota | null
  t: PropsLocale<'dsh-usage-statistics'>['t']
}) {
  const all = value?.all ?? { calls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 } }
  const today = todayOf(value.series.all ?? [])

  return (
    <>
      {/* 汇总 */}
      <div className={css.summary}>
        <StatCell value={fmtFull(today ? dayTotal(today) : 0)} label={t('panel.summary.todayTokens')} />
        <StatCell value={fmtFull(today?.calls ?? 0)} label={t('panel.summary.todayCalls')} />
        <StatCell value={fmtFull(usageTotal(all.usage))} label={t('panel.summary.totalTokens')} />
        <StatCell value={fmtFull(value.sessions)} label={t('panel.summary.sessions')} />
      </div>

      {/* 26 周热力图（Codex 风格） */}
      <UsageHeatmap series={value.series.all} t={t} />

      {/* OpenCode Go 订阅额度 */}
      {go !== null && go.status === 'ok' && (
        <div className={css.section}>
          <div className={css.sectionHead}>
            <span className={css.sectionLabel}>{t('go.title')}</span>
          </div>
          {GO_ROWS.map(([key, labelKey]) => {
            const win = go[key]
            if (win === null) return null
            const pct = goPercent(win)
            const level = goLevelOf(pct)
            return (
              <div className={css.goRow} key={key}>
                <span className={css.goLabel}>{t(labelKey)}</span>
                <span className={css.goBar}>
                  <span
                    className={level === 'over' ? `${css.goBarFill} ${css.goFillOver}` : level === 'warn' ? `${css.goBarFill} ${css.goFillWarn}` : css.goBarFill}
                    style={{ width: pct + '%' }}
                  />
                </span>
                <span className={level === 'over' ? `${css.goPct} ${css.goPctOver}` : level === 'warn' ? `${css.goPct} ${css.goPctWarn}` : css.goPct}>{pct}%</span>
                <span className={css.goReset}>
                  {goResetsAt(t, win)}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {go !== null && go.status === 'no-key' && (
        <div className={css.section}>
          <div className={css.sectionHead}>
            <span className={css.sectionLabel}>{t('go.title')}</span>
          </div>
          <span className={css.goHint}>{t('go.notConfigured')}</span>
        </div>
      )}
      {go !== null && go.status === 'error' && (
        <div className={css.section}>
          <div className={css.sectionHead}>
            <span className={css.sectionLabel}>{t('go.title')}</span>
          </div>
          <span className={css.goHint}>{t('go.unavailable')}</span>
        </div>
      )}

      {/* 页脚：扫描信息 */}
      <div className={css.footer}>
        <span>{t('scanInfo')} {fmtFull(value.rawSessions)}/{fmtFull(value.harnessSessions)} · {t('events')} {fmtFull(value.foldedEvents)}</span>
        <span>{t('updatedAt')} {value.time ? new Date(value.time).toTimeString().slice(0, 8) : '--'}</span>
      </div>
    </>
  )
}
