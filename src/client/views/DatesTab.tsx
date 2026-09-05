/**
 * 日期 Tab：堆叠柱状图、范围切换与数据表格，与模型、会话 Tab 对齐。
 * 顶部为按输入、输出、缓存三段堆叠的每日柱状图并叠加缓存命中率折线，使用 StackedBar mode="date" 横向滚动；
 * 柱高仅按展示三段求和（不含缓存写入与推理），tooltip 与表格的 total 仍为全口径 dayTotal；
 * 中间为靠右的范围 chips，含 7d、14d、30d、90d、180d、365d 与全部，默认1年，位于图表与表格之间；
 * 底部为可排序分页的每日明细表格，含日期、缓存、输入、输出、总计、命中率、调用与每次调用列。
 * 独立成文件，一个组件一个文件。
 */

import { useEffect, useMemo, useState } from 'react';

import { Pagination } from '../components/Pagination.tsx';
import { StackedBar } from '../components/StackedBar.tsx';
import { ThSortable } from '../components/ThSortable.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { avgPerCall, buildDateStack, fmt, fmtFull, fullDayLabel, hitRateOfDay, pctOf, type DateRange } from '../stats.ts';
import { stableSort, useSortTable } from '../useSortTable.ts';

import css from './DatesTab.module.css';

import type { SeriesPoint } from '../../types.ts';
import type { LocaleFn, UsageStatsKey } from '../locales.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

const PAGE_SIZE = 20;

/** 排序键：与表头一一对应，含日期与数值列。 */
type SortKey = 'date' | 'input' | 'output' | 'cacheRead' | 'total' | 'hitRate' | 'calls' | 'avg';

/** 时间范围选项：值与文案键，与 locales 的 range.* 对齐，默认1年。 */
const DATE_RANGES: [DateRange, UsageStatsKey][] = [
  ['7d', 'range.7d'],
  ['14d', 'range.14d'],
  ['30d', 'range.30d'],
  ['90d', 'range.90d'],
  ['180d', 'range.180d'],
  ['365d', 'range.365d'],
  ['all', 'range.all'],
];

/** 日期 Tab：堆叠柱、范围切换与排序分页表格，范围切换位于图表与表格之间且右对齐，容器与会话、模型 Tab 对齐。 */
export function DatesTab({
  series, t,
}: {
  series: SeriesPoint[]
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 本地化函数单点转换：纯函数要的无命名空间形态，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;
  const [range, setRange] = useState<DateRange>('365d');

  // 按范围构建堆叠数据，固定窗口按日历推进，all 时从最早日到今日、最多 366 天
  const stack = useMemo(() => buildDateStack(series, range, tFn), [series, range, tFn]);

  // 排序分页三件套（三表同一交互，比较函数保留领域差异；排序不增删行，行数取堆叠长度）
  const { sortKey, sortDir, handleSort, page, totalPages, setPage, slice } = useSortTable<SortKey>('date', stack.days.length, PAGE_SIZE);

  // 范围切换时分页回到首位
  useEffect(() => {
    setPage(1);
  }, [range, setPage]);

  // 排序：基于堆叠后的日列表，已按 range 过滤且含零值补齐
  const sortedDays = useMemo(() => stableSort(stack.days, (a, b) => {
    switch (sortKey) {
      case 'date': return a.t - b.t;
      case 'input': return (a.input || 0) - (b.input || 0);
      case 'output': return (a.output || 0) - (b.output || 0);
      case 'cacheRead': return (a.cacheRead || 0) - (b.cacheRead || 0);
      case 'total': return (a.total || 0) - (b.total || 0);
      case 'hitRate': return (hitRateOfDay(a) ?? -1) - (hitRateOfDay(b) ?? -1);
      case 'calls': return (a.calls || 0) - (b.calls || 0);
      case 'avg': return (avgPerCall(a.total || 0, a.calls || 0) ?? -1) - (avgPerCall(b.total || 0, b.calls || 0) ?? -1);
      default: return 0;
    }
  }, sortDir), [stack.days, sortKey, sortDir]);

  const pageDays = useMemo(() => slice(sortedDays), [slice, sortedDays]);

  // 完全无数据即历史为空，与过滤后无数据区分
  if (series.length === 0) {
    return <div className={shared.empty}>{t('state.noUsage')}</div>;
  }

  if (stack.days.length === 0) {
    return <div className={shared.empty}>{t('state.noUsage')}</div>;
  }

  return (
    <div className={`${shared.section} ${shared.tableViewRoot}`}>
      <div className={css.charts}>
        <div className={shared.chartCard}>
          <StackedBar mode="date" series={series} range={range} t={t} />
        </div>
      </div>
      <div className={shared.rangeBar}>
        <span className={shared.chips}>
          {DATE_RANGES.map(([value, labelKey]) => (
            <button
              key={value}
              type="button"
              className={range === value ? `${shared.chip} ${shared.chipOn}` : shared.chip}
              onClick={() => setRange(value)}
            >
              {t(labelKey)}
            </button>
          ))}
        </span>
      </div>
      <div className={`${shared.tableWrap} ${css.tableWrap}`}>
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
            {pageDays.map((d) => {
              const hit = hitRateOfDay(d);
              const avg = avgPerCall(d.total || 0, d.calls || 0);
              return (
                <tr key={d.t}>
                  <td className={shared.cellText}>{fullDayLabel(d.t)}</td>
                  <td className={shared.num}>{fmt(d.cacheRead, tFn)}</td>
                  <td className={shared.num}>{fmt(d.input, tFn)}</td>
                  <td className={shared.num}>{fmt(d.output, tFn)}</td>
                  <td className={`${shared.num} ${shared.strong}`}>{fmt(d.total, tFn)}</td>
                  <td className={shared.num}>{pctOf(hit)}</td>
                  <td className={shared.num}>{fmtFull(d.calls)}</td>
                  <td className={shared.num}>{fmtFull(avg)}</td>
                </tr>
              );
            })}
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
