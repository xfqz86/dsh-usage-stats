/**
 * 用量统计的侧边栏底部动作：渲染在 `sidebar.footer.action` 列表插槽设置按钮上方的今日统计触发器。
 *
 * 合一按钮，宽列与折叠 rail 共用，侧边栏排序自上而下为 Z.ai 额度、Go 额度、DeepSeek 余额、今日用量，
 * 全部在同一按钮内，任意位置点击均打开模态窗详情 {@link UsageStatsPanel}。
 *
 * 宽列：按钮内纵向多行——
 *   1) 带"Z.ai 额度"标签的 Z.ai 额度芯片，含滚动 5 小时、本周百分比与 Web 搜索次数，悬浮显示卡片化额度明细，
 *   2) 带"Go 额度"标签的 OpenCode Go 订阅额度芯片，含滚动 5 小时、本周与本月用量百分比，≥80% 预警、≥100% 超支，悬浮显示三档窗口卡片明细，
 *   3) 带"DeepSeek余额"标签的 DeepSeek 余额芯片，含多币种 totalBalance，悬浮显示余额卡片明细，
 *   4) 图标 + "今日" + 今日 tokens / 调用次数 + 三色比例条，含缓存、输入与输出，悬浮显示各类别具体数值。
 * 56px rail 即折叠列：按钮内纵向堆叠，与宽列同序——Z.ai 迷你芯片、Go 迷你芯片，两行含短标签与百分比，
 *   DeepSeek 迷你芯片，两行含货币与金额缩写，今日用量迷你芯片，两行含今日与 tokens 缩写数值，
 *   tooltip 给出今日完整明细。整块按钮任意位置可点。
 *
 * Go 额度、DeepSeek 余额与 Z.ai 额度的抓取开关、侧边栏展示开关与抓取间隔来自偏好设置 useUsageSettings（服务端设置文档，见 client/settings.ts）：
 * 关闭抓取则不轮询，对应数据恒为 null，芯片自然不渲染；侧边栏开关只影响底部芯片展示，不影响模态窗内详情。
 */

import { IconDataOutline16, Tooltip as BaseTooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useRef, useState } from 'react';


import { cacheTotal, goLevelOf, goPercent, goResetsAt } from '../../utils.ts';
import { Tooltip } from '../components/Tooltip.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { ZaiNoPlan } from '../components/ZaiNoPlan.tsx';
import { dayTotal, fmt, fmtFull, pctOf, todayOf } from '../stats.ts';
import { useDeepSeekBalance, useGoQuota, useZaiQuota, type GoWindow, type ZaiWindow } from '../useQuota.ts';
import { useSnapshot } from '../useSnapshot.ts';
import { useUsageSettings } from '../useUsageSettings.ts';

import css from './UsageStatsFooter.module.css';
import { UsageStatsPanel } from './UsageStatsPanel.tsx';

import type { LocaleFn } from '../locales.ts';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

export type UsageStatsFooterProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'dsh-usage-stats'>;

/** 单个额度窗口的展示条目，含短名、全名与窗口数据。 */
interface GoWindowEntry {
  key: string
  short: string
  full: string
  win: GoWindow
}

/** Z.ai 窗口展示条目：win 为 ZaiWindow，比 GoWindow 多点数明细 used/limit。 */
interface ZaiWindowEntry {
  key: string
  short: string
  full: string
  win: ZaiWindow
}

// ---- 额度 tooltip 卡片共用样式与渲染助手，Go、Z.ai 与 DeepSeek 三处共用同一设计语言 ----
/** 额度档位 → 进度条 / 百分比颜色，与概览磁贴 goFill* 同 token，fallback 与芯片预警色一致。 */
const TIP_LEVEL_COLOR: Record<'ok' | 'warn' | 'over', string> = {
  ok: 'var(--dsw-alias-state-success-primary, #34c759)',
  warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',
  over: 'var(--dsw-alias-state-error-primary, #e5484d)',
};

/** tooltip 标题行，13px 字号、700 字重，底部留白与卡片群分隔。 */
function TipTitle({ children }: { children: React.ReactNode }) {
  return <div className={shared.tipTitle}>{children}</div>;
}

/** 小徽标 pill，展示货币代码或订阅计划名；超长计划名由调用方给 maxWidth 收窄。 */
function TipPill({ children, maxWidth }: { children: React.ReactNode; maxWidth?: number }) {
  return (
    <span className={shared.tipPill} style={maxWidth === undefined ? undefined : { maxWidth }}>
      {children}
    </span>
  );
}

