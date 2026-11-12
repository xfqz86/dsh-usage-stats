/**
 * 会话明细弹窗的「按模型」子视图：该会话集合有用量的模型表，列与模型页对齐——
 * 模型 / Provider | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 占比，
 * 分组选择落偏好设置、下次打开保持。
 * 默认按「总计」降序、可排序、每页 15 条；占比以集合这张表的总和为分母，
 * 用 stats.largestRemainderPcts 配分（与模型页同一口径，1 位小数总和恰为 100）。
 * 另支持按供应商 / 模型名分组：同名模型跨厂商合并一行，默认不分组、分组后默认全展开。
 * 传进来的行已按偏好里的重定向规则归并且带来源表（与模型页同口径，服务端明细保持原始行、
 * 归并只在浏览器端做），归并目标行因此与模型页一样挂一枚「已归并 N」小标签。
 *
 * 这里不给再次下钻的「明细」入口：会话明细本身就是二级弹窗，
 * 再开一层会叠成三级弹窗，Esc 与遮罩的关闭层级难以预期；要看某个模型的会话，
 * 去模型页打开那一行自己的明细。
 */

import { Fragment, useEffect, useMemo } from 'react';

import { joinModelKey, splitModelKey } from '../../../utils.ts';
import { ModelGroupBar } from '../../components/ModelGroupBar.tsx';
import { Pagination } from '../../components/Pagination.tsx';
import { ThSortable } from '../../components/ThSortable.tsx';
import { Tooltip } from '../../components/Tooltip.tsx';
import shared from '../../components/UsageStatsCommon.module.css';
import { useCollapsedGroups } from '../../hooks/useCollapsedGroups.ts';
import { stableSort, useSortTable } from '../../hooks/useSortTable.ts';
import {
  avgPerCall,
  compareModelGroup,
  compareModelRow,
  fmt,
  fmtFull,
  groupModels,
  hitRateOfDay,
  pctOf,
  usageTotal,
  withModelShares,
  type ModelGroupMode,
  type ModelSortKey,
} from '../../stats.ts';

import css from './SessionDetail.module.css';

import type { ModelStat } from '../../../types.ts';
import type { LocaleFn } from '../../locales.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 每页行数：弹窗高度有限，15 行既填满内容区又不出现内层滚动条。 */
const PAGE_SIZE = 15;

