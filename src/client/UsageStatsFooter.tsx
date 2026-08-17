/**
 * 用量统计的侧边栏底部动作：渲染在 `sidebar.footer.action` 列表插槽
 * （设置按钮上方）的今日统计触发器。
 *
 * 宽列：上方一排带"Go 额度"标签的 OpenCode Go 订阅额度芯片（滚动 5 小时 /
 * 本周 / 本月用量百分比，≥80% 预警、≥100% 超支，hover 仅显示重置时间），
 * 下方是图标 + "今日" + 今日 tokens / 调用次数 + 三色比例条（缓存/输入/输出，
 * hover 显示各类别具体数值）。56px rail（折叠列）：圆形图标按钮上方仅显示
 * 滚动 5 小时额度芯片，今日数字与 5 小时额度明细由 Tooltip 承载。点击打开
 * 模态窗详情（{@link UsageStatsPanel}）。
 */

import { useEffect, useRef, useState } from 'react'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './UsageStatsFooter.module.css'
import { useSnapshot } from './useSnapshot.ts'
import { useGoQuota, type GoWindow } from './useGoQuota.ts'
import { alignedRows, fmt, fmtFull, pctOf, todayOf } from './stats.ts'
import { UsageStatsPanel } from './UsageStatsPanel.tsx'

export type UsageStatsFooterProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'dsh-usage-statistics'>

/** 用量百分比四舍五入并夹在 0..100。 */
function clampPct(win: GoWindow): number {
  return Math.round(Math.max(0, Math.min(100, win.percent)))
}

/** 额度档位：≥100% 超支、≥80% 预警、其余正常。 */
function levelOf(pct: number): 'over' | 'warn' | 'ok' {
  return pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
}

/** 单个额度窗口的展示条目（短/全名 + 窗口数据）。 */
interface GoWindowEntry {
  key: string
  short: string
  full: string
  win: GoWindow
}

