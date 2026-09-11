/**
 * 设置 Tab：偏好设置，含 DeepSeek 余额、OpenCode Go 额度与 Z.ai 额度监控各三项，账本操作折叠内含清零与重建，底部页脚含事件数与更新时间。
 * 独立成文件，一个组件一个文件。
 *
 * 偏好设置持久化在服务端用户设置文档（`$DSH_HOME/settings.yaml` 的 `usage-stats` 段，
 * 经 ctx.settingsScope 的作用域读写，见 ../settings.ts 与 ../useUsageSettings.ts），
 * 换浏览器、换设备共用同一份；本页顶部按作用域状态提示设置存放位置与是否可写。
 * 分组按 DeepSeek 余额、OpenCode Go 额度、Z.ai 额度自上而下排列：
 *   DeepSeek 余额三项：
 *     1. 启用 DeepSeek 余额监控，deepseekEnabled，关闭后不再轮询官方余额接口；
 *     2. 在侧边栏展示 DeepSeek 余额，showDeepSeekInSidebar，只影响底部芯片，不影响模态窗；
 *     3. DeepSeek 余额抓取间隔，deepseekFetchMinutes，单位分钟，下限 3 为 DEEPSEEK_FETCH_MIN_MINUTES、默认 5，关闭监控时 2、3 项置灰不可改。
 *   Go 额度三项：
 *     4. 启用 OpenCode Go 额度监控，goEnabled，关闭后不再轮询官方额度接口；
 *     5. 在侧边栏展示 OpenCode Go 剩余额度，showGoInSidebar，只影响底部芯片，不影响模态窗；
 *     6. OpenCode Go 额度抓取间隔，goFetchMinutes，单位分钟，下限 3 为 GO_FETCH_MIN_MINUTES、默认 5，关闭监控时 5、6 项置灰不可改。
 *   Z.ai 额度三项：
 *     7. 启用 Z.ai 额度监控，zaiEnabled，关闭后不再轮询官方额度接口；
 *     8. 在侧边栏展示 Z.ai 额度，showZaiInSidebar，只影响底部芯片，不影响模态窗；
 *     9. Z.ai 额度抓取间隔，zaiFetchMinutes，单位分钟，下限 3 为 ZAI_FETCH_MIN_MINUTES、默认 5，关闭监控时 8、9 项置灰不可改。
 * 账本操作折叠：标题为 t('settings.ledgerOps')，内含清零与重建两项危险操作；
 * 快照 scanning 为真（首启扫描或重建扫描进行中）时两项同时置灰并给出原因，
 * 扫描期间不允许清零/重建——两者会与扫描交错写同一账本与聚合，服务端也以
 * usageStats/busy 拒绝。
 * 底部页脚：展示事件数与更新时间，原概览页脚迁移至此。
 */

import {
  IconArchiveOutline20,
  IconChevronDownOutline14,
  IconDataOutline16,
  RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useState } from 'react';


import { clampDeepSeekFetchMinutes, clampGoFetchMinutes, clampZaiFetchMinutes, DEEPSEEK_FETCH_MIN_MINUTES, GO_FETCH_MIN_MINUTES, ZAI_FETCH_MIN_MINUTES } from '../../utils.ts';
import { postLedgerApi } from '../api.ts';
import { SettingsSwitch } from '../components/SettingsSwitch.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { fmtFull } from '../stats.ts';
import { useConfirmOp, type ConfirmOpState } from '../useConfirmOp.ts';
import { useIntervalText } from '../useIntervalText.ts';
import { useUsageSettingsView } from '../useUsageSettings.ts';

import css from './SettingsTab.module.css';

