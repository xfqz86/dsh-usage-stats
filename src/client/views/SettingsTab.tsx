/**
 * 设置 Tab：偏好设置（OpenCode Go 额度监控相关三项）+ 账本操作（折叠，内含清零/重建）+ 底部页脚（事件数 / 更新时间）。
 * 独立成文件（一个组件一个文件）。
 *
 * 偏好设置（settings.ts / useGoSettings 持久化到 localStorage）：
 *   1. 启用 OpenCode Go 额度监控（goEnabled）：关闭后不再轮询官方额度接口；
 *   2. 在侧边栏展示 OpenCode Go 剩余额度（showGoInSidebar）：只影响底部芯片，不影响模态窗；
 *   3. OpenCode Go 额度抓取间隔（goFetchMinutes，分钟）：下限 3（GO_FETCH_MIN_MINUTES）、
 *      默认 5；关闭监控时 2、3 项置灰不可改。
 * 账本操作折叠：标题为 t('settings.ledgerOps')，内含清零与重建两项危险操作。
 * 底部页脚：展示事件数与更新时间（原概览页脚迁移至此）。
 */

import { useRef, useState } from 'react'
import { IconChevronDownOutline14, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SettingsTab.module.css'
import shared from '../components/UsageStatsCommon.module.css'
import type { UsageSettings } from '../settings.ts'
import { clampGoFetchMinutes, GO_FETCH_MIN_MINUTES } from '../settings.ts'
import { SettingsSwitch } from '../components/SettingsSwitch.tsx'
import { API_HEADERS } from '../api.ts'
import type { UsageSnapshot } from '../useSnapshot.ts'
import { fmtFull } from '../stats.ts'

/** 设置 Tab：偏好设置 + 账本操作（折叠）+ 底部页脚。 */
export function SettingsTab({
  onRefresh, settings, onUpdateSettings, t, value,
}: {
  /** 重建/清零完成后立即重新拉取快照。 */
  onRefresh: () => void
  settings: UsageSettings
  onUpdateSettings: (patch: Partial<UsageSettings>) => void
  t: PropsLocale<'dsh-usage-stats'>['t']
  /** 快照（用于底部页脚的事件数与更新时间）。 */
  value: UsageSnapshot | null
}) {
  const [rebuildState, setRebuildState] = useState<'idle' | 'busy' | 'done'>('idle')
  // 重建账本二次确认：确认弹窗可见性 + 「我已了解」复选（防误触）。
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [clearState, setClearState] = useState<'idle' | 'busy' | 'done'>('idle')
  // 清零账本二次确认
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [clearAcknowledged, setClearAcknowledged] = useState(false)
  // 账本操作折叠
  const [ledgerOpen, setLedgerOpen] = useState(false)
  // 抓取间隔输入：本地文本态，失焦时才夹取并提交（避免每键回跳）。
  const [intervalText, setIntervalText] = useState(String(settings.goFetchMinutes))
  const intervalInputRef = useRef<HTMLInputElement>(null)

  /** 重建账本：清空事件流与元数据 → 服务端重扫日志；完成后立即拉快照。 */
  const handleRebuild = async () => {
    if (rebuildState === 'busy') return
    setRebuildState('busy')
    try {
      const response = await fetch('/usage-stats/api/rebuild', {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({}),
      })
      const json = await response.json().catch(() => null) as { ok?: boolean } | null
      if (!response.ok || json?.ok !== true) throw new Error('rebuild failed')
      setRebuildState('done')
      onRefresh()
      window.setTimeout(() => setRebuildState('idle'), 1500)
    } catch {
      setRebuildState('idle')
    }
  }

  /** 点击「重建账本」：打开二次确认弹窗（每次重置复选）。 */
  const armRebuild = () => {
    if (rebuildState === 'busy') return
    setAcknowledged(false)
    setConfirmOpen(true)
  }

  /** 确认弹窗内点「确认重建」：关闭弹窗并执行重建。 */
  const confirmRebuild = () => {
    setConfirmOpen(false)
    setAcknowledged(false)
    void handleRebuild()
  }

  /** 清零账本：清空事件流与元数据，不重扫；完成后立即拉快照。 */
  const handleClear = async () => {
    if (clearState === 'busy') return
    setClearState('busy')
    try {
      const response = await fetch('/usage-stats/api/clear', {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({}),
      })
      const json = await response.json().catch(() => null) as { ok?: boolean } | null
      if (!response.ok || json?.ok !== true) throw new Error('clear failed')
      setClearState('done')
      onRefresh()
      window.setTimeout(() => setClearState('idle'), 1500)
    } catch {
      setClearState('idle')
    }
  }

  const armClear = () => {
    if (clearState === 'busy') return
    setClearAcknowledged(false)
    setClearConfirmOpen(true)
  }

  const confirmClear = () => {
    setClearConfirmOpen(false)
    setClearAcknowledged(false)
    void handleClear()
  }

  /** 提交抓取间隔：夹到下限后更新设置，并把输入框同步为提交值。 */
  const commitInterval = () => {
    const minutes = clampGoFetchMinutes(Number(intervalText))
    setIntervalText(String(minutes))
    onUpdateSettings({ goFetchMinutes: minutes })
  }

  return (
    <div className={shared.section}>
      {/* 偏好设置（OpenCode Go 额度监控相关三项） */}
      <div className={shared.sectionHead}>
        <span className={shared.sectionLabel}>{t('settings.preferences')}</span>
      </div>

      {/* 1. 启用监控 */}
      <label className={css.settingRow}>
        <span className={css.settingText}>
          <span className={css.settingTitle}>{t('settings.goEnabled')}</span>
          <span className={css.settingDesc}>{t('settings.goEnabledHint')}</span>
        </span>
        <SettingsSwitch
          checked={settings.goEnabled}
          onToggle={() => onUpdateSettings({ goEnabled: !settings.goEnabled })}
        />
      </label>

      {/* 2. 侧边栏展示（关闭监控时置灰） */}
      <label className={`${css.settingRow} ${settings.goEnabled ? '' : css.settingRowDisabled}`}>
        <span className={css.settingText}>
          <span className={css.settingTitle}>{t('settings.showGoInSidebar')}</span>
          <span className={css.settingDesc}>{t('settings.showGoInSidebarHint')}</span>
        </span>
        <SettingsSwitch
          checked={settings.showGoInSidebar}
          disabled={!settings.goEnabled}
          onToggle={() => onUpdateSettings({ showGoInSidebar: !settings.showGoInSidebar })}
        />
      </label>

      {/* 3. OpenCode Go 额度抓取间隔（分钟，下限 3；关闭监控时置灰） */}
      <label className={`${css.settingRow} ${settings.goEnabled ? '' : css.settingRowDisabled}`}>
        <span className={css.settingText}>
          <span className={css.settingTitle}>{t('settings.goInterval')}</span>
          <span className={css.settingDesc}>
            {t('settings.goIntervalHint', { min: GO_FETCH_MIN_MINUTES })}
          </span>
        </span>
        <span className={css.intervalInput}>
          <input
            ref={intervalInputRef}
            type="number"
            min={GO_FETCH_MIN_MINUTES}
            step={1}
            value={intervalText}
            disabled={!settings.goEnabled}
            onChange={(e) => setIntervalText(e.target.value)}
            onBlur={commitInterval}
            onKeyDown={(e) => {
              if (e.key === 'Enter') intervalInputRef.current?.blur()
            }}
          />
          <span className={css.intervalUnit}>{t('settings.unitMinutes')}</span>
        </span>
      </label>

      {/* 账本操作（折叠） */}
      <div className={css.ledgerSection}>
        <button
          type="button"
          className={css.ledgerHeader}
          aria-expanded={ledgerOpen}
          onClick={() => setLedgerOpen((v) => !v)}
        >
          <span className={shared.sectionLabel}>{t('settings.ledgerOps')}</span>
          <IconChevronDownOutline14 className={ledgerOpen ? `${css.ledgerChevron} ${css.ledgerChevronOpen}` : css.ledgerChevron} size={14} />
        </button>
        {ledgerOpen && (
          <div className={css.ledgerContent}>
            {/* 清零账本 */}
            <div className={shared.sectionHead}>
              <span className={shared.sectionLabel}>{t('settings.clear')}</span>
            </div>
            <button
              type="button"
              className={clearState === 'done' ? `${css.refreshBtn} ${css.refreshBtnDone}` : clearState === 'busy' ? `${css.refreshBtn} ${css.refreshBtnBusy}` : css.refreshBtn}
              onClick={armClear}
              disabled={clearState === 'busy'}
            >
              {clearState === 'busy' ? t('settings.clearing') : clearState === 'done' ? t('settings.cleared') : t('settings.clearAction')}
            </button>
            <span className={shared.goHint}>{t('settings.clearHint')}</span>

            {/* 重建账本 */}
            <div className={shared.sectionHead}>
              <span className={shared.sectionLabel}>{t('settings.rebuild')}</span>
            </div>
            <button
              type="button"
              className={rebuildState === 'done' ? `${css.refreshBtn} ${css.refreshBtnDone}` : rebuildState === 'busy' ? `${css.refreshBtn} ${css.refreshBtnBusy}` : css.refreshBtn}
              onClick={armRebuild}
              disabled={rebuildState === 'busy'}
            >
              {rebuildState === 'busy' ? t('settings.rebuilding') : rebuildState === 'done' ? t('settings.rebuilt') : t('settings.rebuildAction')}
            </button>
            <span className={shared.goHint}>{t('settings.rebuildHint')}</span>
          </div>
        )}
      </div>

      <RiskConfirmation
        open={clearConfirmOpen}
        title={t('settings.clearConfirmTitle')}
        description={t('settings.clearConfirmDesc')}
        acknowledgeLabel={t('settings.clearConfirmAck')}
        cancelLabel={t('settings.clearCancel')}
        closeLabel={t('panel.close')}
        confirmLabel={t('settings.clearConfirm')}
        acknowledged={clearAcknowledged}
        onAcknowledgedChange={setClearAcknowledged}
        onCancel={() => setClearConfirmOpen(false)}
        onConfirm={confirmClear}
      />

      {/* 二次确认弹窗：复选「我已了解」后才可确认（复用 harness RiskConfirmation） */}
      <RiskConfirmation
        open={confirmOpen}
        title={t('settings.rebuildConfirmTitle')}
        description={t('settings.rebuildConfirmDesc')}
        acknowledgeLabel={t('settings.rebuildConfirmAck')}
        cancelLabel={t('settings.rebuildCancel')}
        closeLabel={t('panel.close')}
        confirmLabel={t('settings.rebuildConfirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={confirmRebuild}
      />

      {/* 底部页脚：事件数与更新时间（原概览页脚迁移至此） */}
      <div className={css.footer}>
        <span>{t('events')} {fmtFull(value?.foldedEvents ?? 0)}</span>
        <span>{t('updatedAt')} {value?.time ? new Date(value.time).toTimeString().slice(0, 8) : '--'}</span>
      </div>
    </div>
  )
}
