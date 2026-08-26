/**
 * 日期 Tab：堆叠柱状图 + 范围切换 + 数据表格（与模型/会话 Tab 对齐）。
 * 顶部为按 token 类型堆叠的每日柱状图（DateStackedBar，横向滚动）；
 * 中间为靠右的范围 chips（7d/14d/30d/90d/180d/365d/全部，默认全部，位于图表与表格之间）；
 * 底部为可排序分页的每日明细表格（日期 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用）。
 * 独立成文件（一个组件一个文件）。
 */

import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DatesTab.module.css'
import shared from '../components/UsageStatsCommon.module.css'
import type { SeriesPoint } from '../../types.ts'
import { fmt, fmtFull, fullDayLabel, pctOf, buildDateStack, type DateRange } from '../stats.ts'
import { DateStackedBar } from '../components/DateStackedBar.tsx'
import { Pagination } from '../components/Pagination.tsx'

const PAGE_SIZE = 20

/** 缓存命中率：cacheRead / (cacheRead + input) *100，1 位小数；分母 0 时为 null。 */
function hitRateOfDay(d: { input?: number; cacheRead?: number }): number | null {
  const input = d.input || 0
  const cacheRead = d.cacheRead || 0
  const denom = input + cacheRead
  if (denom <= 0) return null
  return Math.round((cacheRead / denom) * 1000) / 10
}

/** 平均每次调用：total / calls 取整；calls 为 0 时为 null。 */
function avgOfDay(total: number, calls: number): number | null {
  if (!calls || calls <= 0) return null
  return Math.round(total / calls)
}

/** 排序键：与表头一一对应（日期 + 数值列）。 */
type SortKey = 'date' | 'input' | 'output' | 'cacheRead' | 'total' | 'hitRate' | 'calls' | 'avg'
type SortDir = 'asc' | 'desc'

/** 时间范围选项：值 + 文案键（与 locales 的 range.* 对齐，默认全部）。 */
const DATE_RANGES: Array<[DateRange, string]> = [
  ['7d', 'range.7d'],
  ['14d', 'range.14d'],
  ['30d', 'range.30d'],
  ['90d', 'range.90d'],
  ['180d', 'range.180d'],
  ['365d', 'range.365d'],
  ['all', 'range.all'],
]

/** 日期 Tab：堆叠柱 + 范围切换（图表与表格之间、右对齐）+ 排序分页表格，容器与会话/模型 Tab 对齐。 */
export function DatesTab({
  series, t,
}: {
  series: SeriesPoint[]
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  const [range, setRange] = useState<DateRange>('all')
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [page, setPage] = useState(1)

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
    setPage(1)
  }

  // 按范围构建堆叠数据（固定窗口按日历推进，all 时从最早日到今日、最多 366 天）
  const stack = useMemo(() => buildDateStack(series, range), [series, range])

  // 范围切换时分页回到首位
  useEffect(() => {
    setPage(1)
  }, [range])

  // 排序：基于堆叠后的日列表（已按 range 过滤且含零值补齐），稳定排序
  const sortedDays = useMemo(() => {
    if (stack.days.length === 0) return []
    const withIdx = stack.days.map((d, i) => ({ d, i }))
    withIdx.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'date':
          cmp = a.d.t - b.d.t
          break
        case 'input':
          cmp = (a.d.input || 0) - (b.d.input || 0)
          break
        case 'output':
          cmp = (a.d.output || 0) - (b.d.output || 0)
          break
        case 'cacheRead':
          cmp = (a.d.cacheRead || 0) - (b.d.cacheRead || 0)
          break
        case 'total':
          cmp = (a.d.total || 0) - (b.d.total || 0)
          break
        case 'hitRate': {
          const ah = hitRateOfDay(a.d)
          const bh = hitRateOfDay(b.d)
          const av = ah == null ? -1 : ah
          const bv = bh == null ? -1 : bh
          cmp = av - bv
          break
        }
        case 'calls':
          cmp = (a.d.calls || 0) - (b.d.calls || 0)
          break
        case 'avg': {
          const av = avgOfDay(a.d.total || 0, a.d.calls || 0)
          const bv = avgOfDay(b.d.total || 0, b.d.calls || 0)
          const avv = av == null ? -1 : av
          const bvv = bv == null ? -1 : bv
          cmp = avv - bvv
          break
        }
        default:
          cmp = 0
      }
      if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp
      return a.i - b.i
    })
    return withIdx.map((x) => x.d)
  }, [stack.days, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sortedDays.length / PAGE_SIZE))

  useEffect(() => {
    setPage((p) => Math.min(Math.max(1, p), totalPages))
  }, [totalPages])

  const pageDays = useMemo(
    () => sortedDays.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sortedDays, page],
  )

  const ThSortable = ({
    k, label, align = 'right',
  }: {
    k: SortKey
    label: string
    align?: 'left' | 'right'
  }) => {
    const active = sortKey === k
    const ariaSort: 'ascending' | 'descending' | 'none' = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
    return (
      <th aria-sort={ariaSort} className={align === 'left' ? undefined : shared.num} style={align === 'left' ? { textAlign: 'left' } : undefined}>
        <button
          type="button"
          className={`${css.thBtn} ${align === 'left' ? css.thBtnLeft : ''} ${active ? css.thBtnActive : ''}`}
          onClick={() => handleSort(k)}
          aria-label={label}
        >
          <span>{label}</span>
          <span className={`${css.sortIcon} ${active ? css.sortIconActive : ''}`} aria-hidden>
            {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    )
  }

  // 完全无数据（历史为空）与过滤后无数据区分
  if (series.length === 0) {
    return <div className={shared.empty}>{t('state.noUsage')}</div>
  }

  if (stack.days.length === 0) {
    return <div className={shared.empty}>{t('state.noUsage')}</div>
  }

  return (
    <div className={`${shared.section} ${css.root}`}>
      <div className={css.charts}>
        <div className={css.chartCard}>
          <DateStackedBar series={series} range={range} t={t} />
        </div>
      </div>
      <div className={css.rangeBar}>
        <span className={css.chips}>
          {DATE_RANGES.map(([value, labelKey]) => (
            <button
              key={value}
              type="button"
              className={range === value ? `${css.chip} ${css.chipOn}` : css.chip}
              onClick={() => setRange(value)}
            >
              {t(labelKey as never)}
            </button>
          ))}
        </span>
      </div>
      <div className={css.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <ThSortable k="date" label={t('tab.dates')} align="left" />
              <ThSortable k="cacheRead" label={t('table.cacheRead')} />
              <ThSortable k="input" label={t('table.input')} />
              <ThSortable k="output" label={t('table.output')} />
              <ThSortable k="total" label={t('table.total')} />
              <ThSortable k="hitRate" label={t('table.hitRate')} />
              <ThSortable k="calls" label={t('table.calls')} />
              <ThSortable k="avg" label={t('table.avgPerCall')} />
            </tr>
          </thead>
          <tbody>
            {pageDays.map((d) => {
              const hit = hitRateOfDay(d)
              const avg = avgOfDay(d.total || 0, d.calls || 0)
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
              )
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className={css.paginationBar}>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} t={t} />
        </div>
      )}
    </div>
  )
}
