/**
 * 模型明细弹窗的「按日期」子视图：该模型在范围内的每日用量——顶部每日趋势图、
 * 下方用量表，构成与日期 Tab 一致（图由 StackedBar 补齐范围内每一天，表格只列
 * 真正有量的日子）；列与日期 Tab 对齐（日期 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用），
 * 可排序、每页 15 条。天桶来自聚合缓存的模型×日；时间范围在模型页选定，这里不重复给切换。
 */

import { useMemo } from 'react';

import { Pagination } from '../components/Pagination.tsx';
import { StackedBar } from '../components/StackedBar.tsx';
import { ThSortable } from '../components/ThSortable.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { avgPerCall, dayTotal, fmt, fmtFull, fullDayLabel, hitRateOfDay, pctOf, type DateRange } from '../stats.ts';
import { stableSort, useSortTable } from '../useSortTable.ts';

import css from './ModelDetail.module.css';

import type { SeriesPoint } from '../../types.ts';
import type { LocaleFn } from '../locales.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 每页行数：弹窗高度有限，15 行既填满内容区又不出现内层滚动条。 */
const PAGE_SIZE = 15;

/** 排序键：与表头一一对应。 */
type SortKey = 'date' | 'input' | 'output' | 'cacheRead' | 'total' | 'hitRate' | 'calls' | 'avg';

/** 模型明细的按日期表。 */
export function ModelDetailDates({
  daily, range, t,
}: {
  daily: SeriesPoint[]
  /** 时间范围，与模型页同一取值：图表用它补齐每一天，缺省即全部历史。 */
  range: DateRange
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 本地化函数单点转换：纯函数要的无命名空间形态，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;

  // 排序分页三件套（与三张主表同一交互；排序不增删行）
  const { sortKey, sortDir, handleSort, page, totalPages, setPage, slice } = useSortTable<SortKey>('date', daily.length, PAGE_SIZE);

  const sortedDays = useMemo(() => stableSort(daily, (a, b) => {
    switch (sortKey) {
      case 'date': return a.t - b.t;
      case 'input': return (a.input || 0) - (b.input || 0);
      case 'output': return (a.output || 0) - (b.output || 0);
      case 'cacheRead': return (a.cacheRead || 0) - (b.cacheRead || 0);
      case 'total': return dayTotal(a) - dayTotal(b);
      case 'hitRate': return (hitRateOfDay(a) ?? -1) - (hitRateOfDay(b) ?? -1);
      case 'calls': return (a.calls || 0) - (b.calls || 0);
      case 'avg': return (avgPerCall(dayTotal(a), a.calls) ?? -1) - (avgPerCall(dayTotal(b), b.calls) ?? -1);
      default: return 0;
    }
  }, sortDir), [daily, sortKey, sortDir]);

  const pageDays = useMemo(() => slice(sortedDays), [slice, sortedDays]);

  return (
    <div className={shared.detailTableBlock}>
      <div className={shared.charts}>
        <div className={shared.chartCard}>
          <StackedBar mode="date" series={daily} range={range} t={t} />
        </div>
      </div>
      <div className={`${shared.tableWrap} ${shared.firstCol} ${css.datesWrap}`}>
        <table className={shared.table}>
          <thead>
            <tr>
              <ThSortable k="date" label={t('tab.dates')} align="left" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="cacheRead" label={t('table.cacheRead')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="input" label={t('table.input')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="output" label={t('table.output')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="total" label={t('table.total')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="hitRate" label={t('table.hitRate')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="calls" label={t('table.calls')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="avg" label={t('table.avgPerCall')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {pageDays.map((d) => (
              <tr key={d.t}>
                <td className={shared.cellText}>{fullDayLabel(d.t)}</td>
                <td className={shared.num}>{fmt(d.cacheRead, tFn)}</td>
                <td className={shared.num}>{fmt(d.input, tFn)}</td>
                <td className={shared.num}>{fmt(d.output, tFn)}</td>
                <td className={`${shared.num} ${shared.strong}`}>{fmt(dayTotal(d), tFn)}</td>
                <td className={shared.num}>{pctOf(hitRateOfDay(d))}</td>
                <td className={shared.num}>{fmtFull(d.calls)}</td>
                <td className={shared.num}>{fmtFull(avgPerCall(dayTotal(d), d.calls))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className={shared.paginationBar}>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} t={t} />
        </div>
      )}
    </div>
  );
}
