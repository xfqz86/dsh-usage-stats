/**
 * 模型 Tab：模型/Provider 拆分表 + 顶部饼图与堆叠柱 + 靠右的时间范围筛选（默认 1 年）。
 * 分组与时间范围的选择落偏好设置、下次打开保持。
 * 分组栏在不分组 / 按供应商 / 按同名模型三种模式间切换，默认不分组，分组默认全部展开。
 * 过滤基于模型的按日 series，图表与表格共用同一过滤后切片；表头可排序，分页 20/页。
 *
 * 每行的「明细」打开 ModelDetail（按日期 / 按会话两个子视图，数据按需查
 * usageStats/modelDetail，范围跟随本页 chips；行被过滤掉或模型消失时自动关闭）。
 *
 * models 已按偏好里的重定向规则归并（见 UsageStatsPanel 与 ../stats.ts 的 redirectModels）：
 * mergedSources 给出每个目标行并入的来源，模型列据此显示「已归并 N」；明细按「目标 + 全部来源」
 * 各查一次再合并，数字与这一行对得上。
 */

import { Fragment, useEffect, useMemo, useState } from 'react';

import { splitModelKey } from '../../utils.ts';
import { ModelGroupBar } from '../components/ModelGroupBar.tsx';
import { ModelPieChart } from '../components/ModelPieChart.tsx';
import { Pagination } from '../components/Pagination.tsx';
import { StackedBar } from '../components/StackedBar.tsx';
import { ThSortable } from '../components/ThSortable.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { avgPerCall, compareModelGroup, compareModelRow, fmt, fmtFull, filterModelsByRange, groupModels, hitRateOfDay, modelRangeCutoff, pctOf, usageTotal, withModelShares, type ModelGroupMode, type ModelSortKey, type TimeRange } from '../stats.ts';
import { useCollapsedGroups } from '../useCollapsedGroups.ts';
import { useModelDetail } from '../useModelDetail.ts';
import { stableSort, useSortTable } from '../useSortTable.ts';

import { ModelDetail } from './ModelDetail.tsx';
import css from './ModelsTab.module.css';

import type { LocaleFn, UsageStatsKey } from '../locales.ts';
import type { ModelStat } from '../useSnapshot.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

const PAGE_SIZE = 20;

/** 时间范围选项：值 + 文案键，与 locales 的 modelRange.* 对齐，默认1年。 */
const MODEL_RANGES: [TimeRange, UsageStatsKey][] = [
  ['7d', 'modelRange.7d'],
  ['14d', 'modelRange.14d'],
  ['30d', 'modelRange.30d'],
  ['90d', 'modelRange.90d'],
  ['180d', 'modelRange.180d'],
  ['365d', 'modelRange.365d'],
  ['all', 'modelRange.all'],
];

