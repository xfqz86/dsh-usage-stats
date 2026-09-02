/**
 * 通用可排序表头（ThSortable）：点击切换排序方向的 <th> 单元格。
 * 由 DatesTab / SessionsTab / ModelsTab 组件体内的三处内联实现提取而来——
 * 内联组件在每次父渲染时按"不同组件类型"卸载重挂表头子树（焦点丢失、无谓 GC）；
 * 提取为模块级组件后类型稳定，排序行为与样式类名与原实现一致。
 * 独立成文件（一个组件一个文件），样式见 ThSortable.module.css。
 */

import css from './ThSortable.module.css';
import shared from './UsageStatsCommon.module.css';

/** 排序方向：升序 / 降序。 */
export type SortDir = 'asc' | 'desc';

/** 根据激活态与方向返回 aria-sort 取值。 */
function getAriaSort(
  active: boolean,
  dir: SortDir,
): 'ascending' | 'descending' | 'none' {
  if (!active) return 'none';
  return dir === 'asc' ? 'ascending' : 'descending';
}

/** 根据激活态与方向返回排序图标。 */
function getSortIcon(active: boolean, dir: SortDir): string {
  if (!active) return '↕';
  return dir === 'asc' ? '▲' : '▼';
}

/** 可排序表头：props 注入当前排序键 / 方向 / 回调 / 列文案，键相等判定激活态。 */
export function ThSortable<K extends string>({
  k, label, sortKey, sortDir, onSort, align = 'right', className,
}: {
  /** 本列的排序键 */
  k: K
  /** 列文案（调用方已本地化） */
  label: string
  /** 当前激活的排序键 */
  sortKey: K
  /** 当前排序方向 */
  sortDir: SortDir
  /** 点击回调：请求切换到本列排序（翻转方向或改为本列） */
  onSort: (key: K) => void
  /** 对齐：数值列默认右对齐，首列文本列传 left */
  align?: 'left' | 'right'
  /** 附加按钮类：宿主 Tab 经自身 CSS Module 注入微调样式（如长表头缩字号） */
  className?: string
}) {
  const active = sortKey === k;
  const ariaSort = getAriaSort(active, sortDir);
  return (
    <th aria-sort={ariaSort} className={align === 'left' ? undefined : shared.num} style={align === 'left' ? { textAlign: 'left' } : undefined}>
      <button
        type="button"
        className={`${css.thBtn} ${align === 'left' ? css.thBtnLeft : ''} ${active ? css.thBtnActive : ''}${className ? ` ${className}` : ''}`}
        onClick={() => onSort(k)}
        aria-label={label}
      >
        <span>{label}</span>
        <span className={`${css.sortIcon} ${active ? css.sortIconActive : ''}`} aria-hidden>
          {getSortIcon(active, sortDir)}
        </span>
      </button>
    </th>
  );
}
