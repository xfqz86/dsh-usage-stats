/**
 * 设置 Tab：偏好设置、配置迁移折叠区、账本操作折叠区与底部页脚。
 *
 * 偏好持久化在服务端 profile 配置文档的 `usage-stats` 条目（经 ctx.configForms 的表单读写，
 * 见 ../settings.ts 与 ../useUsageSettings.ts），换浏览器、换设备共用同一份；读不到或写不了
 * 时在额度监控表格上方挂一张状态提示卡，正常态不显示存储说明。
 * 额度监控是一张四列表格（行 = 来源，列 = 监控项 / 启用 / 侧边栏展示 / 抓取间隔）：
 * 启用项关掉后不再轮询该来源，展示项只影响侧边栏芯片，关闭监控时后两列置灰不可改。
 * 其余分组为模型统计重定向规则表（ModelRedirectEditor）与会话 ID 徽标开关。
 * 两个折叠区自上而下为配置迁移、账本操作（危险度高的在下）；快照 scanning 为真时
 * 清零/重建置灰，展开账本操作区时给出原因——扫描会与写账本交错，服务端也以 usageStats/busy 拒绝。
 */

import {
  IconAgentPresetOutlineRegular,
  IconChevronDownOutlineRegular,
  IconUserOutlineRegular,
  RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useState } from 'react';

import { postLedgerApi } from '../api.ts';
import { HintCard } from '../components/HintCard.tsx';
import { SettingsSwitch } from '../components/SettingsSwitch.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { fmtFull } from '../stats.ts';
import { useConfirmOp, type ConfirmOpState } from '../useConfirmOp.ts';
import { useUsageSettingsView } from '../useUsageSettings.ts';

import { ConfigTransfer } from './ConfigTransfer.tsx';
import { ModelRedirectEditor } from './ModelRedirectEditor.tsx';
import { QuotaMonitorTable } from './QuotaMonitorTable.tsx';
import css from './SettingsTab.module.css';

