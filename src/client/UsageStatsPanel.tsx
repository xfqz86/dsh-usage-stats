/**
 * 用量统计的详情视图：侧边栏底部按钮打开的居中模态窗（Tab 化）。
 *
 * 通过 primitives 的 `Modal` 渲染（遮罩 + Escape + aria-modal），headless
 * 模式保留自有布局：头部（标题/状态/关闭）→ Tab 栏（概览/日期/会话/模型/
 * 设置，语义化 role="tablist"）→ 各 Tab 内容区。
 *
 * - 概览：汇总网格 + OpenCode Go 订阅额度（三档窗口进度条）+ 扫描页脚；
 * - 日期：每日趋势（曲线/热力图切换 + 时间范围），悬停 tooltip 显示当日明细；
 * - 会话：按会话表（标题/cwd/最近活跃，默认 8 条可展开）；
 * - 模型：按模型/Provider 拆分表（含占比条）；
 * - 设置：手动刷新入口（立即重拉快照与额度，不等下个轮询周期）+ 偏好占位。
 *
 * 数据与底部按钮共用 /usage-stats/api/snapshot 与 /usage-stats/api/go-quota
 * 的轮询结果；Tab 内视图状态（范围/曲线视图/会话展开）在切换时保留。
 */

import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  IconAgentPresetOutline16,
  IconCloseOutline16,
  IconDataOutline16,
  IconQueueOutline14,
  IconRightUpOutline16,
  IconSettingsOutline16,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './UsageStatsPanel.module.css'
import type { ModelStat, SessionStat, UsageSnapshot } from './useSnapshot.ts'
import type { GoQuota, GoWindow } from './useGoQuota.ts'
import type { UsageStatsKey } from './locales.ts'
import {
  buildSet, curveOf, dayTotal, fmt, fmtFull, fullDayLabel, heatGridOf, pctOf, shortId, todayOf, usageTotal,
  type HeatGridCell,
} from './stats.ts'

export interface UsageStatsPanelProps extends PropsLocale<'dsh-usage-statistics'> {
  /** 模态窗是否显示。 */
  open: boolean
  /** 底部按钮轮询到的最新快照；不可用时为 null。 */
  data: UsageSnapshot | null
  /** 拉取失败（服务不可达 / 响应非 ok）。 */
  err: boolean
  /** OpenCode Go 订阅额度（底部按钮轮询）；null 表示尚未加载。 */
  go: GoQuota | null
  /** 关闭模态窗（关闭按钮、遮罩点击或 Escape）。 */
  onClose: () => void
  /** 立即重新拉取快照与 Go 额度（设置页"手动刷新"按钮）。 */
  onRefresh: () => void
}

/** Tab 键：与面板内视图一一对应。 */
type TabKey = 'overview' | 'dates' | 'sessions' | 'models' | 'settings'

/** Tab 定义：键 + 文案键 + 图标组件。 */
const TABS: Array<{ key: TabKey; labelKey: UsageStatsKey; Icon: ComponentType<IconProps> }> = [
  { key: 'overview', labelKey: 'tab.overview', Icon: IconDataOutline16 },
  { key: 'dates', labelKey: 'tab.dates', Icon: IconRightUpOutline16 },
  { key: 'sessions', labelKey: 'tab.sessions', Icon: IconQueueOutline14 },
  { key: 'models', labelKey: 'tab.models', Icon: IconAgentPresetOutline16 },
  { key: 'settings', labelKey: 'tab.settings', Icon: IconSettingsOutline16 },
]

/** 时间范围选项：值 + 对应文案键。 */
const RANGE_KEYS = [
  ['7d', 'range.7d'],
  ['14d', 'range.14d'],
  ['30d', 'range.30d'],
  ['all', 'range.all'],
] as const
type RangeKey = typeof RANGE_KEYS[number][0]

