/**
 * 额度监控表格：设置 Tab 的专属子视图，把 DeepSeek 余额、OpenCode Go 额度与 Z.ai 额度压成
 * 一张四列表格（监控项 / 启用监控 / 在侧边栏展示 / 抓取间隔），一行一个额度来源。
 *
 * 三个来源的字段语义完全一致（启用、侧边栏展示、抓取间隔），故行数据先描述成数组再统一渲染：
 * 新增额度来源时只加一行，不再复制三段 JSX。三个间隔输入手柄必须在组件顶层逐个调用——
 * hook 不能写在数组里；其余列全部按行数据展开。
 *
 * 关闭监控时「在侧边栏展示」与「抓取间隔」两列整格半透明且控件 disabled，取值保持不动、
 * 不回写：关掉监控不改变用户此前选好的展示方式与间隔，重新打开即恢复。
 *
 * 表格语义：行名放在 `<th scope="row">`，`<caption>` 与首列表头只留读屏文本，
 * 两个开关的 aria-label 由「行名 · 列名」拼成——表格里单看开关没有可读名称。
 */

import {
  IconArchiveOutlineRegular,
  IconDataOutlineRegular,
  IconGaugeOutlineRegular,
  IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';

import { clampDeepSeekFetchMinutes, clampGoFetchMinutes, clampZaiFetchMinutes, DEEPSEEK_FETCH_MIN_MINUTES, GO_FETCH_MIN_MINUTES, ZAI_FETCH_MIN_MINUTES } from '../../utils.ts';
import { SettingsSwitch } from '../components/SettingsSwitch.tsx';
import { useIntervalText } from '../useIntervalText.ts';

import css from './QuotaMonitorTable.module.css';

import type { UsageSettings } from '../../types.ts';
import type { UsageStatsKey } from '../locales.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 表格一行：一个额度来源的展示数据与三个控制列的取值、回调。 */
interface MonitorRow {
  /** 行标识，仅用作 React key。 */
  id: string
  /** 行主名文案键，复用 deepseek.title / go.title / zai.title。 */
  nameKey: UsageStatsKey
  /** 行副标题文案键，列出该接口提供的额度窗口。 */
  subKey: UsageStatsKey
  /** 抓取间隔下限（分钟），与 utils.ts 的 clamp 常量同源，落到 input 的 min 与 title。 */
  min: number
  enabled: boolean
  show: boolean
  /** 行图标组件（基座图标集，颜色随 currentColor）。 */
  Icon: typeof IconDataOutlineRegular
  /** useIntervalText 的 field，直接展开到间隔输入上。 */
  interval: ReturnType<typeof useIntervalText>['field']
  onToggleEnabled: () => void
  onToggleShow: () => void
}

/** 额度监控表格：三个额度来源 × 三列控件。 */
export function QuotaMonitorTable({
  settings, onUpdateSettings, t,
}: {
  settings: UsageSettings
  onUpdateSettings: (patch: Partial<UsageSettings>) => void
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 三个间隔输入各自持有本地文本态（随打随改、失焦提交），必须逐个显式调用 hook。
  const deepseekInterval = useIntervalText(settings.deepseekFetchMinutes, clampDeepSeekFetchMinutes, (m) => onUpdateSettings({ deepseekFetchMinutes: m }));
  const goInterval = useIntervalText(settings.goFetchMinutes, clampGoFetchMinutes, (m) => onUpdateSettings({ goFetchMinutes: m }));
  const zaiInterval = useIntervalText(settings.zaiFetchMinutes, clampZaiFetchMinutes, (m) => onUpdateSettings({ zaiFetchMinutes: m }));

  const rows: MonitorRow[] = [
    {
      id: 'deepseek',
      nameKey: 'deepseek.title',
      subKey: 'settings.monitorSubDeepSeek',
      min: DEEPSEEK_FETCH_MIN_MINUTES,
      enabled: settings.deepseekEnabled,
      show: settings.showDeepSeekInSidebar,
      Icon: IconDataOutlineRegular,
      interval: deepseekInterval.field,
      onToggleEnabled: () => onUpdateSettings({ deepseekEnabled: !settings.deepseekEnabled }),
      onToggleShow: () => onUpdateSettings({ showDeepSeekInSidebar: !settings.showDeepSeekInSidebar }),
    },
    {
      id: 'go',
      nameKey: 'go.title',
      subKey: 'settings.monitorSubGo',
      min: GO_FETCH_MIN_MINUTES,
      enabled: settings.goEnabled,
      show: settings.showGoInSidebar,
      Icon: IconArchiveOutlineRegular,
      interval: goInterval.field,
      onToggleEnabled: () => onUpdateSettings({ goEnabled: !settings.goEnabled }),
      onToggleShow: () => onUpdateSettings({ showGoInSidebar: !settings.showGoInSidebar }),
    },
    {
      id: 'zai',
      nameKey: 'zai.title',
      subKey: 'settings.monitorSubZai',
      min: ZAI_FETCH_MIN_MINUTES,
      enabled: settings.zaiEnabled,
      show: settings.showZaiInSidebar,
      Icon: IconSparkleRegular,
      interval: zaiInterval.field,
      onToggleEnabled: () => onUpdateSettings({ zaiEnabled: !settings.zaiEnabled }),
      onToggleShow: () => onUpdateSettings({ showZaiInSidebar: !settings.showZaiInSidebar }),
    },
  ];

  const enabledCount = rows.filter((row) => row.enabled).length;
  /** 关闭监控的两列共用置灰样式：整格半透明，控件另由 disabled 挡住交互。 */
  const controlClass = (enabled: boolean): string => (enabled ? css.control : `${css.control} ${css.controlOff}`);

  return (
    <div className={css.card}>
      <div className={css.head}>
        <span className={css.headIcon} aria-hidden>
          <IconGaugeOutlineRegular size={14} />
        </span>
        <span className={css.headTitle}>{t('settings.monitorGroup')}</span>
        <span className={css.count}>{t('settings.monitorEnabledCount', { on: enabledCount, total: rows.length })}</span>
      </div>

      <table className={css.table}>
        <caption className={css.srOnly}>{t('settings.monitorGroup')}</caption>
        <colgroup>
          <col />
          <col className={css.colEnable} />
          <col className={css.colSidebar} />
          <col className={css.colInterval} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className={css.srOnly}>{t('settings.monitorColItem')}</span>
            </th>
            <th scope="col">{t('settings.monitorColEnable')}</th>
            <th scope="col">{t('settings.monitorColSidebar')}</th>
            <th scope="col">{t('settings.monitorColInterval')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const Icon = row.Icon;
            return (
              <tr key={row.id}>
                <th scope="row">
                  <span className={css.item}>
                    <span className={css.itemIcon} aria-hidden>
                      <Icon size={14} />
                    </span>
                    <span className={css.itemText}>
                      <span className={css.itemName}>{t(row.nameKey)}</span>
                      <span className={css.itemSub}>{t(row.subKey)}</span>
                    </span>
                  </span>
                </th>
                <td className={css.control}>
                  <SettingsSwitch
                    checked={row.enabled}
                    label={`${t(row.nameKey)} · ${t('settings.monitorColEnable')}`}
                    onToggle={row.onToggleEnabled}
                  />
                </td>
                <td className={controlClass(row.enabled)}>
                  <SettingsSwitch
                    checked={row.show}
                    disabled={!row.enabled}
                    label={`${t(row.nameKey)} · ${t('settings.monitorColSidebar')}`}
                    onToggle={row.onToggleShow}
                  />
                </td>
                <td className={controlClass(row.enabled)}>
                  <label className={css.interval}>
                    <input
                      type="number"
                      min={row.min}
                      step={1}
                      className={css.intervalInput}
                      disabled={!row.enabled}
                      aria-label={`${t(row.nameKey)} · ${t('settings.monitorColInterval')}`}
                      title={t('settings.intervalMinHint', { min: row.min })}
                      {...row.interval}
                    />
                    <span className={css.intervalUnit}>{t('settings.unitMinutes')}</span>
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className={css.hint}>{t('settings.monitorHint')}</div>
    </div>
  );
}
