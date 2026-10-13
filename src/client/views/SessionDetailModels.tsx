/**
 * 会话明细弹窗的「按模型」子视图：该会话集合有用量的模型表，列与模型页对齐——
 * 模型 / Provider | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 占比，
 * 默认按「总计」降序、可排序、每页 15 条；占比以集合这张表的总和为分母，
 * 用 stats.largestRemainderPcts 配分（与模型页同一口径，1 位小数总和恰为 100）。
 * 传进来的行已按偏好里的重定向规则归并且带来源表（与模型页同口径，服务端明细保持原始行、
 * 归并只在浏览器端做），归并目标行因此与模型页一样挂一枚「已归并 N」小标签。
 *
 * 这里不给再次下钻的「明细」入口：会话明细本身就是二级弹窗，
 * 再开一层会叠成三级弹窗，Esc 与遮罩的关闭层级难以预期；要看某个模型的会话，
 * 去模型页打开那一行自己的明细。
 */

import { useMemo } from 'react';

import { splitModelKey } from '../../utils.ts';
import { Pagination } from '../components/Pagination.tsx';
import { ThSortable } from '../components/ThSortable.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { avgPerCall, fmt, fmtFull, hitRateOfDay, largestRemainderPcts, pctOf, usageTotal } from '../stats.ts';
import { stableSort, useSortTable } from '../useSortTable.ts';

import css from './SessionDetail.module.css';

import type { ModelStat } from '../../types.ts';
import type { LocaleFn } from '../locales.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 每页行数：弹窗高度有限，15 行既填满内容区又不出现内层滚动条。 */
const PAGE_SIZE = 15;

/** 排序键：与表头一一对应，含模型文本、数值列与占比。 */
type SortKey = 'model' | 'input' | 'output' | 'cacheRead' | 'total' | 'hitRate' | 'calls' | 'avg' | 'share';

/** 会话明细的按模型表。 */
export function SessionDetailModels({
  models, mergedSources, t,
}: {
  models: ModelStat[]
  /** 目标行键（`provider\0model`）→ 并进来的来源键，未配重定向时为空（模型页同一份）。 */
  mergedSources: ReadonlyMap<string, string[]>
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 本地化函数单点转换：纯函数要的无命名空间形态，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;

  // 占比在排序前算好随行带走（与模型页同一口径）；分母为 0 时整列 0，不产生 NaN
  const withShares = useMemo(() => {
    const sum = models.reduce((s, m) => s + usageTotal(m.usage), 0);
    const shares = sum > 0
      ? largestRemainderPcts(models.map((m) => (usageTotal(m.usage) / sum) * 100))
      : models.map(() => 0);
    return models.map((m, i) => ({ m, share: shares[i] ?? 0 }));
  }, [models]);

  // 排序分页三件套（三表同一交互，比较函数保留领域差异；排序不增删行），默认按总计降序
  const { sortKey, sortDir, handleSort, page, totalPages, setPage, slice } = useSortTable<SortKey>('total', withShares.length, PAGE_SIZE);

  const sortedModels = useMemo(() => stableSort(withShares, (a, b) => {
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
  }, sortDir), [withShares, sortKey, sortDir]);

  const pageModels = useMemo(() => slice(sortedModels), [slice, sortedModels]);

  return (
    <div className={shared.detailTableBlock}>
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
            {pageModels.map(({ m, share }) => {
              const total = usageTotal(m.usage);
              const hit = hitRateOfDay(m.usage);
              const avg = avgPerCall(total, m.calls);
              const key = m.provider + '\u0000' + m.model;
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