import type { UsageSettings } from '../../types.ts';
import type { UsageStatsKey } from '../locales.ts';
import type { UsageSnapshot } from '../useSnapshot.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 设置 Tab：偏好设置 + 账本操作折叠 + 底部页脚。 */
export function SettingsTab({
  onRefresh, settings, onUpdateSettings, t, value,
}: {
  /** 重建/清零完成后立即重新拉取快照。 */
  onRefresh: () => void
  settings: UsageSettings
  onUpdateSettings: (patch: Partial<UsageSettings>) => void
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
  // 三额度抓取间隔同一写法：本地文本态 + 失焦提交，逻辑收拢于 useIntervalText。
  const goInterval = useIntervalText(settings.goFetchMinutes, clampGoFetchMinutes, (m) => onUpdateSettings({ goFetchMinutes: m }));
  const deepseekInterval = useIntervalText(settings.deepseekFetchMinutes, clampDeepSeekFetchMinutes, (m) => onUpdateSettings({ deepseekFetchMinutes: m }));
  const zaiInterval = useIntervalText(settings.zaiFetchMinutes, clampZaiFetchMinutes, (m) => onUpdateSettings({ zaiFetchMinutes: m }));

  // 设置存放位置提示：正常态说明落在服务端配置文件，不可用/只读时明确告知改动不会保存。
  const { status: storageStatus, writable } = useUsageSettingsView();
  const storageHint = (() => {
    if (storageStatus === 'unavailable') return t('settings.storageUnavailable');
    if (!writable) return t('settings.storageReadonly');
    return t('settings.storageHint');
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
      {/* 偏好设置 — 按来源分组，顶部提示设置存放位置与可写状态 */}
      <div className={shared.sectionHead}>
        <span className={shared.sectionLabel}>{t('settings.preferences')}</span>
      </div>
      <span className={shared.goHint}>{storageHint}</span>

      {/* DeepSeek 余额分组 */}
      <div className={css.prefGroup}>
        <div className={css.prefGroupHead}>
          <span className={`${css.prefGroupIcon} ${css.prefGroupIconDeepSeek}`} aria-hidden>
            <IconDataOutline16 size={14} />
          </span>
          <span className={css.prefGroupTitle}>{t('deepseek.title')}</span>
          <span className={css.prefGroupCount}>3</span>
        </div>
        {/* 1. 启用 DeepSeek 监控 */}
        <label className={css.settingRow}>
          <span className={css.settingText}>
            <span className={css.settingTitle}>{t('settings.deepseekEnabled')}</span>
            <span className={css.settingDesc}>{t('settings.deepseekEnabledHint')}</span>
          </span>
          <SettingsSwitch
            checked={settings.deepseekEnabled}
            onToggle={() => onUpdateSettings({ deepseekEnabled: !settings.deepseekEnabled })}
          />
        </label>

        {/* 2. DeepSeek 侧边栏展示，关闭监控时置灰 */}
        <label className={`${css.settingRow} ${settings.deepseekEnabled ? '' : css.settingRowDisabled}`}>
          <span className={css.settingText}>
            <span className={css.settingTitle}>{t('settings.showDeepSeekInSidebar')}</span>
            <span className={css.settingDesc}>{t('settings.showDeepSeekInSidebarHint')}</span>
          </span>
          <SettingsSwitch
            checked={settings.showDeepSeekInSidebar}
            disabled={!settings.deepseekEnabled}
            onToggle={() => onUpdateSettings({ showDeepSeekInSidebar: !settings.showDeepSeekInSidebar })}
          />
        </label>

        {/* 3. DeepSeek 余额抓取间隔，单位分钟，下限 3，关闭监控时置灰 */}
        <label className={`${css.settingRow} ${settings.deepseekEnabled ? '' : css.settingRowDisabled}`}>
          <span className={css.settingText}>
            <span className={css.settingTitle}>{t('settings.deepseekInterval')}</span>
            <span className={css.settingDesc}>
              {t('settings.deepseekIntervalHint', { min: DEEPSEEK_FETCH_MIN_MINUTES })}
            </span>
          </span>
          <span className={css.intervalInput}>
            <input
              type="number"
              min={DEEPSEEK_FETCH_MIN_MINUTES}
              step={1}
              disabled={!settings.deepseekEnabled}
              {...deepseekInterval.field}
            />
            <span className={css.intervalUnit}>{t('settings.unitMinutes')}</span>
          </span>
        </label>
      </div>

      {/* OpenCode Go 额度分组 */}
      <div className={css.prefGroup}>
        <div className={css.prefGroupHead}>
          <span className={css.prefGroupIcon} aria-hidden>
            <IconArchiveOutline20 size={14} />
          </span>
          <span className={css.prefGroupTitle}>{t('go.title')}</span>
          <span className={css.prefGroupCount}>3</span>
        </div>
        {/* 4. 启用 Go 监控 */}
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

        {/* 5. Go 侧边栏展示，关闭监控时置灰 */}
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

        {/* 6. OpenCode Go 额度抓取间隔，单位分钟，下限 3，关闭监控时置灰 */}
        <label className={`${css.settingRow} ${settings.goEnabled ? '' : css.settingRowDisabled}`}>
          <span className={css.settingText}>
            <span className={css.settingTitle}>{t('settings.goInterval')}</span>
            <span className={css.settingDesc}>
              {t('settings.goIntervalHint', { min: GO_FETCH_MIN_MINUTES })}
            </span>
          </span>
          <span className={css.intervalInput}>
            <input
              type="number"
              min={GO_FETCH_MIN_MINUTES}
              step={1}
              disabled={!settings.goEnabled}
              {...goInterval.field}
            />
            <span className={css.intervalUnit}>{t('settings.unitMinutes')}</span>
          </span>
        </label>
      </div>

      {/* Z.ai 额度分组 */}
      <div className={css.prefGroup}>
        <div className={css.prefGroupHead}>
          <span className={`${css.prefGroupIcon} ${css.prefGroupIconDeepSeek}`} aria-hidden>
            <IconDataOutline16 size={14} />
          </span>
          <span className={css.prefGroupTitle}>{t('zai.title')}</span>
          <span className={css.prefGroupCount}>3</span>
        </div>
        {/* 7. 启用 Z.ai 监控 */}
        <label className={css.settingRow}>
          <span className={css.settingText}>
            <span className={css.settingTitle}>{t('settings.zaiEnabled')}</span>
            <span className={css.settingDesc}>{t('settings.zaiEnabledHint')}</span>
          </span>
          <SettingsSwitch
            checked={settings.zaiEnabled}
            onToggle={() => onUpdateSettings({ zaiEnabled: !settings.zaiEnabled })}
          />
        </label>

        {/* 8. Z.ai 侧边栏展示，关闭监控时置灰 */}
        <label className={`${css.settingRow} ${settings.zaiEnabled ? '' : css.settingRowDisabled}`}>
          <span className={css.settingText}>
            <span className={css.settingTitle}>{t('settings.showZaiInSidebar')}</span>
            <span className={css.settingDesc}>{t('settings.showZaiInSidebarHint')}</span>
          </span>
          <SettingsSwitch
            checked={settings.showZaiInSidebar}
            disabled={!settings.zaiEnabled}
            onToggle={() => onUpdateSettings({ showZaiInSidebar: !settings.showZaiInSidebar })}
          />
        </label>

        {/* 9. Z.ai 额度抓取间隔，单位分钟，下限 3，关闭监控时置灰 */}
        <label className={`${css.settingRow} ${settings.zaiEnabled ? '' : css.settingRowDisabled}`}>
          <span className={css.settingText}>
            <span className={css.settingTitle}>{t('settings.zaiInterval')}</span>
            <span className={css.settingDesc}>
              {t('settings.zaiIntervalHint', { min: ZAI_FETCH_MIN_MINUTES })}
            </span>
          </span>
          <span className={css.intervalInput}>
            <input
              type="number"
              min={ZAI_FETCH_MIN_MINUTES}
              step={1}
              disabled={!settings.zaiEnabled}
              {...zaiInterval.field}
            />
            <span className={css.intervalUnit}>{t('settings.unitMinutes')}</span>
          </span>
        </label>
      </div>

      {/* 账本操作折叠 */}
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

      {/* 底部页脚：事件数与更新时间，原概览页脚迁移至此 */}
      <div className={css.footer}>
        <span>{t('events')} {fmtFull(value?.foldedEvents ?? 0)}</span>
        <span>{t('updatedAt')} {value?.time ? new Date(value.time).toTimeString().slice(0, 8) : '--'}</span>
      </div>
    </div>
  );
}
