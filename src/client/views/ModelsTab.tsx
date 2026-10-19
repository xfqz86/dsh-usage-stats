/**
 * 模型 Tab：模型/Provider 拆分表 + 顶部饼图与堆叠柱 + 靠右的时间范围筛选（默认 1 年）。
 * 过滤基于模型的按日 series，图表与表格共用同一过滤后切片；表头可排序，分页 20/页。
 *
 * 每行的「明细」打开 ModelDetail（按日期 / 按会话两个子视图，数据按需查
 * usageStats/modelDetail，范围跟随本页 chips；行被过滤掉或模型消失时自动关闭）。
 *
 * models 已按偏好里的重定向规则归并（见 UsageStatsPanel 与 ../stats.ts 的 redirectModels）：
 * mergedSources 给出每个目标行并入的来源，模型列据此显示「已归并 N」；明细按「目标 + 全部来源」
 * 各查一次再合并，数字与这一行对得上。
 */

import { useEffect, useMemo, useState } from 'react';

import { splitModelKey } from '../../utils.ts';
import { ModelPieChart } from '../components/ModelPieChart.tsx';
import { Pagination } from '../components/Pagination.tsx';
import { StackedBar } from '../components/StackedBar.tsx';
import { ThSortable } from '../components/ThSortable.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { avgPerCall, fmt, fmtFull, hitRateOfDay, largestRemainderPcts, modelRangeCutoff, pctOf, usageTotal, filterModelsByRange, type ModelRange } from '../stats.ts';
import { useModelDetail } from '../useModelDetail.ts';
import { stableSort, useSortTable } from '../useSortTable.ts';

import { ModelDetail } from './ModelDetail.tsx';
import css from './ModelsTab.module.css';

import type { LocaleFn, UsageStatsKey } from '../locales.ts';
import type { ModelStat } from '../useSnapshot.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

const PAGE_SIZE = 20;

/** 排序键：与表头一一对应，含模型文本、数值列与占比。 */
type SortKey = 'model' | 'input' | 'output' | 'cacheRead' | 'total' | 'hitRate' | 'calls' | 'avg' | 'share';

/** 时间范围选项：值 + 文案键，与 locales 的 modelRange.* 对齐，默认1年。 */
const MODEL_RANGES: [ModelRange, UsageStatsKey][] = [
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
  models, mergedSources, t,
}: {
  models: ModelStat[]
  /** 归并来源：目标行键（`provider\0model`）→ 并进来的来源键，未配重定向时为空。 */
  mergedSources?: ReadonlyMap<string, string[]>
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 本地化函数单点转换：纯函数要的无命名空间形态，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;
  const [range, setRange] = useState<ModelRange>('365d');

  // 按时间范围过滤：基于 model.series 的按日聚合，host 已下发 daily 细分
  // 过滤后按 total 降序为初序，后续排序在 filtered 基础上进行
  const filteredModels = useMemo(() => filterModelsByRange(models, range), [models, range]);

  // 排序分页三件套（三表同一交互，比较函数保留领域差异；排序不增删行）
  const { sortKey, sortDir, handleSort, page, totalPages, setPage, slice } = useSortTable<SortKey>('total', filteredModels.length, PAGE_SIZE);

  // 范围切换时分页回到首位
  useEffect(() => {
    setPage(1);
  }, [range, setPage]);

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

  // 占比：基于过滤后总和，非最大值，最大余数法保证 1 位小数总和 100%（stats.largestRemainderPcts，与饼图同一口径）
  // 需在排序前计算，保证 share 与过滤后顺序一一对应，再按排序键重排时 share 随行
  const sortedModels = useMemo(() => {
    if (filteredModels.length === 0) return [];
    const sumTotal = filteredModels.reduce((s, m) => s + usageTotal(m.usage), 0);
    const shares = sumTotal > 0
      ? largestRemainderPcts(filteredModels.map((m) => (usageTotal(m.usage) / sumTotal) * 100))
      : filteredModels.map(() => 0);
    const withShares = filteredModels.map((m, i) => ({ m, i, share: shares[i] ?? 0 }));
    return stableSort(withShares, (a, b) => {
      switch (sortKey) {
        case 'model': return `${a.m.model || ''} ${a.m.provider || ''}`.localeCompare(`${b.m.model || ''} ${b.m.provider || ''}`, 'zh-Hans-CN');
        case 'input': return (a.m.usage.input || 0) - (b.m.usage.input || 0);
        case 'output': return (a.m.usage.output || 0) - (b.m.usage.output || 0);
        case 'cacheRead': return (a.m.usage.cacheRead || 0) - (b.m.usage.cacheRead || 0);
        case 'total': return usageTotal(a.m.usage) - usageTotal(b.m.usage);
        case 'hitRate': return (hitRateOfDay(a.m.usage) ?? -1) - (hitRateOfDay(b.m.usage) ?? -1);
        case 'calls': return (a.m.calls || 0) - (b.m.calls || 0);
        case 'avg': return (avgPerCall(usageTotal(a.m.usage), a.m.calls) ?? -1) - (avgPerCall(usageTotal(b.m.usage), b.m.calls) ?? -1);
        case 'share': return (a.share || 0) - (b.share || 0);
        default: return 0;
      }
    }, sortDir);
  }, [filteredModels, sortKey, sortDir]);

  const pageModels = useMemo(() => slice(sortedModels), [slice, sortedModels]);

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
          <div className={shared.rangeBar}>
            <span className={shared.chips}>
              {MODEL_RANGES.map(([value, labelKey]) => (
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
                {pageModels.map(({ m, share }) => {
                  const key = m.provider + '\u0000' + m.model;
                  const total = usageTotal(m.usage);
                  const hit = hitRateOfDay(m.usage);
                  const avg = avgPerCall(total, m.calls);
                  const sources = mergedSources?.get(key) ?? [];
                  return (
                    <tr key={key}>
                      <td className={shared.cellText}>
                        {m.model} <span className={shared.sub}>· {m.provider}</span>
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
                          onClick={() => setDetailKey(key)}
                        >
                          {t('detail.link')}
                        </button>
                      </td>
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
