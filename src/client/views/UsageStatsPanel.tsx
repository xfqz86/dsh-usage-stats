/**
 * 用量统计的详情视图：侧边栏底部按钮打开的居中模态窗，采用 Tab 化布局。
 *
 * 本文件是**模态窗壳**，含 Modal、头部、Tab 栏与内容切换；每个 Tab 的
 * 内容组件独立成文件，避免一个 tsx 里塞多个组件、难以维护：
 *   - OverviewTab，概览，含汇总、热力图与 Go 额度、DeepSeek 余额、Z.ai 额度，受监控开关控制，关闭时隐藏对应卡片
 *   - DatesTab，日期，含每日趋势曲线与范围切换
 *   - SessionsTab，会话，按会话展示表格
 *   - ModelsTab，模型，按模型拆分表格
 *   - SettingsTab，设置，含偏好设置，涉及 Go、DeepSeek 与 Z.ai、可折叠的账本操作与页脚
 *
 * 数据与底部按钮共用 /usage-stats/api/snapshot、/usage-stats/api/go-quota
 * 与 /usage-stats/api/deepseek-balance 的轮询结果。各 Tab 内容为条件渲染：切走即卸载，Tab 内视图状态
 * 含 DatesTab 的曲线范围、SessionsTab 的会话展开等，不跨切换保留，
 * 重新进入对应 Tab 即重置为默认值。
 */

import {
  IconAgentPresetOutline16,
  IconCloseOutline16,
  IconDataOutline16,
  IconQueueOutline14,
  IconRightUpOutline16,
  IconSettingsOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useState, type ComponentType } from 'react';

import shared from '../components/UsageStatsCommon.module.css';

import { DatesTab } from './DatesTab.tsx';
import { ModelsTab } from './ModelsTab.tsx';
import { OverviewTab } from './OverviewTab.tsx';
import { SessionsTab } from './SessionsTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import css from './UsageStatsPanel.module.css';

import type { DeepSeekBalance, ZaiQuota } from '../../types.ts';
import type { UsageStatsKey } from '../locales.ts';
import type { UsageSettings } from '../settings.ts';
import type { GoQuota } from '../useGoQuota.ts';
import type { UsageSnapshot } from '../useSnapshot.ts';
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

export interface UsageStatsPanelProps extends PropsLocale<'dsh-usage-stats'> {
  /** 模态窗是否显示。 */
  open: boolean
  /** 底部按钮轮询到的最新快照；不可用时为 null。 */
  data: UsageSnapshot | null
  /** 拉取失败，服务不可达或响应非 ok。 */
  err: boolean
  /** OpenCode Go 订阅额度，底部按钮轮询；null 表示尚未加载或抓取被禁用。 */
  go: GoQuota | null
  /** DeepSeek 余额，底部按钮轮询；null 表示尚未加载或抓取被禁用。 */
  deepseek: DeepSeekBalance | null
  /** Z.ai 额度，底部按钮轮询；null 表示尚未加载或抓取被禁用。 */
  zai: ZaiQuota | null
  /** 偏好设置，含 Go、DeepSeek、Z.ai 抓取开关、侧边栏展示与间隔，设置 Tab 读写。 */
  settings: UsageSettings
  /** 局部更新偏好设置。 */
  onUpdateSettings: (patch: Partial<UsageSettings>) => void
  /** 关闭模态窗，通过关闭按钮、遮罩点击或 Escape 触发。 */
  onClose: () => void
  /** 立即重新拉取快照、Go 额度、DeepSeek 余额与 Z.ai 额度，对应设置页“手动刷新”按钮。 */
  onRefresh: () => void
  /** 立即重新拉取 Go 额度，对应概览 Go 磁贴标题右侧刷新按钮，不受抓取间隔控制。 */
  onRefreshGo: () => void
  /** 立即重新拉取 DeepSeek 余额，对应概览 DeepSeek 磁贴标题右侧刷新按钮。 */
  onRefreshDeepSeek: () => void
  /** 立即重新拉取 Z.ai 额度，对应概览 Z.ai 磁贴标题右侧刷新按钮。 */
  onRefreshZai: () => void
}

/** Tab 键：与面板内视图一一对应。 */
type TabKey = 'overview' | 'dates' | 'sessions' | 'models' | 'settings';

/** Tab 定义：键 + 文案键 + 图标组件。 */
const TABS: { key: TabKey; labelKey: UsageStatsKey; Icon: ComponentType<IconProps> }[] = [
  { key: 'overview', labelKey: 'tab.overview', Icon: IconDataOutline16 },
  { key: 'dates', labelKey: 'tab.dates', Icon: IconRightUpOutline16 },
  { key: 'sessions', labelKey: 'tab.sessions', Icon: IconQueueOutline14 },
  { key: 'models', labelKey: 'tab.models', Icon: IconAgentPresetOutline16 },
  { key: 'settings', labelKey: 'tab.settings', Icon: IconSettingsOutline16 },
];

/** 根据当前激活的 Tab 返回对应的 body 额外类名，避免嵌套三元。 */
function getBodyClass(active: TabKey): string {
  if (active === 'dates') return css.bodyDates;
  if (active === 'sessions') return css.bodySessions;
  if (active === 'models') return css.bodyModels;
  return '';
}

export function UsageStatsPanel({
  open,
  data,
  err,
  go,
  deepseek,
  zai,
  settings,
  onUpdateSettings,
  onClose,
  onRefresh,
  onRefreshGo,
  onRefreshDeepSeek,
  onRefreshZai,
  t,
}: UsageStatsPanelProps) {
  const [active, setActive] = useState<TabKey>('overview');

  const value = data;

  // 内容区渲染，避免嵌套三元
  function renderBody() {
    if (err) {
      return <div className={shared.empty}>{t('state.unavailable')}</div>;
    }
    if (!value) {
      return <div className={shared.empty}>{t('state.loading')}</div>;
    }
    return (
      <>
        {active === 'overview' && (
          <OverviewTab
            value={value}
            go={go}
            deepseek={deepseek}
            zai={zai}
            t={t}
            onRefreshGo={onRefreshGo}
            onRefreshDeepSeek={onRefreshDeepSeek}
            onRefreshZai={onRefreshZai}
            goEnabled={settings.goEnabled}
            deepseekEnabled={settings.deepseekEnabled}
            zaiEnabled={settings.zaiEnabled}
          />
        )}
        {active === 'dates' && <DatesTab series={value.series.all} t={t} />}
        {active === 'sessions' && (
          <SessionsTab sessionsList={value.sessionsList} t={t} />
        )}
        {active === 'models' && <ModelsTab models={value.models} t={t} />}
        {active === 'settings' && (
          <SettingsTab
            onRefresh={onRefresh}
            settings={settings}
            onUpdateSettings={onUpdateSettings}
            t={t}
            value={value}
          />
        )}
      </>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('panel.title')}
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

      {/* Tab 栏：语义化 tablist，无现成 harness 组件，样式与 chip/seg 统一 */}
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

      <div
        className={`${css.body} ${getBodyClass(active)}`}
        role="tabpanel"
      >
        {renderBody()}
      </div>
    </Modal>
  );
}
