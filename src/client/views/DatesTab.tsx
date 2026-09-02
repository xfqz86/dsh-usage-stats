/**
 * 日期 Tab：堆叠柱状图、范围切换与数据表格，与模型、会话 Tab 对齐。
 * 顶部为按 token 类型堆叠的每日柱状图，使用 StackedBar mode="date" 横向滚动；
 * 中间为靠右的范围 chips，含 7d、14d、30d、90d、180d、365d 与全部，默认全部，位于图表与表格之间；
 * 底部为可排序分页的每日明细表格，含日期、缓存、输入、输出、总计、命中率、调用与每次调用列。
 * 独立成文件，一个组件一个文件。
 */

import { useEffect, useMemo, useState } from 'react';

import { Pagination } from '../components/Pagination.tsx';
import { StackedBar } from '../components/StackedBar.tsx';
import { ThSortable, type SortDir } from '../components/ThSortable.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { fmt, fmtFull, fullDayLabel, pctOf, buildDateStack, type DateRange } from '../stats.ts';

import css from './DatesTab.module.css';

import type { SeriesPoint } from '../../types.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

const PAGE_SIZE = 20;

/** 缓存命中率：cacheRead 除以 cacheRead 与 input 之和乘 100，保留 1 位小数，分母为 0 时为 null。 */
function hitRateOfDay(d: { input?: number; cacheRead?: number }): number | null {
  const input = d.input ?? 0;
  const cacheRead = d.cacheRead ?? 0;
  const denom = input + cacheRead;
  if (denom <= 0) return null;
  return Math.round((cacheRead / denom) * 1000) / 10;
}

/** 平均每次调用：total / calls 取整；calls 为 0 时为 null。 */
function avgOfDay(total: number, calls: number): number | null {
  if (!calls || calls <= 0) return null;
  return Math.round(total / calls);
}

/** 排序键：与表头一一对应，含日期与数值列。 */
type SortKey = 'date' | 'input' | 'output' | 'cacheRead' | 'total' | 'hitRate' | 'calls' | 'avg';

/** 时间范围选项：值与文案键，与 locales 的 range.* 对齐，默认全部。 */
const DATE_RANGES: [DateRange, string][] = [
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
  const [range, setRange] = useState<DateRange>('all');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(1);
  };

  // 按范围构建堆叠数据，固定窗口按日历推进，all 时从最早日到今日、最多 366 天
  const stack = useMemo(() => buildDateStack(series, range, t as unknown as (k: string, p?: Record<string, unknown>) => string), [series, range, t]);

  // 范围切换时分页回到首位
  useEffect(() => {
    setPage(1);
  }, [range]);

  // 排序：基于堆叠后的日列表，已按 range 过滤且含零值补齐，稳定排序
  const sortedDays = useMemo(() => {
    if (stack.days.length === 0) return [];
    const withIdx = stack.days.map((d, i) => ({ d, i }));
    withIdx.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'date':
          cmp = a.d.t - b.d.t;
          break;
        case 'input':
          cmp = (a.d.input || 0) - (b.d.input || 0);
          break;
        case 'output':
          cmp = (a.d.output || 0) - (b.d.output || 0);
          break;
        case 'cacheRead':
          cmp = (a.d.cacheRead || 0) - (b.d.cacheRead || 0);
          break;
        case 'total':
          cmp = (a.d.total || 0) - (b.d.total || 0);
          break;
        case 'hitRate': {
          const ah = hitRateOfDay(a.d);
          const bh = hitRateOfDay(b.d);
          const av = ah ?? -1;
          const bv = bh ?? -1;
          cmp = av - bv;
          break;
        }
        case 'calls':
          cmp = (a.d.calls || 0) - (b.d.calls || 0);
          break;
        case 'avg': {
          const av = avgOfDay(a.d.total || 0, a.d.calls || 0);
          const bv = avgOfDay(b.d.total || 0, b.d.calls || 0);
          const avv = av ?? -1;
          const bvv = bv ?? -1;
          cmp = avv - bvv;
          break;
        }
        default:
          cmp = 0;
      }
      if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp;
      return a.i - b.i;
    });
    return withIdx.map((x) => x.d);
  }, [stack.days, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedDays.length / PAGE_SIZE));

  useEffect(() => {
    setPage((p) => Math.min(Math.max(1, p), totalPages));
  }, [totalPages]);

  const pageDays = useMemo(
    () => sortedDays.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sortedDays, page],
  );

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
              {t(labelKey as never)}
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
              const avg = avgOfDay(d.total || 0, d.calls || 0);
              return (
                <tr key={d.t}>
                  <td className={shared.cellText}>{fullDayLabel(d.t)}</td>
                  <td className={shared.num}>{fmt(d.cacheRead, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                  <td className={shared.num}>{fmt(d.input, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                  <td className={shared.num}>{fmt(d.output, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                  <td className={`${shared.num} ${shared.strong}`}>{fmt(d.total, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                  <td className={shared.num}>{hit == null ? '--' : pctOf(hit)}</td>
                  <td className={shared.num}>{fmtFull(d.calls)}</td>
                  <td className={shared.num}>{avg == null ? '--' : fmtFull(avg)}</td>
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
