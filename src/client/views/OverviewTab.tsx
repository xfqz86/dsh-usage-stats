/**
 * 概览 Tab，Bento 磁贴网格，包含「今日」与「总计」英雄磁贴，左列上下两格，
 * 右大区为「热力图」占 3 列 2 行，底行含「DeepSeek 余额」、「OpenCode Go 额度」与「Z.ai 额度」，
 * 各卡片受监控开关控制，未启用时隐藏，布局严格按布局图分区，使用 grid-template-areas，独立成文件。
 */

import {
  IconArchiveOutline20,
  IconRefreshOutline16,
  IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives';

import { goLevelOf, goPercent, goResetsAt } from '../../utils.ts';
import shared from '../components/UsageStatsCommon.module.css';
import { dayTotal, fmt, fmtFull, todayOf } from '../stats.ts';

import { HeroTile } from './HeroTile.tsx';
import css from './OverviewTab.module.css';
import { UsageHeatmap } from './UsageHeatmap.tsx';

import type { DeepSeekBalance, DeepSeekBalanceInfo, ZaiQuota } from '../../types.ts';
import type { GoQuota } from '../useGoQuota.ts';
import type { UsageSnapshot } from '../useSnapshot.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** OpenCode Go 额度行定义：键 + 完整文案键。 */
const GO_ROWS = [
  ['rolling', 'go.rolling'],
  ['weekly', 'go.weekly'],
  ['monthly', 'go.monthly'],
] as const;

/** 根据档位返回百分比文本的样式。 */
function goPctClass(level: 'over' | 'warn' | 'ok'): string {
  if (level === 'over') {
    return `${css.goPct} ${css.goPctOver}`;
  }
  if (level === 'warn') {
    return `${css.goPct} ${css.goPctWarn}`;
  }
  return css.goPct;
}

/** 根据档位返回进度条填充的样式。 */
function goBarFillClass(level: 'over' | 'warn' | 'ok'): string {
  if (level === 'over') {
    return `${css.goBarFill} ${css.goFillOver}`;
  }
  if (level === 'warn') {
    return `${css.goBarFill} ${css.goFillWarn}`;
  }
  return css.goBarFill;
}

/** 概览 Tab：Bento 磁贴网格，含今日与总计左列、热力图右大区与底行，底行含 DeepSeek、Go 与 Z.ai，各受监控开关控制。 */
export function OverviewTab({
  value, go, deepseek, zai, t, onRefreshGo, onRefreshDeepSeek, onRefreshZai, goEnabled, deepseekEnabled, zaiEnabled,
}: {
  value: UsageSnapshot
  go: GoQuota | null
  deepseek: DeepSeekBalance | null
  zai: ZaiQuota | null
  t: PropsLocale<'dsh-usage-stats'>['t']
  /** 立即刷新 Go 额度，不受抓取间隔控制。 */
  onRefreshGo: () => void
  /** 立即刷新 DeepSeek 余额，不受抓取间隔控制。 */
  onRefreshDeepSeek: () => void
  /** 立即刷新 Z.ai 额度，不受抓取间隔控制。 */
  onRefreshZai: () => void
  /** 是否启用 OpenCode Go 额度监控，关闭时隐藏 Go 卡片。 */
  goEnabled: boolean
  /** 是否启用 DeepSeek 余额监控，关闭时隐藏 DeepSeek 卡片。 */
  deepseekEnabled: boolean
  /** 是否启用 Z.ai 额度监控，关闭时隐藏 Z.ai 卡片。 */
  zaiEnabled: boolean
}) {
  const all = value?.all ?? {
    calls: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
    },
  };
  const todayPoint = todayOf(value.series.all ?? []);
  // 今日转 UsageAgg 供 HeroTile 复用，与总计同款口径
  const todayUsage = todayPoint
    ? {
      input: todayPoint.input,
      output: todayPoint.output,
      cacheRead: todayPoint.cacheRead,
      cacheWrite: todayPoint.cacheWrite,
      reasoning: todayPoint.reasoning,
      total: dayTotal(todayPoint),
    }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  const todayCalls = todayPoint?.calls ?? 0;
  const totalSide = `${fmtFull(value.sessions)} ${t('panel.summary.sessions')}`;
  const showGo = goEnabled;
  const showDeepSeek = deepseekEnabled;
  const showZai = zaiEnabled;
  const hasBottom = showGo || showDeepSeek || showZai;
  const bentoClass = hasBottom ? css.bento : `${css.bento} ${css.bentoNoBottom}`;

  // DeepSeek 余额内容的条件渲染，避免嵌套三元
  function renderDeepSeekContent() {
    if (deepseek === null) {
      return <span className={shared.goHint}>{t('deepseek.notConfigured')}</span>;
    }
    if (deepseek.status === 'ok') {
      if (!deepseek.isAvailable) {
        return <span className={shared.goHint}>{t('deepseek.notAvailable')}</span>;
      }
      if (deepseek.balances.length === 0) {
        return <span className={shared.goHint}>{t('deepseek.balancesEmpty')}</span>;
      }
      const singleCurrency = deepseek.balances.length === 1;
      return (
        <>
          <div className={css.deepseekRows}>
            {deepseek.balances.map((b: DeepSeekBalanceInfo) => (
              <div className={css.deepseekRow} key={b.currency}>
                <span className={css.deepseekCurrency}>{b.currency}</span>
                <span className={css.deepseekAmount}>{b.totalBalance}</span>
              </div>
            ))}
          </div>
          <div className={css.deepseekDetails}>
            {deepseek.balances.flatMap((b: DeepSeekBalanceInfo) => [
              <div className={css.deepseekDetailRow} key={`${b.currency}-granted`}>
                <span className={css.deepseekDetailLabel} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--dsw-alias-label-tertiary)', opacity: 0.6, display: 'inline-block', flexShrink: 0 }} />
                  {singleCurrency ? t('deepseek.grantedBalance') : `${b.currency} ${t('deepseek.grantedBalance')}`}
                </span>
                <span className={css.deepseekDetailValue}>{b.grantedBalance}</span>
              </div>,
              <div className={css.deepseekDetailRow} key={`${b.currency}-topped`}>
                <span className={css.deepseekDetailLabel} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3fb57a', display: 'inline-block', flexShrink: 0 }} />
                  {singleCurrency ? t('deepseek.toppedUpBalance') : `${b.currency} ${t('deepseek.toppedUpBalance')}`}
                </span>
                <span className={css.deepseekDetailValue}>{b.toppedUpBalance}</span>
              </div>,
            ])}
          </div>
          <div className={css.deepseekFetchedAt}>
            {t('updatedAt')} {new Date(deepseek.fetchedAt).toLocaleTimeString()}
          </div>
        </>
      );
    }
    if (deepseek.status === 'no-key') {
      return <span className={shared.goHint}>{t('deepseek.notConfigured')}</span>;
    }
    return <span className={shared.goHint}>{t('deepseek.unavailable')}</span>;
  }

  // Go 额度内容的条件渲染，避免嵌套三元
  function renderGoContent() {
    if (go === null) {
      return <span className={shared.goHint}>{t('go.notConfigured')}</span>;
    }
    if (go.status === 'ok') {
      return (
        <div className={css.goTileRows}>
          {GO_ROWS.map(([key, labelKey]) => {
            const win = go[key];
            if (win === null) return null;
            const pct = goPercent(win);
            const level = goLevelOf(pct);
            return (
              <div className={css.goTileRow} key={key}>
                <span className={css.goTileTop}>
                  <span className={css.goLabel}>{t(labelKey)}</span>
                  <span className={goPctClass(level)}>{pct}%</span>
                </span>
                <span className={css.goBar}>
                  <span
                    className={goBarFillClass(level)}
                    style={{ width: pct + '%' }}
                  />
                </span>
                <span className={css.goReset}>{goResetsAt(t, win)}</span>
              </div>
            );
          })}
          <div className={css.deepseekFetchedAt}>
            {t('updatedAt')} {new Date(go.fetchedAt).toLocaleTimeString()}
          </div>
        </div>
      );
    }
    if (go.status === 'no-key') {
      return <span className={shared.goHint}>{t('go.notConfigured')}</span>;
    }
    return <span className={shared.goHint}>{t('go.unavailable')}</span>;
  }

  // Z.ai 额度内容的条件渲染，避免嵌套三元
  function renderZaiContent() {
    if (zai === null) {
      return <span className={shared.goHint}>{t('zai.notConfigured')}</span>;
    }
    if (zai.status === 'ok') {
      if (
        zai.session === null
        && zai.weekly === null
        && zai.webSearches === null
      ) {
        return <span className={shared.goHint}>{t('zai.noData')}</span>;
      }
      return (
        <div className={css.goTileRows}>
          {zai.session && (() => {
            const pct = goPercent(zai.session);
            const level = goLevelOf(pct);
            const tFmt = t as unknown as (k: string, p?: Record<string, unknown>) => string;
            return (
              <div className={css.goTileRow} key="session">
                <span className={css.goTileTop}>
                  <span className={css.goLabel}>{t('zai.session')}</span>
                  {zai.session.used !== null && zai.session.limit !== null && (
                    <span className={css.goPoints}>{fmt(zai.session.used, tFmt)} / {fmt(zai.session.limit, tFmt)}</span>
                  )}
                  <span className={goPctClass(level)}>{pct}%</span>
                </span>
                <span className={css.goBar}>
                  <span
                    className={goBarFillClass(level)}
                    style={{ width: pct + '%' }}
                  />
                </span>
                <span className={css.goReset}>{goResetsAt(t, zai.session)}</span>
              </div>
            );
          })()}
          {zai.weekly && (() => {
            const pct = goPercent(zai.weekly);
            const level = goLevelOf(pct);
            const tFmt = t as unknown as (k: string, p?: Record<string, unknown>) => string;
            return (
              <div className={css.goTileRow} key="weekly">
                <span className={css.goTileTop}>
                  <span className={css.goLabel}>{t('zai.weekly')}</span>
                  {zai.weekly.used !== null && zai.weekly.limit !== null && (
                    <span className={css.goPoints}>{fmt(zai.weekly.used, tFmt)} / {fmt(zai.weekly.limit, tFmt)}</span>
                  )}
                  <span className={goPctClass(level)}>{pct}%</span>
                </span>
                <span className={css.goBar}>
                  <span
                    className={goBarFillClass(level)}
                    style={{ width: pct + '%' }}
                  />
                </span>
                <span className={css.goReset}>{goResetsAt(t, zai.weekly)}</span>
              </div>
            );
          })()}
          {zai.webSearches && (() => {
            const pct = Math.round(
              Math.max(0, Math.min(100, zai.webSearches.percent)),
            );
            const level = goLevelOf(pct);
            return (
              <div className={css.goTileRow} key="webSearches">
                <span className={css.goTileTop}>
                  <span className={css.goLabel}>{t('zai.webSearches')}</span>
                  <span className={goPctClass(level)}>
                    {t('zai.webSearchesCount', {
                      used: zai.webSearches.used,
                      limit: zai.webSearches.limit,
                    })}
                  </span>
                </span>
                <span className={css.goBar}>
                  <span
                    className={goBarFillClass(level)}
                    style={{ width: pct + '%' }}
                  />
                </span>
                <span className={css.goReset}>
                  {zai.webSearches.resetsAt
                    ? t('zai.resetsAt', {
                      time: new Date(
                        zai.webSearches.resetsAt,
                      ).toLocaleString(),
                    })
                    : ''}
                </span>
              </div>
            );
          })()}
          <div className={css.deepseekFetchedAt}>
            {t('updatedAt')} {new Date(zai.fetchedAt).toLocaleTimeString()}
          </div>
        </div>
      );
    }
    if (zai.status === 'no-key') {
      return <span className={shared.goHint}>{t('zai.notConfigured')}</span>;
    }
    if (zai.status === 'no-plan') {
      return <span className={shared.goHint}>{t('zai.noPlan')}</span>;
    }
    return <span className={shared.goHint}>{t('zai.unavailable')}</span>;
  }

  return (
    <div className={bentoClass}>
      {/* 左列：今日 */}
      <div className={css.tileToday}>
        <HeroTile
          icon={<IconSparkle16 />}
          label={t('footer.todayLabel')}
          usage={todayUsage}
          calls={todayCalls}
          t={t}
        />
      </div>
      {/* 左列：总计 */}
      <div className={css.tileTotal}>
        <HeroTile
          icon={<IconArchiveOutline20 size={16} />}
          label={t('panel.summary.totalTokens')}
          usage={all.usage}
          calls={all.calls}
          t={t}
          side={totalSide}
        />
      </div>

      {/* 右大区：热力图，占 3 列 2 行 */}
      <div className={`${css.tile} ${css.tileHeatmap}`}>
        <UsageHeatmap series={value.series.all} t={t} />
      </div>

      {/* 底行：DeepSeek 余额、OpenCode Go 额度与 Z.ai 额度，受监控开关控制，自动补位 */}
      {hasBottom && (
        <div className={css.bottomRow}>
          {showDeepSeek && (
            <div className={`${css.tile} ${css.tileDeepSeek}`}>
              <div className={shared.sectionHead}>
                <span className={shared.sectionLabel}>{t('deepseek.title')}</span>
                {deepseek?.status === 'ok' && (
                  <button
                    type="button"
                    className={css.goRefresh}
                    aria-label={t('deepseek.refresh')}
                    title={t('deepseek.refresh')}
                    onClick={onRefreshDeepSeek}
                  >
                    <IconRefreshOutline16 size={12} />
                  </button>
                )}
              </div>
              {renderDeepSeekContent()}
            </div>
          )}

          {showGo && (
            <div className={`${css.tile} ${css.tileGo}`}>
              <div className={shared.sectionHead}>
                <span className={shared.sectionLabel}>{t('go.title')}</span>
                {go?.status === 'ok' && (
                  <button
                    type="button"
                    className={css.goRefresh}
                    aria-label={t('go.refresh')}
                    title={t('go.refresh')}
                    onClick={onRefreshGo}
                  >
                    <IconRefreshOutline16 size={12} />
                  </button>
                )}
              </div>
              {renderGoContent()}
            </div>
          )}

          {showZai && (
            <div className={`${css.tile} ${css.tileGo}`}>
              <div className={shared.sectionHead}>
                <span className={shared.sectionLabel}>{t('zai.title')}</span>
                {zai?.plan && zai.status === 'ok' && (
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--dsw-alias-label-tertiary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: 120,
                    }}
                  >
                    {zai.plan}
                  </span>
                )}
                {zai?.status === 'ok' && (
                  <button
                    type="button"
                    className={css.goRefresh}
                    aria-label={t('zai.refresh')}
                    title={t('zai.refresh')}
                    onClick={onRefreshZai}
                  >
                    <IconRefreshOutline16 size={12} />
                  </button>
                )}
              </div>
              {renderZaiContent()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
