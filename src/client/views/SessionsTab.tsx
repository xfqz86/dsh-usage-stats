/**
 * 会话 Tab：按会话表（分页 20/页，子代理折叠到主会话，带加号展开；数据完整展示）。
 * 独立成文件（一个组件一个文件）。
 * 列替换：移除 cacheWrite / reasoning，新增 命中率 与 每次调用；
 * 列顺序：会话 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 最近活跃；
 * 表头支持点击排序（稳定排序，分组后、分页前）。
 */

import { Fragment, useEffect, useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SessionsTab.module.css'
import shared from '../components/UsageStatsCommon.module.css'
import type { SessionStat } from '../useSnapshot.ts'
import type { UsageAgg } from '../useSnapshot.ts'
import { fmt, fmtFull, fullDayLabel, pctOf, shortId, usageTotal, groupSessions } from '../stats.ts'
import { Pagination } from '../components/Pagination.tsx'

const PAGE_SIZE = 20

/** 排序键：与表头一一对应。 */
type SortKey = 'session' | 'calls' | 'input' | 'output' | 'cacheRead' | 'hitRate' | 'total' | 'avg' | 'lastActive'
type SortDir = 'asc' | 'desc'

/** 缓存命中率：cacheRead / (cacheRead + input) *100，1 位小数；分母 0 时为 null。 */
function hitRateOf(usage: UsageAgg): number | null {
  const input = usage.input || 0
  const cacheRead = usage.cacheRead || 0
  const denom = input + cacheRead
  if (denom <= 0) return null
  return Math.round((cacheRead / denom) * 1000) / 10
}

/** 平均每次调用：total / calls 取整；calls 为 0 时为 null。 */
function avgOf(total: number, calls: number): number | null {
  if (!calls || calls <= 0) return null
  return Math.round(total / calls)
}

/** 会话 Tab：分页（20/页）+ 子代理折叠（主会话前 + / −，子不占页位；数据完整展示全分量）。 */
export function SessionsTab({
  sessionsList, sessionsListTotal, t,
}: {
  sessionsList: SessionStat[]
  sessionsListTotal?: number
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 分组：子代理折叠到根主会话，孤儿回落顶层，多级展平
  const groups = useMemo(() => groupSessions(sessionsList), [sessionsList])

  // 表头排序：默认 lastActive desc，点击 th 切换（同键翻转，否则 desc），分页重置至 1
  const [sortKey, setSortKey] = useState<SortKey>('lastActive')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
    setPage(1)
  }

  // 稳定排序：分组后、分页前；数值列取 agg 对应值，命中率/平均按计算值，会话按标题，lastActive 按时间
  const sortedGroups = useMemo(() => {
    if (groups.length === 0) return groups
    const withIdx = groups.map((g, i) => ({ g, i }))
    withIdx.sort((a, b) => {
      let cmp = 0
      const agga = a.g.agg
      const aggb = b.g.agg
      switch (sortKey) {
        case 'session': {
          const av = (a.g.main.title || a.g.main.id || '')
          const bv = (b.g.main.title || b.g.main.id || '')
          cmp = av.localeCompare(bv, 'zh-Hans-CN')
          break
        }
        case 'calls':
          cmp = (agga.calls || 0) - (aggb.calls || 0)
          break
        case 'input':
          cmp = (agga.usage.input || 0) - (aggb.usage.input || 0)
          break
        case 'output':
          cmp = (agga.usage.output || 0) - (aggb.usage.output || 0)
          break
        case 'cacheRead':
          cmp = (agga.usage.cacheRead || 0) - (aggb.usage.cacheRead || 0)
          break
        case 'hitRate': {
          const ah = hitRateOf(agga.usage)
          const bh = hitRateOf(aggb.usage)
          const av = ah == null ? -1 : ah
          const bv = bh == null ? -1 : bh
          cmp = av - bv
          break
        }
        case 'total':
          cmp = usageTotal(agga.usage) - usageTotal(aggb.usage)
          break
        case 'avg': {
          const av = avgOf(usageTotal(agga.usage), agga.calls)
          const bv = avgOf(usageTotal(aggb.usage), aggb.calls)
          const avv = av == null ? -1 : av
          const bvv = bv == null ? -1 : bv
          cmp = avv - bvv
          break
        }
        case 'lastActive':
          cmp = (a.g.main.lastActive || 0) - (b.g.main.lastActive || 0)
          break
        default:
          cmp = 0
      }
      if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp
      return a.i - b.i
    })
    return withIdx.map((x) => x.g)
  }, [groups, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sortedGroups.length / PAGE_SIZE))

  // 列表变化时夹取页码到有效范围
  useEffect(() => {
    setPage((p) => Math.min(Math.max(1, p), totalPages))
  }, [totalPages])

  // 清理已不存在的主会话展开状态
  useEffect(() => {
    if (expanded.size === 0) return
    const alive = new Set(groups.map((g) => g.main.id))
    let changed = false
    const next = new Set<string>()
    for (const id of expanded) {
      if (alive.has(id)) next.add(id)
      else changed = true
    }
    if (changed) setExpanded(next)
  }, [groups, expanded])

  const pageGroups = useMemo(
    () => sortedGroups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sortedGroups, page],
  )

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (sessionsList.length === 0) {
    return <div className={shared.empty}>{t('state.noUsage')}</div>
  }

  // 保留 sessionsListTotal 仅作兼容，主分页以 groups.length 为准
  void sessionsListTotal

  // 表头辅助：渲染可排序 th
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

  return (
    <div className={`${shared.section} ${css.root}`}>
      <div className={css.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <ThSortable k="session" label={t('table.session')} align="left" />
              <ThSortable k="cacheRead" label={t('table.cacheRead')} />
              <ThSortable k="input" label={t('table.input')} />
              <ThSortable k="output" label={t('table.output')} />
              <ThSortable k="total" label={t('table.total')} />
              <ThSortable k="hitRate" label={t('table.hitRate')} />
              <ThSortable k="calls" label={t('table.calls')} />
              <ThSortable k="avg" label={t('table.avgPerCall')} />
              <ThSortable k="lastActive" label={t('table.lastActive')} />
            </tr>
          </thead>
          <tbody>
            {pageGroups.map((g) => {
              const isExpanded = expanded.has(g.main.id)
              const hasChildren = g.childCount > 0
              const when = g.main.lastActive
                ? Date.now() - g.main.lastActive < 86400000
                  ? t('time.today') + ' ' + new Date(g.main.lastActive).toTimeString().slice(0, 5)
                  : fullDayLabel(g.main.lastActive)
                : '--'
              const mainTitle = g.main.title || shortId(g.main.id)
              const agg = g.agg.usage
              const aggHit = hitRateOf(agg)
              const aggAvg = avgOf(usageTotal(agg), g.agg.calls)
              return (
                <Fragment key={g.main.id}>
                  <tr title={(g.main.cwd ? g.main.cwd + '\n' : '') + (g.main.title ? g.main.title : '')}>
                    <td className={shared.cellText}>
                      {hasChildren ? (
                        <button
                          type="button"
                          className={css.expandBtn}
                          aria-expanded={isExpanded}
                          aria-label={t(isExpanded ? 'sessions.collapseChildren' : 'sessions.expandChildren', { n: g.childCount } as unknown as Record<string, unknown>)}
                          onClick={() => toggle(g.main.id)}
                        >
                          {isExpanded ? '−' : '+'}
                        </button>
                      ) : (
                        <span style={{ display: 'inline-block', width: 16, marginRight: 6 }} aria-hidden />
                      )}
                      <span>
                        {mainTitle} <span className={shared.sub}>· {shortId(g.main.id)}</span>
                      </span>
                      {hasChildren && <span className={css.badge}>{t('sessions.childrenCount', { n: g.childCount } as unknown as Record<string, unknown>)}</span>}
                    </td>
                    <td className={shared.num}>{fmt(agg.cacheRead, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                    <td className={shared.num}>{fmt(agg.input, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                    <td className={shared.num}>{fmt(agg.output, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                    <td className={`${shared.num} ${shared.strong}`}>{fmt(usageTotal(agg), t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                    <td className={shared.num}>{aggHit == null ? '--' : pctOf(aggHit)}</td>
                    <td className={shared.num}>{fmtFull(g.agg.calls)}</td>
                    <td className={shared.num}>{aggAvg == null ? '--' : fmtFull(aggAvg)}</td>
                    <td className={shared.num}>{when}</td>
                  </tr>
                  {isExpanded &&
                    g.children.map((c) => {
                      const childWhen = c.lastActive
                        ? Date.now() - c.lastActive < 86400000
                          ? t('time.today') + ' ' + new Date(c.lastActive).toTimeString().slice(0, 5)
                          : fullDayLabel(c.lastActive)
                        : '--'
                      const childHit = hitRateOf(c.usage)
                      const childAvg = avgOf(usageTotal(c.usage), c.calls)
                      return (
                        <tr key={c.id} className={css.childRow} title={(c.cwd ? c.cwd + '\n' : '') + (c.title ? c.title : '')}>
                          <td className={`${shared.cellText} ${css.childCell}`}>
                            <span className={css.indent} aria-hidden>
                              └
                            </span>
                            {c.title || shortId(c.id)} <span className={shared.sub}>· {shortId(c.id)}</span>
                          </td>
                          <td className={shared.num}>{fmt(c.usage.cacheRead, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                          <td className={shared.num}>{fmt(c.usage.input, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                          <td className={shared.num}>{fmt(c.usage.output, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                          <td className={shared.num}>{fmt(usageTotal(c.usage), t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                          <td className={shared.num}>{childHit == null ? '--' : pctOf(childHit)}</td>
                          <td className={shared.num}>{fmtFull(c.calls)}</td>
                          <td className={shared.num}>{childAvg == null ? '--' : fmtFull(childAvg)}</td>
                          <td className={shared.num}>{childWhen}</td>
                        </tr>
                      )
                    })}
                </Fragment>
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
