/**
 * 概览 Tab 的统计磁贴（可选图标 + 数值 + 标签）。
 *
 * 独立成文件（一个组件一个文件），供 OverviewTab 复用。样式沿用
 * UsageStatsPanel.module.css 的 cell（磁贴）类；icon 为空时保留纯文字布局。
 */

import type { ReactNode } from 'react'
import css from './UsageStatsCommon.module.css'

/** 渲染一个统计磁贴（可选图标 + 数值 + 标签）。 */
export function StatCell({
  icon,
  value,
  label,
}: {
  icon?: ReactNode
  value: string
  label: ReactNode
}) {
  return (
    <div className={css.cell}>
      {icon != null && <span className={css.cellIcon}>{icon}</span>}
      <span className={css.cellV}>{value}</span>
      <span className={css.cellK}>{label}</span>
    </div>
  )
}
