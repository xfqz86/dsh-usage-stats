/**
 * 模型 Tab：按模型/Provider 拆分表，含占比条，布局与会话 Tab 对齐。
 * 顶部为图表区，含饼图与堆叠柱，中间为靠右的时间范围筛选，位于图表与表格之间，默认全部；
 * 表格列：模型 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 占比。
 * 过滤逻辑基于模型的按日细分 series，与饼图/堆叠柱共用同一过滤后切片。
 * 表头可排序，与 SessionsTab 同款交互，分页 20/页、容器与会话 Tab 对齐。
 */

import { useEffect, useMemo, useState } from 'react';

import { ModelPieChart } from '../components/ModelPieChart.tsx';
import { Pagination } from '../components/Pagination.tsx';
import { StackedBar } from '../components/StackedBar.tsx';
import { ThSortable, type SortDir } from '../components/ThSortable.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { fmt, fmtFull, pctOf, usageTotal, filterModelsByRange, type ModelRange } from '../stats.ts';

import css from './ModelsTab.module.css';

import type { ModelStat } from '../useSnapshot.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

const PAGE_SIZE = 20;

/** 缓存命中率：cacheRead / (cacheRead + input) *100，1 位小数；分母 0 时为 null。 */
function hitRateOfModel(usage: { input?: number; cacheRead?: number }): number | null {
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const denom = input + cacheRead;
  if (denom <= 0) return null;
  return Math.round((cacheRead / denom) * 1000) / 10;
}

/** 平均每次调用：total / calls 取整；calls 为 0 时为 null。 */
function avgOfModel(total: number, calls: number): number | null {
  if (!calls || calls <= 0) return null;
  return Math.round(total / calls);
}

/** 排序键：与表头一一对应，含模型文本、数值列与占比。 */
type SortKey = 'model' | 'input' | 'output' | 'cacheRead' | 'total' | 'hitRate' | 'calls' | 'avg' | 'share';

/** 时间范围选项：值 + 文案键，与 locales 的 modelRange.* 对齐，默认全部。 */
const MODEL_RANGES: [ModelRange, string][] = [
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
  const [range, setRange] = useState<ModelRange>('all');
  const [sortKey, setSortKey] = useState<SortKey>('total');
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

  // 按时间范围过滤：基于 model.series 的按日聚合，host 已下发 daily 细分
  // 过滤后按 total 降序为初序，后续排序在 filtered 基础上进行
  const filteredModels = useMemo(() => filterModelsByRange(models, range), [models, range]);

  // 范围切换时分页回到首位
  useEffect(() => {
    setPage(1);
  }, [range]);

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
    const withIdx = filteredModels.map((m, i) => ({ m, i, share: shares[i] ?? 0 }));
    withIdx.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'model': {
          const av = (a.m.model || '') + ' ' + (a.m.provider || '');
          const bv = (b.m.model || '') + ' ' + (b.m.provider || '');
          cmp = av.localeCompare(bv, 'zh-Hans-CN');
          break;
        }
        case 'input':
          cmp = (a.m.usage.input || 0) - (b.m.usage.input || 0);
          break;
        case 'output':
          cmp = (a.m.usage.output || 0) - (b.m.usage.output || 0);
          break;
        case 'cacheRead':
          cmp = (a.m.usage.cacheRead || 0) - (b.m.usage.cacheRead || 0);
          break;
        case 'total':
          cmp = usageTotal(a.m.usage) - usageTotal(b.m.usage);
          break;
        case 'hitRate': {
          const ah = hitRateOfModel(a.m.usage);
          const bh = hitRateOfModel(b.m.usage);
          const av = ah ?? -1;
          const bv = bh ?? -1;
          cmp = av - bv;
          break;
        }
        case 'calls':
          cmp = (a.m.calls || 0) - (b.m.calls || 0);
          break;
        case 'avg': {
          const av = avgOfModel(usageTotal(a.m.usage), a.m.calls);
          const bv = avgOfModel(usageTotal(b.m.usage), b.m.calls);
          const avv = av ?? -1;
          const bvv = bv ?? -1;
          cmp = avv - bvv;
          break;
        }
        case 'share':
          cmp = (a.share || 0) - (b.share || 0);
          break;
        default:
          cmp = 0;
      }
      if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp;
      return a.i - b.i;
    });
    return withIdx;
  }, [filteredModels, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedModels.length / PAGE_SIZE));

  useEffect(() => {
    setPage((p) => Math.min(Math.max(1, p), totalPages));
  }, [totalPages]);

  const pageModels = useMemo(
    () => sortedModels.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sortedModels, page],
  );

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
                  {t(labelKey as never)}
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
                  const hit = hitRateOfModel(m.usage);
                  const avg = avgOfModel(total, m.calls);
                  return (
                    <tr key={m.provider + '\u0000' + m.model}>
                      <td className={shared.cellText}>
                        {m.model} <span className={shared.sub}>· {m.provider}</span>
                      </td>
                      <td className={shared.num}>{fmt(m.usage.cacheRead, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                      <td className={shared.num}>{fmt(m.usage.input, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                      <td className={shared.num}>{fmt(m.usage.output, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                      <td className={`${shared.num} ${shared.strong}`}>{fmt(total, t as unknown as (k: string, p?: Record<string, unknown>) => string)}</td>
                      <td className={shared.num}>{hit == null ? '--' : pctOf(hit)}</td>
                      <td className={shared.num}>{fmtFull(m.calls)}</td>
                      <td className={shared.num}>{avg == null ? '--' : fmtFull(avg)}</td>
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