/** 会话明细的按模型表。 */
export function SessionDetailModels({
  models, mergedSources, groupMode, onGroupModeChange, t,
}: {
  models: ModelStat[]
  /** 目标行键（`provider\0model`）→ 并进来的来源键，未配重定向时为空（模型页同一份）。 */
  mergedSources: ReadonlyMap<string, string[]>
  /** 模型表分组模式，来自偏好设置，三处模型表共用。 */
  groupMode: ModelGroupMode
  /** 分组模式切换，写回偏好设置。 */
  onGroupModeChange: (m: ModelGroupMode) => void
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 本地化函数单点转换：纯函数要的无命名空间形态，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;

  // 占比随行：配分收拢进 stats.withModelShares（与模型页同一口径）；分母为 0 时整列 0
  const withShares = useMemo(() => withModelShares(models), [models]);

  // 分组模式来自偏好设置；provider 按供应商归组，model 按模型名归组（同名跨厂商合并）
  const groups = useMemo(
    () => (groupMode === 'none' ? [] : groupModels(withShares, groupMode)),
    [withShares, groupMode],
  );

  // 排序分页三件套（三表同一交互，比较函数收拢进 stats；排序不增删行），默认按总计降序；
  // 行数按模式取行 / 组数，组内叶子不占页位（与会话 Tab 的子代理同理）
  const { sortKey, sortDir, handleSort, page, totalPages, setPage, slice } = useSortTable<ModelSortKey>(
    'total',
    groupMode === 'none' ? withShares.length : groups.length,
    PAGE_SIZE,
  );

  // 分组切换回到第 1 页（与 ModelsTab 的范围切换同理，避免页码越界留白）
  useEffect(() => {
    setPage(1);
  }, [groupMode, setPage]);

  // 折叠态：默认全展开（明细行数少，一眼看全优于逐个点开）
  const { isExpanded, toggle } = useCollapsedGroups(groups.map((g) => g.key));

  // 不分组排序：比较函数收拢进 stats（与模型页同一列同一比较，分页前执行）
  const sortedModels = useMemo(() => stableSort(withShares, (a, b) => compareModelRow(sortKey, a, b), sortDir), [withShares, sortKey, sortDir]);

  // 分组排序：先排组、组内叶子同键同向再排，分页前执行
  const sortedGroups = useMemo(
    () => stableSort(groups, (a, b) => compareModelGroup(sortKey, a, b), sortDir).map((g) => ({
      ...g,
      leaves: stableSort(g.leaves, (x, y) => compareModelRow(sortKey, x, y), sortDir),
    })),
    [groups, sortKey, sortDir],
  );

  const pageModels = useMemo(() => slice(sortedModels), [slice, sortedModels]);
  const pageGroups = useMemo(() => slice(sortedGroups), [slice, sortedGroups]);

  return (
    <div className={shared.detailTableBlock}>
      {/* 分组条置顶：与范围筛选条同款基元，明细表内左对齐 */}
      <div className={shared.rangeBarStart}>
        <ModelGroupBar value={groupMode} onChange={onGroupModeChange} t={t} />
      </div>
      {/* 首列吃满剩余宽度（与模型页同款）：模型名带 Provider，比数值列更需要横向空间 */}
      <div className={`${shared.tableWrap} ${shared.firstCol} ${css.modelsWrap}`}>
        <table className={shared.table}>
          <thead>
            <tr>
              <ThSortable k="model" label={t('table.model')} align="left" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="cacheRead" label={t('table.cacheRead')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="input" label={t('table.input')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="output" label={t('table.output')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="total" label={t('table.total')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="hitRate" label={t('table.hitRate')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="calls" label={t('table.calls')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="avg" label={t('table.avgPerCall')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <ThSortable k="share" label={t('table.share')} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {groupMode === 'none' ? (
              pageModels.map(({ m, share }) => {
                const total = usageTotal(m.usage);
                const hit = hitRateOfDay(m.usage);
                const avg = avgPerCall(total, m.calls);
                const key = joinModelKey(m.provider, m.model);
                const sources = mergedSources.get(key) ?? [];
                return (
                  <tr key={key}>
                    <td className={shared.cellText}>
                      {m.model} <span className={shared.sub}>· {m.provider}</span>
                      {/* 归并来源：与模型页行上那枚标记同款，未归并的行不出现 */}
                      {sources.length > 0 && (
                        <Tooltip
                          side="top"
                          delayMs={150}
                          content={(
                            <div className={shared.tipPanel}>
                              <div className={shared.tipHeader}>{t('models.mergedSourcesHint')}</div>
                              <div className={shared.tipList}>
                                {sources.map((sourceKey) => {
                                  const src = splitModelKey(sourceKey);
                                  return (
                                    <div key={sourceKey} className={shared.tipListRow}>
                                      <span className={shared.tipListKey}>{src.model}</span>
                                      <span className={shared.tipListVal}>{src.provider}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        >
                          <span className={`${shared.sub} ${shared.mergedChip}`}>
                            {t('models.mergedSources', { n: sources.length })}
                          </span>
                        </Tooltip>
                      )}
                    </td>
                    <td className={shared.num}>{fmt(m.usage.cacheRead, tFn)}</td>
                    <td className={shared.num}>{fmt(m.usage.input, tFn)}</td>
                    <td className={shared.num}>{fmt(m.usage.output, tFn)}</td>
                    <td className={`${shared.num} ${shared.strong}`}>{fmt(total, tFn)}</td>
                    <td className={shared.num}>{pctOf(hit)}</td>
                    <td className={shared.num}>{fmtFull(m.calls)}</td>
                    <td className={shared.num}>{fmtFull(avg)}</td>
                    <td className={shared.num}>{pctOf(share)}</td>
                  </tr>
                );
              })
            ) : (
              pageGroups.map((g) => {
                const expanded = isExpanded(g.key);
                const groupTotal = usageTotal(g.usage);
                const groupHit = hitRateOfDay(g.usage);
                const groupAvg = avgPerCall(groupTotal, g.calls);
                return (
                  <Fragment key={g.key}>
                    {/* 组头行：聚合值；无明细列（本表本就没有） */}
                    <tr>
                      <td className={shared.cellText}>
                        <button
                          type="button"
                          className={shared.iconBtn}
                          aria-expanded={expanded}
                          onClick={() => toggle(g.key)}
                        >
                          {expanded ? '−' : '+'}
                        </button>
                        <span>{g.label}</span>
                        <span className={shared.countBadge}>
                          {t(groupMode === 'provider' ? 'models.providerModelsCount' : 'models.modelProvidersCount', { n: g.leaves.length })}
                        </span>
                      </td>
                      <td className={shared.num}>{fmt(g.usage.cacheRead, tFn)}</td>
                      <td className={shared.num}>{fmt(g.usage.input, tFn)}</td>
                      <td className={shared.num}>{fmt(g.usage.output, tFn)}</td>
                      <td className={`${shared.num} ${shared.strong}`}>{fmt(groupTotal, tFn)}</td>
                      <td className={shared.num}>{pctOf(groupHit)}</td>
                      <td className={shared.num}>{fmtFull(g.calls)}</td>
                      <td className={shared.num}>{fmtFull(groupAvg)}</td>
                      <td className={shared.num}>{pctOf(g.share)}</td>
                    </tr>
                    {expanded && g.leaves.map(({ m, share }) => {
                      const total = usageTotal(m.usage);
                      const hit = hitRateOfDay(m.usage);
                      const avg = avgPerCall(total, m.calls);
                      const key = joinModelKey(m.provider, m.model);
                      const sources = mergedSources.get(key) ?? [];
                      return (
                        <tr key={key} className={shared.childRow}>
                          {/* 子行只显单名：provider 分组下是模型名，model 分组下是供应商 */}
                          <td className={`${shared.cellText} ${shared.childCell}`}>
                            <span className={shared.indent} aria-hidden>
                              └
                            </span>
                            {groupMode === 'provider' ? m.model : m.provider}
                            {/* 归并来源：按叶子键原样保留，与不分组行同款 */}
                            {sources.length > 0 && (
                              <Tooltip
                                side="top"
                                delayMs={150}
                                content={(
                                  <div className={shared.tipPanel}>
                                    <div className={shared.tipHeader}>{t('models.mergedSourcesHint')}</div>
                                    <div className={shared.tipList}>
                                      {sources.map((sourceKey) => {
                                        const src = splitModelKey(sourceKey);
                                        return (
                                          <div key={sourceKey} className={shared.tipListRow}>
                                            <span className={shared.tipListKey}>{src.model}</span>
                                            <span className={shared.tipListVal}>{src.provider}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                              >
                                <span className={`${shared.sub} ${shared.mergedChip}`}>
                                  {t('models.mergedSources', { n: sources.length })}
                                </span>
                              </Tooltip>
                            )}
                          </td>
                          <td className={shared.num}>{fmt(m.usage.cacheRead, tFn)}</td>
                          <td className={shared.num}>{fmt(m.usage.input, tFn)}</td>
                          <td className={shared.num}>{fmt(m.usage.output, tFn)}</td>
                          <td className={`${shared.num} ${shared.strong}`}>{fmt(total, tFn)}</td>
                          <td className={shared.num}>{pctOf(hit)}</td>
                          <td className={shared.num}>{fmtFull(m.calls)}</td>
                          <td className={shared.num}>{fmtFull(avg)}</td>
                          <td className={shared.num}>{pctOf(share)}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })
            )}
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
