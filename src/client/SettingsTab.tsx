/**
 * 设置 Tab：手动刷新 + 重建账本 + 偏好占位（后续参数设置扩展点）。
 * 独立成文件（一个组件一个文件）。
 */

import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './UsageStatsPanel.module.css'

/** 设置 Tab：手动刷新 + 重建账本 + 偏好占位。 */
export function SettingsTab({
  onRefresh, t,
}: {
  onRefresh: () => void
  t: PropsLocale<'dsh-usage-statistics'>['t']
}) {
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [rebuildState, setRebuildState] = useState<'idle' | 'busy' | 'done'>('idle')

  const handleRefresh = () => {
    onRefresh()
    setJustRefreshed(true)
    window.setTimeout(() => setJustRefreshed(false), 1500)
  }

  /** 重建账本：清空事件流与元数据 → 服务端重扫日志；完成后立即拉快照。 */
  const handleRebuild = async () => {
    if (rebuildState === 'busy') return
    setRebuildState('busy')
    try {
      await fetch('/usage-stats/api/rebuild', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      setRebuildState('done')
      onRefresh()
      window.setTimeout(() => setRebuildState('idle'), 1500)
    } catch {
      setRebuildState('idle')
    }
  }

  return (
    <div className={css.section}>
      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('settings.refresh')}</span>
      </div>
      <button
        type="button"
        className={justRefreshed ? `${css.refreshBtn} ${css.refreshBtnDone}` : css.refreshBtn}
        onClick={handleRefresh}
      >
        {justRefreshed ? t('settings.refreshed') : t('settings.refreshAction')}
      </button>
      <span className={css.goHint}>{t('settings.refreshHint')}</span>

      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('settings.rebuild')}</span>
      </div>
      <button
        type="button"
        className={rebuildState === 'done' ? `${css.refreshBtn} ${css.refreshBtnDone}` : rebuildState === 'busy' ? `${css.refreshBtn} ${css.refreshBtnBusy}` : css.refreshBtn}
        onClick={handleRebuild}
        disabled={rebuildState === 'busy'}
      >
        {rebuildState === 'busy' ? t('settings.rebuilding') : rebuildState === 'done' ? t('settings.rebuilt') : t('settings.rebuildAction')}
      </button>
      <span className={css.goHint}>{t('settings.rebuildHint')}</span>

      {/* 偏好设置占位：后续参数设置统一放这里 */}
      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('settings.preferences')}</span>
      </div>
      <span className={css.goHint}>{t('settings.preferencesPlaceholder')}</span>
    </div>
  )
}
