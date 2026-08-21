/**
 * 用量统计的详情视图：侧边栏底部按钮打开的居中模态窗（Tab 化）。
 *
 * 本文件是**模态窗壳**（Modal + 头部 + Tab 栏 + 内容切换）；每个 Tab 的
 * 内容组件独立成文件，避免一个 tsx 里塞多个组件、难以维护：
 *   - OverviewTab（概览：汇总 + Go 额度 + 热力图 + 页脚）
 *   - DatesTab（日期：每日趋势曲线 + 范围切换）
 *   - SessionsTab（会话：按会话表）
 *   - ModelsTab（模型：拆分表）
 *   - SettingsTab（设置：刷新 / 重建账本）
 *
 * 数据与底部按钮共用 /usage-stats/api/snapshot 与 /usage-stats/api/go-quota
 * 的轮询结果；Tab 内视图状态（范围 / 曲线视图 / 会话展开）在切换时保留。
 */

import { useState, type ComponentType } from 'react'
import {
  IconAgentPresetOutline16,
  IconCloseOutline16,
  IconDataOutline16,
  IconQueueOutline14,
  IconRightUpOutline16,
  IconSettingsOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './UsageStatsPanel.module.css'
import shared from './UsageStatsCommon.module.css'
import type { UsageSnapshot } from '../useSnapshot.ts'
import type { GoQuota } from '../useGoQuota.ts'
import type { UsageSettings } from '../settings.ts'
import type { UsageStatsKey } from '../locales.ts'
import { OverviewTab } from './OverviewTab.tsx'
import { DatesTab } from './DatesTab.tsx'
import { SessionsTab } from './SessionsTab.tsx'
import { ModelsTab } from './ModelsTab.tsx'
import { SettingsTab } from './SettingsTab.tsx'

export interface UsageStatsPanelProps extends PropsLocale<'dsh-usage-stats'> {
  /** 模态窗是否显示。 */
  open: boolean
  /** 底部按钮轮询到的最新快照；不可用时为 null。 */
  data: UsageSnapshot | null
  /** 拉取失败（服务不可达 / 响应非 ok）。 */
  err: boolean
  /** OpenCode Go 订阅额度（底部按钮轮询）；null 表示尚未加载或抓取被禁用。 */
  go: GoQuota | null
  /** 偏好设置（Go 抓取开关 / 侧边栏展示 / 间隔），设置 Tab 读写。 */
  settings: UsageSettings
  /** 局部更新偏好设置。 */
  onUpdateSettings: (patch: Partial<UsageSettings>) => void
  /** 关闭模态窗（关闭按钮、遮罩点击或 Escape）。 */
  onClose: () => void
  /** 立即重新拉取快照与 Go 额度（设置页"手动刷新"按钮）。 */
  onRefresh: () => void
  /** 立即重新拉取 Go 额度（概览 Go 磁贴标题右侧刷新按钮，不受抓取间隔控制）。 */
  onRefreshGo: () => void
}

/** Tab 键：与面板内视图一一对应。 */
type TabKey = 'overview' | 'dates' | 'sessions' | 'models' | 'settings'

/** Tab 定义：键 + 文案键 + 图标组件。 */
const TABS: Array<{ key: TabKey; labelKey: UsageStatsKey; Icon: ComponentType<IconProps> }> = [
  { key: 'overview', labelKey: 'tab.overview', Icon: IconDataOutline16 },
  { key: 'dates', labelKey: 'tab.dates', Icon: IconRightUpOutline16 },
  { key: 'sessions', labelKey: 'tab.sessions', Icon: IconQueueOutline14 },
  { key: 'models', labelKey: 'tab.models', Icon: IconAgentPresetOutline16 },
  { key: 'settings', labelKey: 'tab.settings', Icon: IconSettingsOutline16 },
]

export function UsageStatsPanel({ open, data, err, go, settings, onUpdateSettings, onClose, onRefresh, onRefreshGo, t }: UsageStatsPanelProps) {
  const [active, setActive] = useState<TabKey>('overview')

  const value = data

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('panel.title')}
      closeLabel={t('panel.close')}
      headless
      className={css.modal}
    >
      <header className={css.header}>
        <span className={css.title}>{t('panel.title')}</span>
        <span className={css.headerMeta}>
          {!err && (
            <>
              {value?.scanning && (
                <span className={`${css.status} ${css.statusScan}`}>{t('state.scanning')}</span>
              )}
              {value != null && value.failed > 0 && (
                <span
                  className={`${css.status} ${css.statusErr}`}
                  title={String(value.lastError ?? value.scanError ?? '')}
                >{t('state.missingSessions', { n: value.failed })}</span>
              )}
            </>
          )}
          <button
            type="button"
            className={css.close}
            onClick={onClose}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </span>
      </header>

      {/* Tab 栏：语义化 tablist（无现成 harness 组件，样式与 chip/seg 统一） */}
      <div className={css.tabbar} role="tablist" aria-label={t('panel.title')}>
        {TABS.map(({ key, labelKey, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            className={active === key ? `${css.tab} ${css.tabOn}` : css.tab}
            onClick={() => setActive(key)}
          >
            <Icon size={14} />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>

      <div className={css.body} role="tabpanel">
        {err
          ? <div className={shared.empty}>{t('state.unavailable')}</div>
          : !value
            ? <div className={shared.empty}>{t('state.loading')}</div>
            : (
              <>
                {active === 'overview' && <OverviewTab value={value} go={go} t={t} onRefreshGo={onRefreshGo} />}
                {active === 'dates' && <DatesTab series={value.series.all} t={t} />}
                {active === 'sessions' && <SessionsTab sessionsList={value.sessionsList} t={t} />}
                {active === 'models' && <ModelsTab models={value.models} t={t} />}
                {active === 'settings' && (
                  <SettingsTab
                    onRefresh={onRefresh}
                    settings={settings}
                    onUpdateSettings={onUpdateSettings}
                    t={t}
                  />
                )}
              </>
            )}
      </div>
    </Modal>
  )
}
