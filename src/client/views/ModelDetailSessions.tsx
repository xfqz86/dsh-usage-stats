/**
 * 模型明细弹窗的「按会话」子视图：范围内用过该模型的会话表，表与会话 Tab 完全同款——
 * 列（会话 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 最近活跃）、
 * 子代理折叠到主会话并带 + 展开、默认按「最近活跃」降序、可排序、每页 15 条；
 * 分组与排序比较走 stats.ts 的共用实现（groupSessions / compareSessionGroup）。
 *
 * 明细数据只含用过该模型的会话：父会话若没用过该模型就不在表里，其子会话按
 * groupSessions 的既有规则回落顶层，不会因折叠而把用量藏起来。
 */

import { Fragment, useEffect, useMemo, useState } from 'react';

import { Pagination } from '../components/Pagination.tsx';
import { ThSortable } from '../components/ThSortable.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { avgPerCall, compareSessionGroup, fmt, fmtFull, formatLastActive, groupSessions, hitRateOfDay, pctOf, shortId, usageTotal, type SessionSortKey } from '../stats.ts';
import { stableSort, useSortTable } from '../useSortTable.ts';

import css from './ModelDetail.module.css';

import type { SessionStat } from '../../types.ts';
import type { LocaleFn } from '../locales.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 每页行数：弹窗高度有限，15 行既填满内容区又不出现内层滚动条。 */
const PAGE_SIZE = 15;

/** 模型明细的按会话表。 */
export function ModelDetailSessions({
  sessions, t,
}: {
  sessions: SessionStat[]
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 本地化函数单点转换：纯函数要的无命名空间形态，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;
  // 分组：子代理折叠到根主会话，孤儿回落顶层，多级展平（与会话 Tab 同一实现）
  const groups = useMemo(() => groupSessions(sessions), [sessions]);

  // 排序分页三件套（三表同一交互，比较函数保留领域差异；排序不增删行），默认与会话 Tab 一致
  const { sortKey, sortDir, handleSort, page, totalPages, setPage, slice } = useSortTable<SessionSortKey>('lastActive', groups.length, PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // 排序：分组后、分页前；比较函数与会话 Tab 共用（stats.compareSessionGroup）
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

  return (
    <div className={shared.detailTableBlock}>
      {/* 首列不用共用基元 .firstCol：弹窗比面板窄 100px，会话列吃满会把「最近活跃」
          挤出可视区（面板 960 宽放得下，这里放不下）——保留共用 .cellText 的宽度上限，
          九列一屏看全。列表头、排序、折叠与面板会话 Tab 完全同款。 */}
      <div className={`${shared.tableWrap} ${css.sessionsWrap}`}>
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
