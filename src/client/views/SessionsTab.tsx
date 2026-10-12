/**
 * 会话 Tab：按会话表分页展示，每页 20 条，子代理折叠到主会话，带加号展开，数据完整展示。
 * 独立成文件，一个组件一个文件。
 * 列顺序：会话 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 最近活跃；
 * 表头支持点击排序，稳定排序，分组后分页前执行；分组与排序比较在 stats.ts，
 * 与模型明细的按会话表共用同一份（两处列、排序与折叠一致）。
 */

import { Fragment, useEffect, useMemo, useState } from 'react';

import { Pagination } from '../components/Pagination.tsx';
import { ThSortable } from '../components/ThSortable.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { avgPerCall, compareSessionGroup, fmt, fmtFull, formatLastActive, hitRateOfDay, pctOf, shortId, usageTotal, groupSessions, type SessionSortKey } from '../stats.ts';
import { stableSort, useSortTable } from '../useSortTable.ts';

import css from './SessionsTab.module.css';

import type { LocaleFn } from '../locales.ts';
import type { SessionStat } from '../useSnapshot.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

const PAGE_SIZE = 20;

/** 会话 Tab：分页每页 20 条，子代理折叠，主会话前显示 + / −，子项不占页位，数据完整展示全分量。 */
export function SessionsTab({
  sessionsList, t,
}: {
  sessionsList: SessionStat[]
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 本地化函数单点转换：纯函数要的无命名空间形态，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;
  // 分组：子代理折叠到根主会话，孤儿回落顶层，多级展平
  const groups = useMemo(() => groupSessions(sessionsList), [sessionsList]);

  // 排序分页三件套（三表同一交互，比较函数保留领域差异；排序不增删行）
  const { sortKey, sortDir, handleSort, page, totalPages, setPage, slice } = useSortTable<SessionSortKey>('lastActive', groups.length, PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // 排序：分组后、分页前；比较函数与模型明细的按会话表共用（stats.compareSessionGroup）
  const sortedGroups = useMemo(
    () => stableSort(groups, (a, b) => compareSessionGroup(sortKey, a, b), sortDir),
    [groups, sortKey, sortDir],
  );

  // 清理已不存在的主会话展开状态
  useEffect(() => {
    if (expanded.size === 0) return;
    const alive = new Set(groups.map((g) => g.main.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of expanded) {
      if (alive.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setExpanded(next);
  }, [groups, expanded]);

  const pageGroups = useMemo(() => slice(sortedGroups), [slice, sortedGroups]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (sessionsList.length === 0) {
    return <div className={shared.empty}>{t('state.noUsage')}</div>;
  }

  return (
    <div className={`${shared.section} ${shared.tableViewRoot}`}>
      <div className={`${shared.tableWrap} ${shared.firstCol} ${css.tableWrap}`}>
        <table className={shared.table}>
          <thead>
            <tr>
              <ThSortable k="session" label={t('table.session')} align="left" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="cacheRead" label={t('table.cacheRead')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="input" label={t('table.input')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="output" label={t('table.output')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="total" label={t('table.total')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              {/* 长表头命中率与平均缩字号保持单行，样式在共用基元 .thSm */}
              <ThSortable k="hitRate" label={t('table.hitRate')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className={shared.thSm} />
              <ThSortable k="calls" label={t('table.calls')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="avg" label={t('table.avgPerCall')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className={shared.thSm} />
              <ThSortable k="lastActive" label={t('table.lastActive')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {pageGroups.map((g) => {
              const isExpanded = expanded.has(g.main.id);
              const hasChildren = g.childCount > 0;
              const when = formatLastActive(g.main.lastActive, tFn);
              const mainTitle = g.main.title || shortId(g.main.id);
              const agg = g.agg.usage;
              const aggHit = hitRateOfDay(agg);
              const aggAvg = avgPerCall(usageTotal(agg), g.agg.calls);
              return (
                <Fragment key={g.main.id}>
                  <tr title={(g.main.cwd ? g.main.cwd + '\n' : '') + (g.main.title ? g.main.title : '')}>
                    <td className={shared.cellText}>
                      {hasChildren ? (
                        <button
                          type="button"
                          className={shared.iconBtn}
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
                      {hasChildren && <span className={shared.countBadge}>{t('sessions.childrenCount', { n: g.childCount } as unknown as Record<string, unknown>)}</span>}
                    </td>
                    <td className={shared.num}>{fmt(agg.cacheRead, tFn)}</td>
                    <td className={shared.num}>{fmt(agg.input, tFn)}</td>
                    <td className={shared.num}>{fmt(agg.output, tFn)}</td>
                    <td className={`${shared.num} ${shared.strong}`}>{fmt(usageTotal(agg), tFn)}</td>
                    <td className={shared.num}>{pctOf(aggHit)}</td>
                    <td className={shared.num}>{fmtFull(g.agg.calls)}</td>
                    <td className={shared.num}>{fmtFull(aggAvg)}</td>
                    <td className={shared.num}>{when}</td>
                  </tr>
                  {isExpanded &&
                    g.children.map((c) => {
                      const childWhen = formatLastActive(c.lastActive, tFn);
                      const childHit = hitRateOfDay(c.usage);
                      const childAvg = avgPerCall(usageTotal(c.usage), c.calls);
                      return (
                        <tr key={c.id} className={shared.childRow} title={`${c.cwd ? `${c.cwd}\n` : ''}${c.title}`}>
                          <td className={`${shared.cellText} ${shared.childCell}`}>
                            <span className={shared.indent} aria-hidden>
                              └
                            </span>
                            {c.title || shortId(c.id)} <span className={shared.sub}>· {shortId(c.id)}</span>
                          </td>
                          <td className={shared.num}>{fmt(c.usage.cacheRead, tFn)}</td>
                          <td className={shared.num}>{fmt(c.usage.input, tFn)}</td>
                          <td className={shared.num}>{fmt(c.usage.output, tFn)}</td>
                          <td className={shared.num}>{fmt(usageTotal(c.usage), tFn)}</td>
                          <td className={shared.num}>{pctOf(childHit)}</td>
                          <td className={shared.num}>{fmtFull(c.calls)}</td>
                          <td className={shared.num}>{fmtFull(childAvg)}</td>
                          <td className={shared.num}>{childWhen}</td>
                        </tr>
                      );
                    })}
                </Fragment>
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