export function UsageStatsFooter({ wide, t }: UsageStatsFooterProps) {
  const [open, setOpen] = useState(false)
  const [data, err] = useSnapshot(4000)
  const [go] = useGoQuota(60000)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef?.current
    const footerActionsDiv = root?.parentElement?.parentElement
    if (footerActionsDiv) footerActionsDiv.style.flexDirection = 'column';
  }, [rootRef])

  const today = todayOf(data?.series.all ?? [])
  const todayTokens = today
    ? (today.input || 0) + (today.output || 0) + (today.cacheRead || 0) + (today.cacheWrite || 0)
    : 0
  const todayCalls = today?.calls ?? 0
  const missing = (data?.failed ?? 0) > 0

  // 今日各分类 token 数
  const cacheTokens = (today?.cacheRead || 0) + (today?.cacheWrite || 0)
  const inputTokens = today?.input || 0
  const outputTokens = today?.output || 0
  // 缓存命中率 = cacheRead / (cacheRead + input)
  const cacheRead = today?.cacheRead || 0
  const cacheHitRate = (cacheRead + inputTokens) > 0
    ? Math.round((cacheRead / (cacheRead + inputTokens)) * 1000) / 10
    : null

  // ---- OpenCode Go 额度：三档窗口（滚动5小时 / 本周 / 本月）----
  const goWindows: GoWindowEntry[] =
    go?.status === 'ok'
      ? [
        { key: 'rolling', short: t('go.short.rolling'), full: t('go.rolling'), win: go.rolling },
        { key: 'weekly', short: t('go.short.weekly'), full: t('go.weekly'), win: go.weekly },
        { key: 'monthly', short: t('go.short.monthly'), full: t('go.monthly'), win: go.monthly },
      ].filter((w): w is GoWindowEntry => w.win !== null)
      : []
  const resetsOf = (win: GoWindow): string =>
    win.resetsAt ? t('go.resetsAt', { time: new Date(win.resetsAt).toLocaleString() }) : ''
  const windowLine = (win: GoWindow | null, full: string): string =>
    win ? `${full}: ${clampPct(win)}%` + (resetsOf(win) ? ' · ' + resetsOf(win) : '') : ''

  // 单个额度芯片（宽列横向 / rail 竖排共用）：短标签 + 百分比，按档位着色，
  // hover 仅显示重置时间（无重置时间时兜底显示窗口全名）。
  const goChip = ({ key, short, full, win }: GoWindowEntry) => {
    const pct = clampPct(win)
    const level = levelOf(pct)
    const cls = level === 'over' ? css.goChipOver : level === 'warn' ? css.goChipWarn : css.goChipOk
    return (
      <Tooltip key={key} label={resetsOf(win) || full} side="top" delayMs={400}>
        <span className={`${css.goChip} ${cls}`}>{short} {pct}%</span>
      </Tooltip>
    )
  }

  // 折叠 rail tooltip：顶部"今日："标题 + 6 行对齐（调用 / 总计 / 缓存 / 输入 / 输出 / 缓存命中率）
  // + OpenCode Go 额度行（折叠态只展示滚动 5 小时窗口）。
  const railLabel = (() => {
    if (!today || todayTokens === 0) return t('footer.railEmpty')
    const lines = [
      t('footer.railHeader') + '\n' + alignedRows([
        [t('footer.railCalls'), fmtFull(todayCalls)],
        [t('footer.railTotal'), fmtFull(todayTokens)],
        [t('footer.cacheTip', { n: '' }).trim(), fmtFull(cacheTokens)],
        [t('footer.inputTip', { n: '' }).trim(), fmtFull(inputTokens)],
        [t('footer.outputTip', { n: '' }).trim(), fmtFull(outputTokens)],
        [t('footer.cacheHitRate'), pctOf(cacheHitRate)],
      ]),
    ]
    const railGo = goWindows.filter((w) => w.key === 'rolling')
    if (railGo.length > 0) {
      lines.push(t('go.title') + '\n' + railGo.map((w) => windowLine(w.win, w.full)).join('\n'))
    }
    return lines.join('\n\n')
  })()

  // 折叠态：只展示滚动 5 小时窗口的额度芯片（移在圆形按钮上方）。
  const railRolling = goWindows.find((w) => w.key === 'rolling')

  // 展开（宽列）比例条 tooltip：4 行对齐（缓存 / 输入 / 输出 / 缓存命中率）
  const barLabel = (() => {
    if (!today || todayTokens === 0) return ''
    return alignedRows([
      [t('footer.cacheTip', { n: '' }).trim(), fmtFull(cacheTokens)],
      [t('footer.inputTip', { n: '' }).trim(), fmtFull(inputTokens)],
      [t('footer.outputTip', { n: '' }).trim(), fmtFull(outputTokens)],
      [t('footer.cacheHitRate'), pctOf(cacheHitRate)],
    ])
  })()

  return (
    <div ref={rootRef} className={wide ? css.root : `${css.root} ${css.rail}`} data-usage-stats-footer>
      <UsageStatsPanel
        open={open}
        data={data}
        err={err}
        go={go}
        onClose={() => setOpen(false)}
        t={t}
      />
      {/* 宽列：Go 额度行在顶部，今日用量 badge 在其下方 */}
      {wide && goWindows.length > 0 && (
        <div className={css.goRow}>
          <span className={css.goLabel}>{t('go.label')}</span>
          {goWindows.map(goChip)}
        </div>
      )}
      {/* rail 折叠态：圆形按钮上方仅显示滚动 5 小时额度芯片 */}
      {!wide && railRolling !== undefined && (
        <div className={css.goRailChip}>{goChip(railRolling)}</div>
      )}
      <Tooltip label={wide ? t('footer.railAria', { tokens: fmtFull(todayTokens), calls: fmtFull(todayCalls) }) : railLabel} side="right" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.badge}
          data-active={open || undefined}
          aria-expanded={open}
          onClick={() => setOpen(v => !v)}
        >
          <span className={css.badgeIcon}><IconDataOutline16 size={wide ? 14 : 18} /></span>
          {wide && (
            <>
              <span className={css.badgeLabel}>{t('footer.todayLabel')}</span>
              <span className={css.badgeMeta}>
                {err
                  ? <span className={css.badgeErr}>--</span>
                  : (
                    <>
                      <span className={css.badgeCalls}>{fmtFull(todayCalls)}{t('panel.summary.callsSuffix')}</span>
                      <span className={css.badgeTokens}>· {fmt(todayTokens)}</span>
                      {missing && <span className={css.badgeErr}>{fmtFull(data?.failed ?? 0)}</span>}
                    </>
                  )}
              </span>
              {/* 三色比例条：缓存 / 输入 / 输出 */}
              {!err && todayTokens > 0 && (
                <Tooltip label={barLabel} side="top" delayMs={300} disabled={!wide}>
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
            </>
          )}
        </button>
      </Tooltip>
    </div>
  )
}