/** 月份文案键：每列（周）首月变化时显示。 */
const MONTH_KEYS = [
  'month.1', 'month.2', 'month.3', 'month.4', 'month.5', 'month.6',
  'month.7', 'month.8', 'month.9', 'month.10', 'month.11', 'month.12',
] as const

/** 热力图强度 1..4 对应的 scoped 类名（0 = 无用量底色）。 */
const HEAT_LEVELS = [null, css.hl1, css.hl2, css.hl3, css.hl4] as const

/** 渲染一个统计格（数值 + 标签）。 */
function StatCell({ value, label }: { value: string; label: ReactNode }) {
  return (
    <div className={css.cell}>
      <span className={css.cellV}>{value}</span>
      <span className={css.cellK}>{label}</span>
    </div>
  )
}

/** OpenCode Go 额度行定义：键 + 完整文案键。 */
const GO_ROWS = [
  ['rolling', 'go.rolling'],
  ['weekly', 'go.weekly'],
  ['monthly', 'go.monthly'],
] as const

/** 用量百分比四舍五入并夹在 0..100。 */
function goPct(win: GoWindow): number {
  return Math.round(Math.max(0, Math.min(100, win.percent)))
}

/** 额度档位：≥100% 超支、≥80% 预警、其余正常。 */
function goLevel(pct: number): 'over' | 'warn' | 'ok' {
  return pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
}

/** 概览 Tab 的热力图：Codex 风格 26 周网格（列 = 周，行 = 周一..周日），
 *  参考 dsh-cost-meter 的 cm-ug-grid（4 档强度 + 月份标签 + 今日高亮）。 */
function UsageHeatmap({
  series, t,
}: {
  series: UsageSnapshot['series']['all']
  t: UsageStatsPanelProps['t']
}) {
  const grid = useMemo(() => heatGridOf(series, 26), [series])
  // 按天索引序列，供 tooltip 取每日明细（缓存 = cacheRead + cacheWrite）。
  const byDay = useMemo(() => new Map(series.map(s => [s.t, s])), [series])
  const totalTokens = useMemo(() => grid.cells.reduce((s, c) => s + c.v, 0), [grid])
  const totalCalls = useMemo(() => grid.cells.reduce((s, c) => s + c.calls, 0), [grid])
  const hasUsage = totalTokens > 0

  const cellClass = (c: HeatGridCell): string => {
    const lvl = HEAT_LEVELS[c.lvl] ?? ''
    const cls = `${css.hcell}${lvl ? ' ' + lvl : ''}`
    return c.today ? `${cls} ${css.hcellToday}` : cls
  }

  /** 单格 tooltip 文案：日期 + 明细（与曲线 tooltip 同口径）。 */
  const cellTip = (c: HeatGridCell): string => {
    const day = byDay.get(c.t)
    return t('heat.tip', {
      date: c.label,
      tokens: fmtFull(c.v),
      input: fmtFull(day?.input ?? 0),
      cache: fmtFull((day?.cacheRead ?? 0) + (day?.cacheWrite ?? 0)),
      output: fmtFull(day?.output ?? 0),
      calls: fmtFull(c.calls),
    })
  }

  return (
    <div className={css.section}>
      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('heat.title')}</span>
      </div>
      <span className={css.heatTotal}>
        {t('heat.total', { tokens: fmtFull(totalTokens), calls: fmtFull(totalCalls) })}
      </span>
      {hasUsage ? (
        <>
          <div className={css.heatGrid} style={{ gridTemplateColumns: `repeat(${grid.cols},1fr)` }}>
            {grid.cells.map((c, i) => (
              <Tooltip key={i} label={cellTip(c)} side="top" delayMs={150}>
                <div className={cellClass(c)} />
              </Tooltip>
            ))}
          </div>
          <div className={css.heatMonths} style={{ gridTemplateColumns: `repeat(${grid.cols},1fr)` }}>
            {grid.months.map((m, i) => (
              <span key={i} className={css.heatMonth}>{m === null ? '' : t(MONTH_KEYS[m])}</span>
            ))}
          </div>
        </>
      ) : (
        <div className={css.empty}>{t('state.noUsage')}</div>
      )}
    </div>
  )
}