/** 状态提示卡，用于 no-key、no-plan、error 与空数据等非正常态。 */
function TipHint({ children }: { children: React.ReactNode }) {
  return <div className={shared.tipHint}>{children}</div>;
}

/** tooltip 底部更新时间，右对齐、顶部带分割线，弱化但仍可读。 */
function TipFooter({ children }: { children: React.ReactNode }) {
  return <div className={shared.tipFooter}>{children}</div>;
}

/**
 * 单个额度窗口卡片：窗口名 + 按档位着色的大字号数值 + 进度条 + 重置时间。
 * `value` 缺省渲染 `{pct}%`；次数型额度如 Z.ai Web 搜索传 `used/limit` 文本，
 * 进度条仍按 pct 填充。`points` 为可选的点数明细，如 Z.ai 的 currentValue/usage
 * 缩写值，渲染在百分比左侧。
 */
function QuotaTipRow({ label, pct, level, reset, value, points }: {
  label: string
  pct: number
  level: 'ok' | 'warn' | 'over'
  reset: string
  value?: string
  points?: string
}) {
  const color = TIP_LEVEL_COLOR[level];
  const width = `${Math.max(0, Math.min(100, pct))}%`;
  return (
    <div className={shared.tipCard}>
      <div className={shared.tipCardHead}>
        <span className={shared.tipRowLabel}>{label}</span>
        <span className={shared.tipRowValues}>
          {points !== undefined && (
            <span className={shared.tipPoints}>{points}</span>
          )}
          <span className={shared.tipValue} style={{ color }}>
            {value ?? `${pct}%`}
          </span>
        </span>
      </div>
      <div className={shared.tipBarTrack}>
        <div className={shared.tipBarFill} style={{ width, background: color }} />
      </div>
      {reset !== '' && (
        <div className={shared.tipReset}>{reset}</div>
      )}
    </div>
  );
}

/** 余额明细行，圆点 + 标签居左、数值居右，DeepSeek 赠送与充值两行共用。 */
function BalanceTipRow({ dot, label, amount }: { dot: string; label: string; amount: string }) {
  return (
    <div className={shared.balanceRow}>
      <span className={shared.balanceLabel}>
        <span className={shared.balanceDot} style={{ background: dot }} />
        {label}
      </span>
      <span className={shared.balanceAmount}>{amount}</span>
    </div>
  );
}

