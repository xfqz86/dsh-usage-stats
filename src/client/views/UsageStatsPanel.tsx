/**
 * 用量统计的详情视图：侧边栏底部按钮打开的居中模态窗，头部 + Tab 栏 + 内容区。
 *
 * 五个 Tab 各由独立文件承载（OverviewTab/DatesTab/SessionsTab/ModelsTab/SettingsTab），
 * 条件渲染：切走即卸载，Tab 内视图状态（日期曲线范围、会话展开等）不跨切换保留。
 * 数据与底部按钮共用同一份轮询结果：usageStats/snapshot 与三份额度查询。
 */

import {
  IconAgentPresetOutlineRegular,
  IconCloseOutlineRegular,
  IconDataOutlineRegular,
  IconQueueOutlineRegular,
  IconRightUpOutlineRegular,
  IconSettingsOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useState, useMemo, type ComponentType } from 'react';

import { HintCard } from '../components/HintCard.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { redirectModels } from '../stats.ts';

import { DatesTab } from './DatesTab.tsx';
import { ModelsTab } from './ModelsTab.tsx';
import { OverviewTab } from './OverviewTab.tsx';
import { SessionsTab } from './SessionsTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import css from './UsageStatsPanel.module.css';

import type { DeepSeekBalance, UsageSettings, ZaiQuota } from '../../types.ts';
import type { UsageStatsKey } from '../locales.ts';
import type { GoQuota } from '../useQuota.ts';
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
  /** 快照失败的真实原因，作为错误卡片第二行展示。 */
  errDetail?: string | null
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
  /** 整份写入偏好设置，仅设置页的配置迁移区从配置串导入时使用。 */
  onReplaceSettings: (next: UsageSettings) => void
  /** 关闭模态窗，通过关闭按钮、遮罩点击或 Escape 触发。 */
  onClose: () => void
  /** 立即重新拉取快照、Go 额度、DeepSeek 余额与 Z.ai 额度，账本重建/清零完成后由设置页调用。 */
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
  { key: 'overview', labelKey: 'tab.overview', Icon: IconDataOutlineRegular },
  { key: 'dates', labelKey: 'tab.dates', Icon: IconRightUpOutlineRegular },
  { key: 'sessions', labelKey: 'tab.sessions', Icon: IconQueueOutlineRegular },
  { key: 'models', labelKey: 'tab.models', Icon: IconAgentPresetOutlineRegular },
  { key: 'settings', labelKey: 'tab.settings', Icon: IconSettingsOutlineRegular },
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
  errDetail,
  go,
  deepseek,
  zai,
  settings,
  onUpdateSettings,
  onReplaceSettings,
  onClose,
  onRefresh,
  onRefreshGo,
  onRefreshDeepSeek,
  onRefreshZai,
  t,
}: UsageStatsPanelProps) {
  const [active, setActive] = useState<TabKey>('overview');

  const value = data;

  // 模型统计重定向：按偏好里的规则归并模型行（设置页拿原始行当候选，故这里才算），
  // 模型页消费归并结果，日期明细的按模型标签拿规则自己算当天的行（服务端明细始终是原始行）。
  const redirect = useMemo(
    () => redirectModels(value?.models ?? [], settings.modelRedirects),
    [value?.models, settings.modelRedirects],
  );

  // 内容区渲染，避免嵌套三元
  function renderBody() {
    if (err) {
      // errDetail 是快照失败原因，作为错误卡片第二行展示，没有则省略。
      return (
        <div className={shared.statusWrap}>
          <HintCard
            variant="error"
            role="alert"
            title={t('state.unavailable')}
            detail={errDetail ?? undefined}
          />
        </div>
      );
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
        {active === 'dates' && <DatesTab series={value.series.all} rules={settings.modelRedirects} t={t} />}
        {active === 'sessions' && (
          <SessionsTab sessionsList={value.sessionsList} rules={settings.modelRedirects} t={t} />
        )}
        {active === 'models' && (
          <ModelsTab models={redirect.models} mergedSources={redirect.mergedSources} t={t} />
        )}
        {active === 'settings' && (
          <SettingsTab
            onRefresh={onRefresh}
            settings={settings}
            onUpdateSettings={onUpdateSettings}
            onReplaceSettings={onReplaceSettings}
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
            aria-label={t('panel.close')}
          >
            <IconCloseOutlineRegular size={14} />
          </button>
        </span>
      </header>

      {/* Tab 栏：语义化 tablist，无现成 harness 组件，形态与模型明细弹窗共用（UsageStatsCommon） */}
      <div className={shared.tabbar} role="tablist" aria-label={t('panel.title')}>
        {TABS.map(({ key, labelKey, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            className={active === key ? `${shared.tab} ${shared.tabOn}` : shared.tab}
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
