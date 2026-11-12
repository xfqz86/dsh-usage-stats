/**
 * 模型表分组切换条：不分组 / 按厂商 / 按模型三段 chips。
 */

import shared from './UsageStatsCommon.module.css';

import type { ModelGroupMode } from '../stats.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 模型表分组切换条：三段 chips 单选，复用共用 chip 样式。 */
export function ModelGroupBar({
  value, onChange, t,
}: {
  value: ModelGroupMode
  onChange: (m: ModelGroupMode) => void
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  const modes: [ModelGroupMode, 'models.groupNone' | 'models.groupProvider' | 'models.groupModel'][] = [
    ['none', 'models.groupNone'],
    ['provider', 'models.groupProvider'],
    ['model', 'models.groupModel'],
  ];
  return (
    <span className={shared.chips} role="radiogroup" aria-label={t('models.groupLabel')}>
      {modes.map(([mode, labelKey]) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          className={value === mode ? `${shared.chip} ${shared.chipOn}` : shared.chip}
          onClick={() => onChange(mode)}
        >
          {t(labelKey)}
        </button>
      ))}
    </span>
  );
}