/** 模型 Tab：图表 + 时间范围筛选，位于图表与表格之间且右对齐，+ 排序 + 分页 + 明细弹窗，容器与会话 Tab 对齐。 */
export function ModelsTab({
  models, mergedSources, groupMode, onGroupModeChange, range, onRangeChange, t,
}: {
  models: ModelStat[]
  /** 归并来源：目标行键（`provider\0model`）→ 并进来的来源键，未配重定向时为空。 */
  mergedSources?: ReadonlyMap<string, string[]>
  /** 模型表分组模式，来自偏好设置，三处模型表共用。 */
  groupMode: ModelGroupMode
  /** 分组模式切换，写回偏好设置。 */
  onGroupModeChange: (m: ModelGroupMode) => void
  /** 时间范围，来自偏好设置，模型页与日期页共用。 */
  range: TimeRange
  /** 时间范围切换，写回偏好设置。 */
  onRangeChange: (r: TimeRange) => void
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 本地化函数单点转换：纯函数要的无命名空间形态，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;

  // 按时间范围过滤：基于 model.series 的按日聚合，host 已下发 daily 细分
  // 过滤后按 total 降序为初序，后续排序在过滤基础上进行
  const filteredModels = useMemo(() => filterModelsByRange(models, range), [models, range]);

  // 占比：基于过滤后总和（stats.withModelShares，最大余数法 1 位小数总和 100%，与饼图同一口径）
  // 需在排序前计算，保证 share 与过滤后顺序一一对应，再按排序键重排时 share 随行
  const withShares = useMemo(() => withModelShares(filteredModels), [filteredModels]);

  // 分组：默认不分组时为空数组；按供应商或同名跨厂商折叠，叶子保持 {m, share} 形态
  const groups = useMemo(
    () => (groupMode === 'none' ? [] : groupModels(withShares, groupMode)),
    [withShares, groupMode],
  );

  // 排序分页三件套（三表同一交互，比较函数保留领域差异；排序不增删行）
  // 分组时行数为组数（子行不占页），与会话 Tab 的分组分页同一口径
  const { sortKey, sortDir, handleSort, page, totalPages, setPage, slice } = useSortTable<ModelSortKey>('total', groupMode === 'none' ? withShares.length : groups.length, PAGE_SIZE);

  // 范围或分组切换时分页回到首位
  useEffect(() => {
    setPage(1);
  }, [range, groupMode, setPage]);

  // 分组折叠态：默认全部展开，key 为组键（供应商名或模型名）
  const { isExpanded, toggle } = useCollapsedGroups(groups.map((g) => g.key));

  // 明细弹窗当前打开的行键（`provider\0model`），null 表示没有打开
  const [detailKey, setDetailKey] = useState<string | null>(null);
  // 弹窗目标行：目标键 + 归并来源（服务端快照不归并，来源在浏览器端各查一次再合并）
  const detail = useMemo(() => {
    if (detailKey === null) return null;
    const { provider, model } = splitModelKey(detailKey);
    const sources = mergedSources?.get(detailKey) ?? [];
    return { provider, model, sources, keys: [detailKey, ...sources] };
  }, [detailKey, mergedSources]);
  // 时间下界与列表同一取值来源（本地日零点），范围切换即重取；'all' 为 null
  const since = useMemo(() => modelRangeCutoff(range), [range]);
  const detailState = useModelDetail(detail?.keys ?? null, since);

  // 打开的行被范围过滤掉或模型消失时关闭弹窗，避免明细挂在不存在的行上
  useEffect(() => {
    if (detailKey === null) return;
    if (!models.some((m) => m.provider + '\u0000' + m.model === detailKey)) setDetailKey(null);
  }, [models, detailKey]);

  // 未分组排序：比较器收拢进 stats，保证与分组叶子同一顺序
  const sortedModels = useMemo(
    () => stableSort(withShares, (a, b) => compareModelRow(sortKey, a, b), sortDir),
    [withShares, sortKey, sortDir],
  );

  // 分组排序：组间按聚合值排，每组叶子用同一键 / 方向排（与未分组同一顺序）
  const sortedGroups = useMemo(
    () => stableSort(groups, (a, b) => compareModelGroup(sortKey, a, b), sortDir).map((g) => ({
      ...g,
      leaves: stableSort(g.leaves, (a, b) => compareModelRow(sortKey, a, b), sortDir),
    })),
    [groups, sortKey, sortDir],
  );

  const pageModels = useMemo(() => slice(sortedModels), [slice, sortedModels]);
  const pageGroups = useMemo(() => slice(sortedGroups), [slice, sortedGroups]);

  // 叶子行：未分组与分组子行共用数值列（同一口径同一 Tooltip）；子行首列只显示
  // 未被分组的那一半（按供应商分组只留模型名，按模型分组只留供应商），组头不开明细
  const renderLeafRow = (leafKey: string, m: ModelStat, share: number, child: boolean) => {
    const total = usageTotal(m.usage);
    const hit = hitRateOfDay(m.usage);
    const avg = avgPerCall(total, m.calls);
    const sources = mergedSources?.get(leafKey) ?? [];
    return (
      <tr key={leafKey} className={child ? shared.childRow : undefined}>
        <td className={child ? `${shared.cellText} ${shared.childCell}` : shared.cellText}>
          {child && (
            <span className={shared.indent} aria-hidden>
              └
            </span>
          )}
          {groupMode === 'model' ? m.provider : m.model}
          {groupMode === 'none' && (
            <span className={shared.sub}>
              ·
              {' '}
              {m.provider}
            </span>
          )}
          {/* 归并来源：目标行显示条数与悬浮明细，未归并的行不出现该标记 */}
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
        {/* 打开这一行的明细弹窗（二级弹窗，Esc 只关它这一层） */}
        <td className={shared.detailCell}>
          <button
            type="button"
            className={shared.detailLink}
            aria-label={t('detail.view')}
            onClick={() => setDetailKey(leafKey)}
          >
            {t('detail.link')}
          </button>
        </td>
      </tr>
    );
  };

  // 完全无数据，历史为空，与过滤后无数据区分：后者提示范围无数据
  if (models.length === 0) {
    return <div className={shared.empty}>{t('state.noUsage')}</div>;
  }

  return (
    <div className={`${shared.section} ${shared.tableViewRoot}`}>
      {filteredModels.length === 0 ? (
        <div className={shared.empty}>{t('state.noUsage')}</div>
      ) : (
        <>
          <div className={css.charts}>
            <div className={shared.chartCard}>
              <ModelPieChart models={filteredModels} t={t} />
            </div>
            <div className={shared.chartCard}>
              <StackedBar mode="model" models={models} range={range} t={t} />
            </div>
          </div>
          <div className={shared.rangeBarBetween}>
            <ModelGroupBar value={groupMode} onChange={onGroupModeChange} t={t} />
            <span className={shared.chips}>
              {MODEL_RANGES.map(([value, labelKey]) => (
                <button
                  key={value}
                  type="button"
                  className={range === value ? `${shared.chip} ${shared.chipOn}` : shared.chip}
                  onClick={() => onRangeChange(value)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </span>
          </div>
          <div className={`${shared.tableWrap} ${shared.firstCol} ${css.tableWrap}`}>
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
                  {/* 明细入口列：不参与排序，表头留空（单元格里的链接自己说明用途） */}
                  <th aria-label={t('detail.view')} />
                </tr>
              </thead>
              <tbody>
                {groupMode === 'none'
                  ? pageModels.map(({ m, share }) => renderLeafRow(m.provider + '\u0000' + m.model, m, share, false))
                  : pageGroups.map((g) => {
                    const expanded = isExpanded(g.key);
                    const groupTotal = usageTotal(g.usage);
                    const groupHit = hitRateOfDay(g.usage);
                    const groupAvg = avgPerCall(groupTotal, g.calls);
                    return (
                      <Fragment key={g.key}>
                        {/* 组头行：聚合值与叶子同一口径，明细列留空（明细只从叶子行打开） */}
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
                              {groupMode === 'provider'
                                ? t('models.providerModelsCount', { n: g.leaves.length })
                                : t('models.modelProvidersCount', { n: g.leaves.length })}
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
                          {/* 组头不开明细：子行展开后从叶子行打开，这里留空保持网格对齐 */}
                          <td className={shared.detailCell} />
                        </tr>
                        {expanded && g.leaves.map((leaf) => renderLeafRow(leaf.m.provider + '\u0000' + leaf.m.model, leaf.m, leaf.share, true))}
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
        </>
      )}
      {/* 明细弹窗：叠在详情面板之上，基座 Modal 的层级栈保证 Esc 只关这一层 */}
      {detail !== null && (
        <ModelDetail
          provider={detail.provider}
          model={detail.model}
          mergedCount={detail.sources.length}
          range={range}
          state={detailState}
          onClose={() => setDetailKey(null)}
          t={t}
        />
      )}
    </div>
  );
}
