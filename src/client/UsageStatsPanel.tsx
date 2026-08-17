/**
 * 用量统计的详情视图：侧边栏底部按钮打开的居中模态窗。
 *
 * 通过 primitives 的 `Modal` 渲染（遮罩 + Escape + aria-modal），headless
 * 模式保留自有布局：头部（标题/状态/关闭）、可滚动内容区——汇总网格、
 * OpenCode Go 订阅额度区、按模型/Provider 拆分表（含占比条）、按会话表、
 * 每日趋势（曲线/热力图切换）。数据与底部按钮共用 /usage-stats/api/snapshot
 * 与 /usage-stats/api/go-quota 的轮询结果。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconCloseOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './UsageStatsPanel.module.css'
import type { ModelStat, SessionStat, UsageSnapshot } from './useSnapshot.ts'
import type { GoQuota, GoWindow } from './useGoQuota.ts'
import {
  buildSet, curveOf, dayTotal, fmt, fmtFull, fullDayLabel, heatOf, pctOf, shortId, todayOf, usageTotal,
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
}

/** 时间范围选项：值 + 对应文案键。 */
const RANGE_KEYS = [
  ['7d', 'range.7d'],
  ['14d', 'range.14d'],
  ['30d', 'range.30d'],
  ['all', 'range.all'],
] as const
type RangeKey = typeof RANGE_KEYS[number][0]

/** 热力图强度 0..7 对应的 scoped 类名。 */
const HEAT_LEVELS = [css.h0, css.h1, css.h2, css.h3, css.h4, css.h5, css.h6, css.h7]

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

export function UsageStatsPanel({ open, data, err, go, onClose, t }: UsageStatsPanelProps) {
  const [range, setRange] = useState<RangeKey>('7d')
  const [viz, setViz] = useState<'curve' | 'heat'>('curve')
  const [showAllSessions, setShowAllSessions] = useState(false)
  const [tip, setTip] = useState<{ x: number; y: number; label: string; total: number; calls: number } | null>(null)
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  const value = data
  const all = value?.all ?? { calls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 } }
  const models: ModelStat[] = value?.models ?? []
  const sessionsList: SessionStat[] = value?.sessionsList ?? []
  const series = value?.series.all ?? []
  const today = todayOf(series)

  const buckets = useMemo(() => buildSet(series, range), [range, series])
  const curve = useMemo(() => curveOf(buckets, 300, 130), [buckets])
  const heat = useMemo(() => heatOf(buckets), [buckets])
  const maxModel = models.length
    ? Math.max(1, ...models.map((m) => usageTotal(m.usage)))
    : 1
  const shownSessions = showAllSessions ? sessionsList.slice(0, 50) : sessionsList.slice(0, 8)
  const hasMoreSessions = sessionsList.length > 8

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

      <div className={css.body}>
        {err
          ? <div className={css.empty}>{t('state.unavailable')}</div>
          : !value
            ? <div className={css.empty}>{t('state.loading')}</div>
            : (
              <>
                {/* 汇总 */}
                <div className={css.summary}>
                  <StatCell value={fmtFull(today ? dayTotal(today) : 0)} label={t('panel.summary.todayTokens')} />
                  <StatCell value={fmtFull(today?.calls ?? 0)} label={t('panel.summary.todayCalls')} />
                  <StatCell value={fmtFull(usageTotal(all.usage))} label={t('panel.summary.totalTokens')} />
                  <StatCell value={fmtFull(value.sessions)} label={t('panel.summary.sessions')} />
                </div>

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

                {/* 按模型拆分 */}
                {models.length > 0 && (
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
                )}

                {/* 按会话 */}
                {sessionsList.length > 0 && (
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
                )}

                {/* 每日趋势：曲线 / 热力图 */}
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
                  <div className={css.sectionHead}>
                    <span className={css.seg}>
                      <button
                        type="button"
                        className={viz === 'curve' ? css.segOn : ''}
                        onClick={() => setViz('curve')}
                      >{t('viz.curve')}</button>
                      <button
                        type="button"
                        className={viz === 'heat' ? css.segOn : ''}
                        onClick={() => setViz('heat')}
                      >{t('viz.heat')}</button>
                    </span>
                  </div>
                  <div
                    className={css.chart}
                    ref={chartRef}
                    onMouseLeave={() => setTip(null)}
                  >
                    {(!curve && viz === 'curve') || (heat.cells.length === 0 && viz === 'heat')
                      ? <div className={css.empty}>{t('state.noUsage')}</div>
                      : viz === 'curve' && curve
                        ? (
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
                        )
                        : (
                          <div className={css.heat} style={{ gridTemplateColumns: `repeat(${heat.cols},1fr)` }}>
                            {heat.cells.map((c, i) => (
                              <div
                                key={i}
                                className={`${css.hcell} ${HEAT_LEVELS[c.lvl]}`}
                                onMouseEnter={(e: React.MouseEvent) => {
                                  e.stopPropagation()
                                  const p = tipFromEvent(e)
                                  setTip({ x: p.x, y: p.y, label: c.label, total: c.v, calls: c.calls })
                                }}
                              />
                            ))}
                          </div>
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

                {/* 页脚 */}
                <div className={css.footer}>
                  <span>{t('scanInfo')} {fmtFull(value.rawSessions)}/{fmtFull(value.harnessSessions)} · {t('events')} {fmtFull(value.foldedEvents)}</span>
                  <span>{t('updatedAt')} {value.time ? new Date(value.time).toTimeString().slice(0, 8) : '--'}</span>
                </div>
              </>
            )}
      </div>
    </Modal>
  )
}
