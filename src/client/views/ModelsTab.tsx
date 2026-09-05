/**
 * 模型 Tab：按模型/Provider 拆分表，含占比条，布局与会话 Tab 对齐。
 * 顶部为图表区，含饼图与堆叠柱，中间为靠右的时间范围筛选，位于图表与表格之间，默认1年；
 * 表格列：模型 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 占比。
 * 过滤逻辑基于模型的按日细分 series，与饼图/堆叠柱共用同一过滤后切片。
 * 表头可排序，与 SessionsTab 同款交互，分页 20/页、容器与会话 Tab 对齐。
 */

import { useEffect, useMemo, useState } from 'react';

import { ModelPieChart } from '../components/ModelPieChart.tsx';
import { Pagination } from '../components/Pagination.tsx';
import { StackedBar } from '../components/StackedBar.tsx';
import { ThSortable } from '../components/ThSortable.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { avgPerCall, fmt, fmtFull, hitRateOfDay, pctOf, usageTotal, filterModelsByRange, type ModelRange } from '../stats.ts';
import { stableSort, useSortTable } from '../useSortTable.ts';

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

/** 模型 Tab：图表 + 时间范围筛选，位于图表与表格之间且右对齐，+ 排序 + 分页，容器与会话 Tab 对齐。 */
export function ModelsTab({
  models, t,
}: {
  models: ModelStat[]
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

  // 占比：基于过滤后总和，非最大值，最大余数法保证 1 位小数总和 100%
  // 需在排序前计算，保证 share 与过滤后顺序一一对应，再按排序键重排时 share 随行
  const sortedModels = useMemo(() => {
    if (filteredModels.length === 0) return [];
    const sumTotal = filteredModels.reduce((s, m) => s + usageTotal(m.usage), 0);
    let shares: number[] = [];
    if (sumTotal > 0) {
      const raws = filteredModels.map((m) => (usageTotal(m.usage) / sumTotal) * 100);
      const floors = raws.map((v) => Math.floor(v * 10) / 10);
      const sumFloorsTenths = floors.reduce((a, b) => a + Math.round(b * 10), 0);
      const remainingTenths = 1000 - sumFloorsTenths;
      const order = raws
        .map((v, i) => ({ i, frac: v * 10 - Math.floor(v * 10) }))
        .sort((a, b) => b.frac - a.frac);
      const result = [...floors];
      for (let k = 0; k < remainingTenths && k < order.length; k += 1) {
        const idx = order[k].i;
        result[idx] = Math.round((result[idx] + 0.1) * 10) / 10;
      }
      shares = result;
    } else {
      shares = filteredModels.map(() => 0);
    }
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
          <div className={`${shared.tableWrap} ${css.tableWrap}`}>
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
                {pageModels.map(({ m, share }) => {
                  const total = usageTotal(m.usage);
                  const hit = hitRateOfDay(m.usage);
                  const avg = avgPerCall(total, m.calls);
                  return (
                    <tr key={m.provider + '\u0000' + m.model}>
                      <td className={shared.cellText}>
                        {m.model} <span className={shared.sub}>· {m.provider}</span>
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
    </div>
  );
}
