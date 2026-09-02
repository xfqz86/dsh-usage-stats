/**
 * 设置 Tab 的开关控件（role="switch"）。
 *
 * 独立成文件（一个组件一个文件），供 SettingsTab 使用。样式见
 * SettingsSwitch.module.css 的 switch 类（设计 token 配色）。
 */

import css from './SettingsSwitch.module.css';

/** 开关（role="switch"）：带 aria-checked，disabled 时不可点。 */
export function SettingsSwitch({ checked, disabled, onToggle }: {
  checked: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`${css.switch} ${checked ? css.switchOn : ''}`}
      onClick={onToggle}
    >
      <span className={css.switchKnob} />
    </button>
  );
}