export function UsageStatsFooter({ wide, t }: UsageStatsFooterProps) {
  // 本地化函数单点转换，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;
  const [open, setOpen] = useState(false);
  const [data, err, refreshSnapshot, errDetail] = useSnapshot();
  // Go 额度、DeepSeek 余额与 Z.ai 额度抓取开关与间隔来自偏好设置，默认开启、间隔 5 分钟
  const [settings, updateSettings] = useUsageSettings();
  const [go, refreshQuota] = useGoQuota(settings.goEnabled, settings.goFetchMinutes);
  const [deepseek, refreshDeepSeek] = useDeepSeekBalance(settings.deepseekEnabled, settings.deepseekFetchMinutes);
  const [zai, refreshZai] = useZaiQuota(settings.zaiEnabled, settings.zaiFetchMinutes);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    const footerActionsDiv = root?.parentElement?.parentElement as HTMLElement | null;
    if (!footerActionsDiv) {
      console.warn('[usage-stats] 未找到 footerActions 容器，flex 布局调整跳过（harness DOM 可能已变更）');
      return;
    }
    const prev = footerActionsDiv.style.flexDirection;
    footerActionsDiv.style.flexDirection = 'column';
    return () => {
      footerActionsDiv.style.flexDirection = prev;
    };
  }, []);

  const today = todayOf(data?.series.all ?? []);
  const todayTokens = today ? dayTotal(today) : 0;
  const todayCalls = today?.calls ?? 0;
  const missing = (data?.failed ?? 0) > 0;

  // 今日各分类 token 数，缓存为 cacheRead + cacheWrite，共用 utils.cacheTotal
  const cacheTokens = cacheTotal(today ?? {});
  const inputTokens = today?.input ?? 0;
  const outputTokens = today?.output ?? 0;
  // 缓存命中率，cacheRead 除以 cacheRead 与 input 之和
  const cacheRead = today?.cacheRead ?? 0;
  const cacheHitRate = (cacheRead + inputTokens) > 0
    ? Math.round((cacheRead / (cacheRead + inputTokens)) * 1000) / 10
    : null;

  // ---- OpenCode Go 额度，三档窗口为滚动 5 小时、本周与本月 ----
  const goWindows: GoWindowEntry[] =
    go?.status === 'ok'
      ? [
        { key: 'rolling', short: t('go.short.rolling'), full: t('go.rolling'), win: go.rolling },
        { key: 'weekly', short: t('go.short.weekly'), full: t('go.weekly'), win: go.weekly },
        { key: 'monthly', short: t('go.short.monthly'), full: t('go.monthly'), win: go.monthly },
      ].filter((w): w is GoWindowEntry => w.win !== null)
      : [];
  const resetsOf = (win: GoWindow): string => goResetsAt(t, win);

  // 额度芯片档位样式，避免嵌套三元
  const getChipClass = (level: 'over' | 'warn' | 'ok'): string => {
    if (level === 'over') return css.goChipOver;
    if (level === 'warn') return css.goChipWarn;
    return '';
  };

  // 单个额度芯片，宽列 chips，短标签 + 百分比，按档位着色；
  // 悬浮显示完整三档窗口卡片明细，与 rail 共用同一份 goTipContent。
  const goChip = ({ key, short, win }: GoWindowEntry) => {
    const pct = goPercent(win);
    const level = goLevelOf(pct);
    const cls = getChipClass(level);
    return (
      <Tooltip key={key} content={goTipContent} side="top" delayMs={400}>
        <span className={`${css.goChip} ${cls}`}>{short} {pct}%</span>
      </Tooltip>
    );
  };

  // ---- DeepSeek 余额，多币种余额明细，仅含余额、无今日用量 ----
  // 卡片式布局，标题 + 货币卡片含徽标与大字号总额 + 赠送与充值两行细分含圆点标识与分割线 + 底部更新时间。
  const deepseekWideTooltip = (() => {
    if (deepseek?.status !== 'ok') return null;
    const balances = deepseek.balances;
    if (!deepseek.isAvailable) {
      return (
        <div className={shared.tipPanel}>
          <TipTitle>{t('deepseek.title')}</TipTitle>
          <TipHint>{t('deepseek.notAvailable')}</TipHint>
        </div>
      );
    }
    if (balances.length === 0) {
      return (
        <div className={shared.tipPanel}>
          <TipTitle>{t('deepseek.title')}</TipTitle>
          <TipHint>{t('deepseek.balancesEmpty')}</TipHint>
        </div>
      );
    }
    return (
      <div className={shared.tipPanelWide}>
        <TipTitle>{t('deepseek.title')}</TipTitle>
        <div className={shared.tipStack}>
          {balances.map((b) => (
            <div key={b.currency} className={shared.tipCard}>
              <div className={`${shared.tipCardHead} ${shared.tipCardHeadTight}`}>
                <TipPill>{b.currency}</TipPill>
                <span className={`${shared.tipAmount} ${shared.tipAmountLg}`}>
                  {b.totalBalance}
                </span>
              </div>
              <div className={shared.tipDivider} />
              <div className={shared.tipRows}>
                <BalanceTipRow dot="rgba(255,255,255,0.45)" label={t('deepseek.grantedBalance')} amount={b.grantedBalance} />
                <BalanceTipRow dot="#3fb57a" label={t('deepseek.toppedUpBalance')} amount={b.toppedUpBalance} />
              </div>
            </div>
          ))}
        </div>
        <TipFooter>
          {t('updatedAt')} {new Date(deepseek.fetchedAt).toLocaleTimeString()}
        </TipFooter>
      </div>
    );
  })();

  // 折叠 rail tooltip 为用量图标，顺序与热力图一致，含缓存、输入、输出、总计、缓存命中率、调用次数与平均每次调用，
  // 不含 Go 额度，Go 明细由上方额度芯片的 tooltip 承载，日期左对齐、其他标签居左、数值居右。
  const railContent = (() => {
    if (!today || todayTokens === 0) return t('footer.railEmpty');
    const avgPerCall = todayCalls > 0 ? Math.round(todayTokens / todayCalls) : 0;
    const rows: [string, string][] = [
      [t('table.cacheRead'), fmtFull(cacheTokens)],
      [t('table.input'), fmtFull(inputTokens)],
      [t('table.output'), fmtFull(outputTokens)],
      [t('table.total'), fmtFull(todayTokens)],
      [t('footer.cacheHitRate'), pctOf(cacheHitRate)],
      [t('table.calls'), fmtFull(todayCalls)],
      [t('table.avgPerCall'), fmtFull(avgPerCall)],
    ];
    return (
      <div className={shared.tipPanel}>
        <div className={shared.tipHeader}>{t('footer.railHeader')}</div>
        <div className={shared.tipList}>
          {rows.map(([k, v]) => (
            <div key={k} className={shared.tipListRow}>
              <span className={shared.tipListKey}>{k}</span>
              <span className={shared.tipListVal}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    );
  })();

  // 折叠态芯片，只展示滚动 5 小时窗口，位于圆形按钮上方。
  const railRolling = goWindows.find((w) => w.key === 'rolling');

  // Go 额度 tooltip，宽列芯片与折叠 rail 共用，卡片化三档窗口明细，
  // 每档一张窗口卡含窗口名、档位着色百分比、进度条与重置时间，异常态为提示卡。
  const goTipContent = (() => {
    if (go === null) return '';
    const wrap = (hint: string) => (
      <div className={shared.tipPanelGo}>
        <TipTitle>{t('go.title')}</TipTitle>
        <TipHint>{hint}</TipHint>
      </div>
    );
    if (go.status === 'ok') {
      if (goWindows.length === 0) return '';
      return (
        <div className={shared.tipPanelGo}>
          <TipTitle>{t('go.title')}</TipTitle>
          <div className={shared.tipStack}>
            {goWindows.map((w) => {
              const pct = goPercent(w.win);
              return (
                <QuotaTipRow
                  key={w.key}
                  label={w.full}
                  pct={pct}
                  level={goLevelOf(pct)}
                  reset={resetsOf(w.win)}
                />
              );
            })}
          </div>
          <TipFooter>
            {t('updatedAt')} {new Date(go.fetchedAt).toLocaleTimeString()}
          </TipFooter>
        </div>
      );
    }
    if (go.status === 'no-key') return wrap(t('go.notConfigured'));
    return wrap(t('go.unavailable'));
  })();

  // 折叠态 DeepSeek 芯片 tooltip，与宽列同款卡片设计，共用助手，rail 下宽度略收。
  const railDeepSeekContent = (() => {
    if (deepseek?.status !== 'ok') return '';
    const balances = deepseek.balances;
    if (!deepseek.isAvailable) {
      return (
        <div className={shared.tipPanel}>
          <TipTitle>{t('deepseek.title')}</TipTitle>
          <TipHint>{t('deepseek.notAvailable')}</TipHint>
        </div>
      );
    }
    if (balances.length === 0) {
      return (
        <div className={shared.tipPanel}>
          <TipTitle>{t('deepseek.title')}</TipTitle>
          <TipHint>{t('deepseek.balancesEmpty')}</TipHint>
        </div>
      );
    }
    return (
      <div className={shared.tipPanelRail}>
        <TipTitle>{t('deepseek.title')}</TipTitle>
        <div className={shared.tipStack}>
          {balances.map((b) => (
            <div key={b.currency} className={shared.tipCard}>
              <div className={shared.tipCardHead}>
                <TipPill>{b.currency}</TipPill>
                <span className={shared.tipAmount}>{b.totalBalance}</span>
              </div>
              <div className={shared.tipDivider} />
              <div className={shared.tipRows}>
                <BalanceTipRow dot="rgba(255,255,255,0.45)" label={t('deepseek.grantedBalance')} amount={b.grantedBalance} />
                <BalanceTipRow dot="#3fb57a" label={t('deepseek.toppedUpBalance')} amount={b.toppedUpBalance} />
              </div>
            </div>
          ))}
        </div>
        <TipFooter>
          {t('updatedAt')} {new Date(deepseek.fetchedAt).toLocaleTimeString()}
        </TipFooter>
      </div>
    );
  })();

  // 折叠态芯片档位：正常态用底色，预警 / 超支沿用芯片警示色。
  const railLevel = railRolling === undefined ? undefined : goLevelOf(goPercent(railRolling.win));
  const railCls = railLevel ? getChipClass(railLevel) : '';

  // 展开态比例条 tooltip 即宽列比例条，顺序与热力图一致，含缓存、输入、输出、总计、缓存命中率、调用次数与平均每次调用
  const barContent = (() => {
    if (!today || todayTokens === 0) return null;
    const avgPerCall = todayCalls > 0 ? Math.round(todayTokens / todayCalls) : 0;
    const rows: [string, string][] = [
      [t('table.cacheRead'), fmtFull(cacheTokens)],
      [t('table.input'), fmtFull(inputTokens)],
      [t('table.output'), fmtFull(outputTokens)],
      [t('table.total'), fmtFull(todayTokens)],
      [t('footer.cacheHitRate'), pctOf(cacheHitRate)],
      [t('table.calls'), fmtFull(todayCalls)],
      [t('table.avgPerCall'), fmtFull(avgPerCall)],
    ];
    return (
      <div className={`${shared.tipPanelRows} ${shared.tipList}`}>
        {rows.map(([k, v]) => (
          <div key={k} className={shared.tipListRow}>
            <span className={shared.tipListKey}>{k}</span>
            <span className={shared.tipListVal}>{v}</span>
          </div>
        ))}
      </div>
    );
  })();

  const toggle = () => setOpen((v) => !v);
  const ariaLabel = t('footer.railAria', { tokens: fmtFull(todayTokens), calls: fmtFull(todayCalls) });

  // 三额度行显隐同一写法：侧边栏展示开关开 + 数据已加载（未启用时 hook 回 null），宽列与 rail 共用。
  const showZai = settings.showZaiInSidebar && zai !== null;
  const showGo = settings.showGoInSidebar && go !== null;
  const showDeepSeek = settings.showDeepSeekInSidebar && deepseek !== null;

  // ---- Z.ai 额度，含会话与本周百分比及 Web 搜索次数 ----
  const zaiWindows: ZaiWindowEntry[] =
    zai?.status === 'ok'
      ? [
        { key: 'session', short: t('zai.short.session'), full: t('zai.session'), win: zai.session },
        { key: 'weekly', short: t('zai.short.weekly'), full: t('zai.weekly'), win: zai.weekly },
      ].filter((w): w is ZaiWindowEntry => w.win !== null)
      : [];
  const zaiWeb = zai?.status === 'ok' ? zai.webSearches : null;
  const zaiResetsOf = (win: GoWindow): string => goResetsAt(t, win);
  const zaiChip = ({ key, short, win }: ZaiWindowEntry) => {
    const pct = goPercent(win);
    const level = goLevelOf(pct);
    const cls = getChipClass(level);
    return (
      <Tooltip key={key} content={zaiTipContent} side="top" delayMs={400}>
        <span className={`${css.goChip} ${cls}`}>{short} {pct}%</span>
      </Tooltip>
    );
  };

  // 折叠态 Z.ai：取会话窗口优先，否则取本周
  const railZai = zaiWindows.find((w) => w.key === 'session') ?? zaiWindows[0];
  const railZaiLevel = railZai ? goLevelOf(goPercent(railZai.win)) : undefined;
  const railZaiCls = railZaiLevel ? getChipClass(railZaiLevel) : '';

  // Z.ai 额度 tooltip，宽列芯片与折叠 rail 共用，卡片化明细 —
  // 标题行带订阅计划徽标，会话与本周窗口卡及 Web 搜索次数卡含进度条与重置时间，底部带更新时间，异常态为提示卡。
  const zaiTipContent = (() => {
    if (zai === null) return '';
    const wrap = (hint: string) => (
      <div className={shared.tipPanelGo}>
        <TipTitle>{t('zai.title')}</TipTitle>
        <TipHint>{hint}</TipHint>
      </div>
    );
    if (zai.status !== 'ok') {
      if (zai.status === 'no-key') return wrap(t('zai.notConfigured'));
      if (zai.status === 'no-plan') {
        return (
          <div className={shared.tipPanelGo}>
            <TipTitle>{t('zai.title')}</TipTitle>
            <ZaiNoPlan text={t('zai.noPlan')} tone="tip" />
          </div>
        );
      }
      return wrap(t('zai.unavailable'));
    }
    const webReset = zai.webSearches?.resetsAt
      ? t('zai.resetsAt', { time: new Date(zai.webSearches.resetsAt).toLocaleString() })
      : '';
    const hasRows = zaiWindows.length > 0 || zai.webSearches !== null;
    if (!hasRows) return wrap(t('zai.noData'));
    return (
      <div className={shared.tipPanelGo}>
        <div className={shared.tipHeaderRow}>
          <span className={shared.tipTitle}>{t('zai.title')}</span>
          {zai.plan && <TipPill maxWidth={120}>{zai.plan}</TipPill>}
        </div>
        <div className={shared.tipStack}>
          {zaiWindows.map((w) => {
            const pct = goPercent(w.win);
            const pointsText = w.win.used !== null && w.win.limit !== null
              ? `${fmt(w.win.used, tFn)} / ${fmt(w.win.limit, tFn)}`
              : undefined;
            return (
              <QuotaTipRow
                key={w.key}
                label={w.full}
                pct={pct}
                level={goLevelOf(pct)}
                reset={zaiResetsOf(w.win)}
                points={pointsText}
              />
            );
          })}
          {zai.webSearches && (
            <QuotaTipRow
              label={t('zai.webSearches')}
              pct={Math.max(0, Math.min(100, zai.webSearches.percent))}
              level={goLevelOf(Math.max(0, Math.min(100, zai.webSearches.percent)))}
              reset={webReset}
              value={t('zai.webSearchesCount', { used: zai.webSearches.used, limit: zai.webSearches.limit })}
            />
          )}
        </div>
        <TipFooter>
          {t('updatedAt')} {new Date(zai.fetchedAt).toLocaleTimeString()}
        </TipFooter>
      </div>
    );
  })();

  // 折叠态 Go 芯片内容，ok 时展示滚动 5 小时窗口，no-key、error 与加载中均共用 goTipContent，
  // 内容为卡片化明细或提示卡，go 为 null 时内容为空串、气泡自然隐藏。
  const renderGoRail = (): React.ReactNode => {
    if (go?.status === 'ok' && railRolling !== undefined) {
      return (
        <Tooltip content={goTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${railCls}`}>
            <span className={css.goRailChipLabel}>{railRolling.short}</span>
            <span className={css.goRailChipPct}>{goPercent(railRolling.win)}%</span>
          </span>
        </Tooltip>
      );
    }
    if (go?.status === 'no-key') {
      return (
        <Tooltip content={goTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox}`}>
            <span className={css.goRailChipLabel}>{t('go.label')}</span>
            <span className={css.goRailChipPct}>—</span>
          </span>
        </Tooltip>
      );
    }
    if (go?.status === 'error') {
      return (
        <Tooltip content={goTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${css.goChipOver}`}>
            <span className={css.goRailChipLabel}>{t('go.label')}</span>
            <span className={css.goRailChipPct}>!</span>
          </span>
        </Tooltip>
      );
    }
    return (
      <Tooltip content={goTipContent} side="top" delayMs={400}>
        <span className={`${css.goRailChipBox}`}>
          <span className={css.goRailChipLabel}>{t('go.label')}</span>
          <span className={css.goRailChipPct}>—</span>
        </span>
      </Tooltip>
    );
  };

  // 折叠态 DeepSeek 芯片内容
  const renderDeepSeekRail = (): React.ReactNode => {
    if (deepseek?.status === 'ok' && deepseek.isAvailable && deepseek.balances.length > 0) {
      return (
        <Tooltip content={railDeepSeekContent} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{deepseek.balances[0].currency}</span>
            <span className={css.goRailChipPct}>{deepseek.balances[0].totalBalance.slice(0, 6)}</span>
          </span>
        </Tooltip>
      );
    }
    if (deepseek?.status === 'ok' && !deepseek.isAvailable) {
      return (
        <BaseTooltip label={t('deepseek.notAvailable')} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{t('deepseek.label')}</span>
            <span className={css.goRailChipPct}>—</span>
          </span>
        </BaseTooltip>
      );
    }
    if (deepseek?.status === 'no-key') {
      return (
        <BaseTooltip label={t('deepseek.notConfigured')} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{t('deepseek.label')}</span>
            <span className={css.goRailChipPct}>—</span>
          </span>
        </BaseTooltip>
      );
    }
    if (deepseek?.status === 'error') {
      return (
        <BaseTooltip label={t('deepseek.unavailable')} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${css.goChipOver}`}>
            <span className={css.goRailChipLabel}>{t('deepseek.label')}</span>
            <span className={css.goRailChipPct}>!</span>
          </span>
        </BaseTooltip>
      );
    }
    return (
      <Tooltip content={railDeepSeekContent} side="top" delayMs={400}>
        <span className={css.goRailChipBox}>
          <span className={css.goRailChipLabel}>{t('deepseek.label')}</span>
          <span className={css.goRailChipPct}>—</span>
        </span>
      </Tooltip>
    );
  };

  // 折叠态 Z.ai 芯片内容，全部状态共用 zaiTipContent，内容为卡片化明细或提示卡。
  const renderZaiRail = (): React.ReactNode => {
    if (zai?.status === 'ok' && railZai) {
      return (
        <Tooltip content={zaiTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${railZaiCls}`}>
            <span className={css.goRailChipLabel}>{railZai.short}</span>
            <span className={css.goRailChipPct}>{goPercent(railZai.win)}%</span>
          </span>
        </Tooltip>
      );
    }
    if (zai?.status === 'ok' && zai.webSearches) {
      return (
        <Tooltip content={zaiTipContent} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{t('zai.short.webSearches')}</span>
            <span className={css.goRailChipPct}>{zai.webSearches.used}/{zai.webSearches.limit}</span>
          </span>
        </Tooltip>
      );
    }
    if (zai?.status === 'no-key') {
      return (
        <Tooltip content={zaiTipContent} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{t('zai.short.label')}</span>
            <span className={css.goRailChipPct}>—</span>
          </span>
        </Tooltip>
      );
    }
    if (zai?.status === 'no-plan') {
      return (
        <Tooltip content={zaiTipContent} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{t('zai.short.label')}</span>
            <span className={css.goRailChipPct}>—</span>
          </span>
        </Tooltip>
      );
    }
    if (zai?.status === 'error') {
      return (
        <Tooltip content={zaiTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${css.goChipOver}`}>
            <span className={css.goRailChipLabel}>{t('zai.short.label')}</span>
            <span className={css.goRailChipPct}>!</span>
          </span>
        </Tooltip>
      );
    }
    return (
      <Tooltip content={zaiTipContent} side="top" delayMs={400}>
        <span className={css.goRailChipBox}>
          <span className={css.goRailChipLabel}>{t('zai.short.label')}</span>
          <span className={css.goRailChipPct}>—</span>
        </span>
      </Tooltip>
    );
  };

  return (
    <div ref={rootRef} className={wide ? css.root : `${css.root} ${css.rail}`} data-usage-stats-footer>
      <UsageStatsPanel
        open={open}
        data={data}
        err={err}
        errDetail={errDetail}
        go={go}
        deepseek={deepseek}
        zai={zai}
        settings={settings}
        onUpdateSettings={updateSettings}
        onClose={() => setOpen(false)}
        onRefresh={() => { refreshSnapshot(); refreshQuota(); refreshDeepSeek(); refreshZai(); }}
        onRefreshGo={refreshQuota}
        onRefreshDeepSeek={refreshDeepSeek}
        onRefreshZai={refreshZai}
        t={t}
      />
      {wide ? (
        // 宽列合一按钮：整块可点，行序自上而下为 Z.ai 额度 + Go 额度 + DeepSeek 余额 + 今日用量 + 比例条
        <button
          type="button"
          className={css.unified}
          data-active={open || undefined}
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={toggle}
        >
          {showZai && (
            <span className={css.unifiedGoRow}>
              <span className={css.goLabel}>{t('zai.label')}</span>
              {zai.status === 'ok' && zaiWindows.length > 0 && zaiWindows.map(zaiChip)}
              {zai.status === 'ok' && zaiWindows.length === 0 && zaiWeb && (
                <Tooltip content={zaiTipContent} side="top" delayMs={400}>
                  <span className={css.goChip}>{t('zai.short.webSearches')} {zaiWeb.used}/{zaiWeb.limit}</span>
                </Tooltip>
              )}
              {zai.status === 'ok' && zaiWindows.length === 0 && !zaiWeb && <span className={css.goChip}>—</span>}
              {zai.status === 'ok' && zaiWeb && zaiWindows.length > 0 && (
                <Tooltip content={zaiTipContent} side="top" delayMs={400}>
                  <span className={css.goChip}>{t('zai.short.webSearches')} {zaiWeb.used}/{zaiWeb.limit}</span>
                </Tooltip>
              )}
              {zai.status === 'no-key' && (
                <Tooltip content={zaiTipContent} side="top" delayMs={400}>
                  <span className={css.goChip}>—</span>
                </Tooltip>
              )}
              {zai.status === 'no-plan' && (
                <Tooltip content={zaiTipContent} side="top" delayMs={400}>
                  <span className={css.goChip}>—</span>
                </Tooltip>
              )}
              {zai.status === 'error' && (
                <Tooltip content={zaiTipContent} side="top" delayMs={400}>
                  <span className={`${css.goChip} ${css.goChipOver}`}>!</span>
                </Tooltip>
              )}
            </span>
          )}
          {showGo && (
            <span className={css.unifiedGoRow}>
              <span className={css.goLabel}>{t('go.label')}</span>
              {go.status === 'ok' && goWindows.length > 0 && goWindows.map(goChip)}
              {go.status === 'ok' && goWindows.length === 0 && <span className={css.goChip}>—</span>}
              {go.status === 'no-key' && (
                <Tooltip content={goTipContent} side="top" delayMs={400}>
                  <span className={css.goChip}>—</span>
                </Tooltip>
              )}
              {go.status === 'error' && (
                <Tooltip content={goTipContent} side="top" delayMs={400}>
                  <span className={`${css.goChip} ${css.goChipOver}`}>!</span>
                </Tooltip>
              )}
            </span>
          )}
          {showDeepSeek && (
            <span className={css.unifiedGoRow}>
              <span className={css.goLabel}>{t('deepseek.label')}</span>
              {deepseek.status === 'ok' && deepseek.isAvailable && deepseek.balances.length > 0 && deepseek.balances.map((b) => (
                <Tooltip key={b.currency} content={deepseekWideTooltip} side="top" delayMs={400}>
                  <span className={css.goChip}>{b.currency} {b.totalBalance}</span>
                </Tooltip>
              ))}
              {deepseek.status === 'ok' && deepseek.isAvailable && deepseek.balances.length === 0 && (
                <Tooltip content={deepseekWideTooltip} side="top" delayMs={400}>
                  <span className={css.goChip}>—</span>
                </Tooltip>
              )}
              {deepseek.status === 'ok' && !deepseek.isAvailable && (
                <BaseTooltip label={t('deepseek.notAvailable')} side="top" delayMs={400}>
                  <span className={css.goChip}>—</span>
                </BaseTooltip>
              )}
              {deepseek.status === 'no-key' && (
                <BaseTooltip label={t('deepseek.notConfigured')} side="top" delayMs={400}>
                  <span className={css.goChip}>—</span>
                </BaseTooltip>
              )}
              {deepseek.status === 'error' && (
                <BaseTooltip label={t('deepseek.unavailable')} side="top" delayMs={400}>
                  <span className={`${css.goChip} ${css.goChipOver}`}>!</span>
                </BaseTooltip>
              )}
            </span>
          )}
          <span className={css.unifiedMain}>
            <span className={css.badgeIcon}><IconDataOutline16 size={14} /></span>
            <span className={css.badgeLabel}>{t('footer.todayLabel')}</span>
            <span className={css.badgeMeta}>
              {err
                ? <span className={css.badgeErr}>--</span>
                : (
                  <>
                    <span className={css.badgeCalls}>{fmtFull(todayCalls)}{t('panel.summary.callsSuffix')}</span>
                    <span className={css.badgeTokens}>· {fmt(todayTokens, tFn)}</span>
                    {missing && <span className={css.badgeErr}>{fmtFull(data?.failed ?? 0)}</span>}
                  </>
                )}
            </span>
            {!err && todayTokens > 0 && (
              <Tooltip follow content={barContent} side="top" delayMs={300}>
                <span className={css.barRow}>
                  {cacheTokens > 0 && (
                    <span
                      className={`${css.barSeg} ${css.barCache}`}
                      style={{ flex: cacheTokens }}
                    />
                  )}
                  {inputTokens > 0 && (
                    <span
                      className={`${css.barSeg} ${css.barInput}`}
                      style={{ flex: inputTokens }}
                    />
                  )}
                  {outputTokens > 0 && (
                    <span
                      className={`${css.barSeg} ${css.barOutput}`}
                      style={{ flex: outputTokens }}
                    />
                  )}
                </span>
              </Tooltip>
            )}
          </span>
        </button>
      ) : (
        // 折叠 rail 合一按钮，Z.ai、Go 与 DeepSeek 迷你芯片在上、今日用量芯片在下含今日与 tokens 缩写值，整块可点
        <button
          type="button"
          className={css.railUnified}
          data-active={open || undefined}
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={toggle}
        >
          {showZai && (
            <span className={css.goRailChip}>
              {renderZaiRail()}
            </span>
          )}
          {showGo && (
            <span className={css.goRailChip}>
              {renderGoRail()}
            </span>
          )}
          {showDeepSeek && (
            <span className={css.goRailChip}>
              {renderDeepSeekRail()}
            </span>
          )}
          {/* 今日用量迷你芯片，折叠态也展示今日 tokens 总量为缩写值，tooltip 为完整明细，按需求使用今日文字 */}
          <Tooltip content={railContent} side="right" delayMs={500}>
            <span className={css.goRailChipBox}>
              <span className={css.goRailChipLabel}>{t('footer.todayLabel')}</span>
              <span className={`${css.goRailChipPct} ${css.goRailChipPctCompact}`}>
                {err ? '--' : fmt(todayTokens, tFn)}
              </span>
            </span>
          </Tooltip>
        </button>
      )}
    </div>
  );
}
