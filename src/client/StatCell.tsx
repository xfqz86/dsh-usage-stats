/**
 * 概览 Tab 的统计格（数值 + 标签）。
 *
 * 独立成文件（一个组件一个文件），供 OverviewTab 复用。样式沿用
 * UsageStatsPanel.module.css 的 cell 类。
 */

import type { ReactNode } from 'react'
import css from './UsageStatsPanel.module.css'

/** 渲染一个统计格（数值 + 标签）。 */
export function StatCell({ value, label }: { value: string; label: ReactNode }) {
  return (
    <div className={css.cell}>
      <span className={css.cellV}>{value}</span>
      <span className={css.cellK}>{label}</span>
    </div>
  )
}