import type { UsageSettings } from '../../types.ts';
import type { UsageStatsKey } from '../locales.ts';
import type { UsageSnapshot } from '../useSnapshot.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 设置 Tab：偏好设置 + 账本操作折叠 + 底部页脚。 */
export function SettingsTab({
  onRefresh, settings, onUpdateSettings, onReplaceSettings, t, value,
}: {
  /** 重建/清零完成后立即重新拉取快照。 */
  onRefresh: () => void
  settings: UsageSettings
  onUpdateSettings: (patch: Partial<UsageSettings>) => void
  /** 整份写入偏好设置，仅配置迁移区从配置串导入时使用。 */
  onReplaceSettings: (next: UsageSettings) => void
  t: PropsLocale<'dsh-usage-stats'>['t']
  /** 快照，用于底部页脚的事件数与更新时间。 */
  value: UsageSnapshot | null
}) {
  // 扫描进行中（首启扫描或重建扫描）：清零/重建会与扫描交错，服务端也会以
  // usageStats/busy 拒绝，故扫描期间直接禁用两个按钮，不做无反馈的失败尝试。
  const ledgerLocked = value?.scanning === true;
  // 重建/清零同一写法：二次确认状态机 + 账本接口调用，逻辑收拢于 useConfirmOp/postLedgerApi。
  // locked 传扫描状态：扫描中不允许开二次确认弹窗，按钮同时置灰。
  const rebuild = useConfirmOp(() => postLedgerApi('rebuild', onRefresh), ledgerLocked);
  const clear = useConfirmOp(() => postLedgerApi('clear', onRefresh), ledgerLocked);
  // 账本操作折叠
  const [ledgerOpen, setLedgerOpen] = useState(false);
  // 配置迁移折叠：与账本操作同为危险/低频操作，默认收起
  const [configOpen, setConfigOpen] = useState(false);

  // 存储告警：正常态不占地方，只有读不到或写不了 profile 配置时才提示改动不会保存。
  // 只读分支必须等表单落定（status='ready'）：表单加载中同样报 writable=false，
  // 直接用 !writable 会在每次打开设置页时闪一下并不存在的「不可写」。
  const { status: storageStatus, writable } = useUsageSettingsView();
  const storageWarning = (() => {
    if (storageStatus === 'unavailable') return t('settings.storageUnavailable');
    if (storageStatus === 'ready' && !writable) return t('settings.storageReadonly');
    return null;
  })();

  // 按钮样式与文案：避免嵌套三元，改用 if/else
  const getButtonClass = (state: ConfirmOpState): string => {
    if (state === 'busy') return `${css.refreshBtn} ${css.refreshBtnBusy}`;
    if (state === 'done') return `${css.refreshBtn} ${css.refreshBtnDone}`;
    return css.refreshBtn;
  };
  const opLabel = (state: ConfirmOpState, keys: { busy: UsageStatsKey; done: UsageStatsKey; idle: UsageStatsKey }): string => {
    if (state === 'busy') return t(keys.busy);
    if (state === 'done') return t(keys.done);
    return t(keys.idle);
  };

  return (
    <div className={shared.section}>
      {/* 存储告警：只在读不到/写不了 profile 配置时出现，正常态直接从额度监控卡片开始 */}
      {storageWarning !== null && <HintCard variant="warn" role="status" title={storageWarning} />}

      {/* 额度监控：三个来源压成一张四列表格，开关与间隔的读写全在子视图内 */}
      <QuotaMonitorTable settings={settings} onUpdateSettings={onUpdateSettings} t={t} />

      {/* 模型统计重定向分组：规则条数即徽标，规则编辑器见 ModelRedirectEditor */}
      <div className={css.prefGroup}>
        <div className={css.prefGroupHead}>
          <span className={css.prefGroupIcon} aria-hidden>
            <IconAgentPresetOutlineRegular size={14} />
          </span>
          <span className={css.prefGroupTitle}>{t('settings.modelRedirects')}</span>
          <span className={css.prefGroupCount}>{settings.modelRedirects.length}</span>
        </div>
        <ModelRedirectEditor
          rules={settings.modelRedirects}
          models={value?.models ?? []}
          onChange={(rules) => onUpdateSettings({ modelRedirects: rules })}
          t={t}
        />
      </div>

      {/* 会话分组：标题旁 session-id 徽标开关 */}
      <div className={css.prefGroup}>
        <div className={css.prefGroupHead}>
          <span className={css.prefGroupIcon} aria-hidden>
            <IconUserOutlineRegular size={14} />
          </span>
          <span className={css.prefGroupTitle}>{t('settings.sessionGroup')}</span>
          <span className={css.prefGroupCount}>1</span>
        </div>
        {/* 会话标题旁展示会话 ID，默认开启 */}
        <label className={css.settingRow}>
          <span className={css.settingText}>
            <span className={css.settingTitle}>{t('settings.showSessionId')}</span>
            <span className={css.settingDesc}>{t('settings.showSessionIdHint')}</span>
          </span>
          <SettingsSwitch
            checked={settings.showSessionId}
            onToggle={() => onUpdateSettings({ showSessionId: !settings.showSessionId })}
          />
        </label>
      </div>

      {/* 配置迁移折叠：标题为 t('settings.configTransfer')，默认折叠，导出与导入见 ConfigTransfer */}
      <div className={css.foldSection}>
        <button
          type="button"
          className={css.foldHeader}
          aria-expanded={configOpen}
          onClick={() => setConfigOpen((v) => !v)}
        >
          <span className={shared.sectionLabel}>{t('settings.configTransfer')}</span>
          <IconChevronDownOutlineRegular className={configOpen ? `${css.foldChevron} ${css.foldChevronOpen}` : css.foldChevron} size={14} />
        </button>
        {configOpen && (
          <ConfigTransfer
            settings={settings}
            onReplace={onReplaceSettings}
            writable={writable}
            t={t}
          />
        )}
      </div>

      {/* 账本操作折叠 */}
      <div className={css.foldSection}>
        <button
          type="button"
          className={css.foldHeader}
          aria-expanded={ledgerOpen}
          onClick={() => setLedgerOpen((v) => !v)}
        >
          <span className={shared.sectionLabel}>{t('settings.ledgerOps')}</span>
          <IconChevronDownOutlineRegular className={ledgerOpen ? `${css.foldChevron} ${css.foldChevronOpen}` : css.foldChevron} size={14} />
        </button>
        {ledgerOpen && (
          <div className={css.foldContent}>
            {/* 清零账本 */}
            <div className={shared.sectionHead}>
              <span className={shared.sectionLabel}>{t('settings.clear')}</span>
            </div>
            <button
              type="button"
              className={getButtonClass(clear.state)}
              onClick={clear.arm}
              disabled={clear.state === 'busy' || ledgerLocked}
            >
              {opLabel(clear.state, { busy: 'settings.clearing', done: 'settings.cleared', idle: 'settings.clearAction' })}
            </button>
            <span className={shared.goHint}>{t('settings.clearHint')}</span>

            {/* 重建账本 */}
            <div className={shared.sectionHead}>
              <span className={shared.sectionLabel}>{t('settings.rebuild')}</span>
            </div>
            <button
              type="button"
              className={getButtonClass(rebuild.state)}
              onClick={rebuild.arm}
              disabled={rebuild.state === 'busy' || ledgerLocked}
            >
              {opLabel(rebuild.state, { busy: 'settings.rebuilding', done: 'settings.rebuilt', idle: 'settings.rebuildAction' })}
            </button>
            <span className={shared.goHint}>{t('settings.rebuildHint')}</span>

            {/* 扫描中禁用说明：与按钮 disabled 同步出现，避免点了没反应 */}
            {ledgerLocked && (
              <span className={shared.goHint}>{t('settings.ledgerBusyHint')}</span>
            )}
          </div>
        )}
      </div>

      <RiskConfirmation
        open={clear.confirmOpen}
        title={t('settings.clearConfirmTitle')}
        description={t('settings.clearConfirmDesc')}
        acknowledgeLabel={t('settings.clearConfirmAck')}
        cancelLabel={t('settings.clearCancel')}
        closeLabel={t('panel.close')}
        confirmLabel={t('settings.clearConfirm')}
        acknowledged={clear.acknowledged}
        onAcknowledgedChange={clear.setAcknowledged}
        onCancel={clear.dismiss}
        onConfirm={clear.confirm}
      />

      {/* 二次确认弹窗：复选「我已了解」后才可确认，复用 harness RiskConfirmation */}
      <RiskConfirmation
        open={rebuild.confirmOpen}
        title={t('settings.rebuildConfirmTitle')}
        description={t('settings.rebuildConfirmDesc')}
        acknowledgeLabel={t('settings.rebuildConfirmAck')}
        cancelLabel={t('settings.rebuildCancel')}
        closeLabel={t('panel.close')}
        confirmLabel={t('settings.rebuildConfirm')}
        acknowledged={rebuild.acknowledged}
        onAcknowledgedChange={rebuild.setAcknowledged}
        onCancel={rebuild.dismiss}
        onConfirm={rebuild.confirm}
      />

      {/* 底部页脚：事件数与更新时间 */}
      <div className={css.footer}>
        <span>{t('events')} {fmtFull(value?.foldedEvents ?? 0)}</span>
        <span>{t('updatedAt')} {value?.time ? new Date(value.time).toTimeString().slice(0, 8) : '--'}</span>
      </div>
    </div>
  );
}