/** 概览 Tab：汇总网格 + Go 额度 + 26 周热力图 + 扫描页脚。 */
function OverviewTab({
  value, go, t,
}: {
  value: UsageSnapshot
  go: GoQuota | null
  t: UsageStatsPanelProps['t']
}) {
  const all = value?.all ?? { calls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 } }
  const today = todayOf(value.series.all ?? [])

  return (
    <>
      {/* 汇总 */}
      <div className={css.summary}>
        <StatCell value={fmtFull(today ? dayTotal(today) : 0)} label={t('panel.summary.todayTokens')} />
        <StatCell value={fmtFull(today?.calls ?? 0)} label={t('panel.summary.todayCalls')} />
        <StatCell value={fmtFull(usageTotal(all.usage))} label={t('panel.summary.totalTokens')} />
        <StatCell value={fmtFull(value.sessions)} label={t('panel.summary.sessions')} />
      </div>

      {/* 26 周热力图（Codex 风格，参考 dsh-cost-meter） */}
      <UsageHeatmap series={value.series.all} t={t} />

      {/* OpenCode Go 订阅额度 */}
      {go !== null && go.status === 'ok' && (
        <div className={css.section}>
          <div className={css.sectionHead}>
            <span className={css.sectionLabel}>{t('go.title')}</span>
          </div>
          {GO_ROWS.map(([key, labelKey]) => {
            const win = go[key]
            if (win === null) return null
            const pct = goPct(win)
            const level = goLevel(pct)
            return (
              <div className={css.goRow} key={key}>
                <span className={css.goLabel}>{t(labelKey)}</span>
                <span className={css.goBar}>
                  <span
                    className={level === 'over' ? `${css.goBarFill} ${css.goFillOver}` : level === 'warn' ? `${css.goBarFill} ${css.goFillWarn}` : css.goBarFill}
                    style={{ width: pct + '%' }}
                  />
                </span>
                <span className={level === 'over' ? `${css.goPct} ${css.goPctOver}` : level === 'warn' ? `${css.goPct} ${css.goPctWarn}` : css.goPct}>{pct}%</span>
                <span className={css.goReset}>
                  {win.resetsAt ? t('go.resetsAt', { time: new Date(win.resetsAt).toLocaleString() }) : ''}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {go !== null && go.status === 'no-key' && (
        <div className={css.section}>
          <div className={css.sectionHead}>
            <span className={css.sectionLabel}>{t('go.title')}</span>
          </div>
          <span className={css.goHint}>{t('go.notConfigured')}</span>
        </div>
      )}
      {go !== null && go.status === 'error' && (
        <div className={css.section}>
          <div className={css.sectionHead}>
            <span className={css.sectionLabel}>{t('go.title')}</span>
          </div>
          <span className={css.goHint}>{t('go.unavailable')}</span>
        </div>
      )}

      {/* 页脚：扫描信息 */}
      <div className={css.footer}>
        <span>{t('scanInfo')} {fmtFull(value.rawSessions)}/{fmtFull(value.harnessSessions)} · {t('events')} {fmtFull(value.foldedEvents)}</span>
        <span>{t('updatedAt')} {value.time ? new Date(value.time).toTimeString().slice(0, 8) : '--'}</span>
      </div>
    </>
  )
}

/** 日期 Tab：每日趋势（曲线 + 时间范围），悬停 tooltip 显示当日明细。 */
function DatesTab({
  series, t,
}: {
  series: UsageSnapshot['series']['all']
  t: UsageStatsPanelProps['t']
}) {
  const [range, setRange] = useState<RangeKey>('7d')
  const [tip, setTip] = useState<{ x: number; y: number; label: string; total: number; calls: number } | null>(null)
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  const buckets = useMemo(() => buildSet(series, range), [range, series])
  const curve = useMemo(() => curveOf(buckets, 300, 130), [buckets])

  // 把 tooltip 约束在图表区域内。
  useEffect(() => {
    if (!tip) { setTipPos(null); return }
    const w = tipRef.current?.offsetWidth ?? 180
    const h = tipRef.current?.offsetHeight ?? 40
    const chartW = 300
    let left = tip.x - w / 2
    left = Math.max(6, Math.min(left, chartW - w - 6))
    let top = tip.y - h - 10
    top = Math.max(6, Math.min(top, 130))
    setTipPos({ left, top })
  }, [tip])

  /** 由鼠标事件换算图表内的坐标。 */
  const tipFromEvent = (e: React.MouseEvent) => {
    let x = 20, y = 20
    const el = chartRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      x = e.clientX - r.left
      y = e.clientY - r.top
    }
    return { x, y }
  }

  return (
    <div className={css.section}>
      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('panel.trend')}</span>
        <span className={css.chips}>
          {RANGE_KEYS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={range === value ? `${css.chip} ${css.chipOn}` : css.chip}
              onClick={() => setRange(value)}
            >{t(label)}</button>
          ))}
        </span>
      </div>
      <div
        className={css.chart}
        ref={chartRef}
        onMouseLeave={() => setTip(null)}
      >
        {!curve
          ? <div className={css.empty}>{t('state.noUsage')}</div>
          : (
            <svg className={css.svg} viewBox={`0 0 ${curve.W} ${curve.H}`}>
                {[0.25, 0.5, 0.75].map(f => (
                  <line key={'g' + f} x1={0} x2={curve.W} y1={curve.H * f} y2={curve.H * f} className={css.gridline} />
                ))}
                <defs>
                  <linearGradient id="usu-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--dsw-alias-brand-primary,#4d6bfe)" stopOpacity=".25" />
                    <stop offset="100%" stopColor="var(--dsw-alias-brand-primary,#4d6bfe)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={curve.area} fill="url(#usu-area)" stroke="none" />
                <path d={curve.line} fill="none" stroke="var(--dsw-alias-brand-primary,#4d6bfe)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                {curve.hits.map((h, i) => (
                  <g
                    key={'h' + i}
                    onMouseEnter={(e: React.MouseEvent) => {
                      e.stopPropagation()
                      const p = tipFromEvent(e)
                      setTip({ x: p.x, y: p.y, label: fullDayLabel(h.b.t), total: dayTotal(h.b), calls: h.b.calls })
                    }}
                  >
                    <circle cx={h.cx} cy={h.cy} r={7} fill="transparent" />
                    <circle cx={h.cx} cy={h.cy} r={2.5} fill="var(--dsw-alias-brand-primary,#4d6bfe)" />
                  </g>
                ))}
                {(function () {
                  const n = curve.hits.length
                  const idxs = n === 1 ? [0] : n === 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1]
                  return idxs.map((i, k) => (
                    <text key={'l' + k} x={curve.hits[i].cx} y={curve.H - 3} className={css.axisLabel} textAnchor="middle">
                      {curve.hits[i].label}
                    </text>
                  ))
                })()}
              </svg>
          )}
        {tip && (
          <div
            ref={tipRef}
            className={css.tip}
            style={{ left: (tipPos ? tipPos.left : 0) + 'px', top: (tipPos ? tipPos.top : 0) + 'px', opacity: tipPos ? 1 : 0 }}
          >
            <div>{tip.label}</div>
            <div>总 <b>{fmtFull(tip.total)}</b> tokens · 调 {fmtFull(tip.calls)}</div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 会话 Tab：按会话表（默认 8 条，可展开全部）。 */
function SessionsTab({
  sessionsList, t,
}: {
  sessionsList: SessionStat[]
  t: UsageStatsPanelProps['t']
}) {
  const [showAllSessions, setShowAllSessions] = useState(false)
  const hasMoreSessions = sessionsList.length > 8
  const shownSessions = showAllSessions ? sessionsList.slice(0, 50) : sessionsList.slice(0, 8)

  if (sessionsList.length === 0) {
    return <div className={css.empty}>{t('state.noUsage')}</div>
  }

  return (
    <div className={css.section}>
      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('panel.sessions')}</span>
        {hasMoreSessions && (
          <button className={css.toggle} onClick={() => setShowAllSessions(v => !v)}>
            {t(showAllSessions ? 'sessions.collapseAll' : 'sessions.showAll', { n: sessionsList.length })}
          </button>
        )}
      </div>
      <table className={css.table}>
        <thead>
          <tr>
            <th>{t('table.session')}</th>
            <th>{t('table.calls')}</th>
            <th>{t('table.total')}</th>
            <th>{t('table.lastActive')}</th>
          </tr>
        </thead>
        <tbody>
          {shownSessions.map((s, i) => {
            const when = s.lastActive
              ? Date.now() - s.lastActive < 86400000
                ? t('time.today') + ' ' + new Date(s.lastActive).toTimeString().slice(0, 5)
                : fullDayLabel(s.lastActive)
              : '--'
            return (
              <tr key={i} title={(s.cwd ? s.cwd + '\n' : '') + (s.title ? s.title : '')}>
                <td className={css.cellText}>
                  {s.title || shortId(s.id)} <span className={css.sub}>· {shortId(s.id)}</span>
                </td>
                <td className={css.num}>{fmtFull(s.calls)}</td>
                <td className={`${css.num} ${css.strong}`}>{fmt(usageTotal(s.usage))}</td>
                <td className={css.num}>{when}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** 模型 Tab：按模型/Provider 拆分表（含占比条）。 */
function ModelsTab({
  models, t,
}: {
  models: ModelStat[]
  t: UsageStatsPanelProps['t']
}) {
  const maxModel = models.length
    ? Math.max(1, ...models.map((m) => usageTotal(m.usage)))
    : 1

  if (models.length === 0) {
    return <div className={css.empty}>{t('state.noUsage')}</div>
  }

  return (
    <div className={css.section}>
      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('panel.models')}</span>
      </div>
      <table className={css.table}>
        <thead>
          <tr>
            <th>{t('table.model')}</th>
            <th>{t('table.calls')}</th>
            <th>{t('table.input')}</th>
            <th>{t('table.output')}</th>
            <th>{t('table.cacheRead')}</th>
            <th>{t('table.total')}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m, i) => {
            const total = usageTotal(m.usage)
            const share = Math.round((total / maxModel) * 1000) / 10
            return (
              <tr key={i}>
                <td className={css.cellText}>
                  {m.model} <span className={css.sub}>· {m.provider}</span>
                </td>
                <td className={css.num}>{fmtFull(m.calls)}</td>
                <td className={css.num}>{fmt(m.usage.input)}</td>
                <td className={css.num}>{fmt(m.usage.output)}</td>
                <td className={css.num}>{fmt(m.usage.cacheRead)}</td>
                <td className={`${css.num} ${css.strong}`}>{fmt(total)}</td>
                <td className={css.barRow}>
                  <span className={css.bar}><span className={css.barFill} style={{ width: share + '%' }} /></span>
                  <span className={css.barPct}>{pctOf(share)}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** 设置 Tab：手动刷新 + 重建账本 + 偏好占位（后续参数设置扩展点）。 */
function SettingsTab({
  onRefresh, t,
}: {
  onRefresh: () => void
  t: UsageStatsPanelProps['t']
}) {
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [rebuildState, setRebuildState] = useState<'idle' | 'busy' | 'done'>('idle')

  const handleRefresh = () => {
    onRefresh()
    setJustRefreshed(true)
    window.setTimeout(() => setJustRefreshed(false), 1500)
  }

  /** 重建账本：清空事件流与元数据 → 服务端重扫日志；完成后立即拉快照。 */
  const handleRebuild = async () => {
    if (rebuildState === 'busy') return
    setRebuildState('busy')
    try {
      await fetch('/usage-stats/api/rebuild', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      setRebuildState('done')
      onRefresh()
      window.setTimeout(() => setRebuildState('idle'), 1500)
    } catch {
      setRebuildState('idle')
    }
  }

  return (
    <div className={css.section}>
      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('settings.refresh')}</span>
      </div>
      <button
        type="button"
        className={justRefreshed ? `${css.refreshBtn} ${css.refreshBtnDone}` : css.refreshBtn}
        onClick={handleRefresh}
      >
        {justRefreshed ? t('settings.refreshed') : t('settings.refreshAction')}
      </button>
      <span className={css.goHint}>{t('settings.refreshHint')}</span>

      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('settings.rebuild')}</span>
      </div>
      <button
        type="button"
        className={rebuildState === 'done' ? `${css.refreshBtn} ${css.refreshBtnDone}` : rebuildState === 'busy' ? `${css.refreshBtn} ${css.refreshBtnBusy}` : css.refreshBtn}
        onClick={handleRebuild}
        disabled={rebuildState === 'busy'}
      >
        {rebuildState === 'busy' ? t('settings.rebuilding') : rebuildState === 'done' ? t('settings.rebuilt') : t('settings.rebuildAction')}
      </button>
      <span className={css.goHint}>{t('settings.rebuildHint')}</span>

      {/* 偏好设置占位：后续参数设置统一放这里 */}
      <div className={css.sectionHead}>
        <span className={css.sectionLabel}>{t('settings.preferences')}</span>
      </div>
      <span className={css.goHint}>{t('settings.preferencesPlaceholder')}</span>
    </div>
  )
}

export function UsageStatsPanel({ open, data, err, go, onClose, onRefresh, t }: UsageStatsPanelProps) {
  const [active, setActive] = useState<TabKey>('overview')

  const value = data

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('panel.title')}
      closeLabel={t('panel.close')}
      headless
      className={css.modal}
    >
      <header className={css.header}>
        <span className={css.title}>{t('panel.title')}</span>
        <span className={css.headerMeta}>
          {!err && (
            <>
              {value?.scanning && (
                <span className={`${css.status} ${css.statusScan}`}>{t('state.scanning')}</span>
              )}
              {value != null && value.failed > 0 && (
                <span
                  className={`${css.status} ${css.statusErr}`}
                  title={String(value.lastError ?? value.scanError ?? '')}
                >{t('state.missingSessions', { n: value.failed })}</span>
              )}
            </>
          )}
          <button
            type="button"
            className={css.close}
            onClick={onClose}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </span>
      </header>

      {/* Tab 栏：语义化 tablist（无现成 harness 组件，样式与 chip/seg 统一） */}
      <div className={css.tabbar} role="tablist" aria-label={t('panel.title')}>
        {TABS.map(({ key, labelKey, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            className={active === key ? `${css.tab} ${css.tabOn}` : css.tab}
            onClick={() => setActive(key)}
          >
            <Icon size={14} />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>

      <div className={css.body} role="tabpanel">
        {err
          ? <div className={css.empty}>{t('state.unavailable')}</div>
          : !value
            ? <div className={css.empty}>{t('state.loading')}</div>
            : (
              <>
                {active === 'overview' && <OverviewTab value={value} go={go} t={t} />}
                {active === 'dates' && <DatesTab series={value.series.all} t={t} />}
                {active === 'sessions' && <SessionsTab sessionsList={value.sessionsList} t={t} />}
                {active === 'models' && <ModelsTab models={value.models} t={t} />}
                {active === 'settings' && <SettingsTab onRefresh={onRefresh} t={t} />}
              </>
            )}
      </div>
    </Modal>
  )
}