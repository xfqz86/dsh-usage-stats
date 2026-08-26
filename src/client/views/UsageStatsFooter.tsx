/**
 * 用量统计的侧边栏底部动作：渲染在 `sidebar.footer.action` 列表插槽
 * （设置按钮上方）的今日统计触发器。
 *
 * 合一按钮（宽列 / 折叠 rail 共用）：Go 额度与今日用量在同一按钮内，
 * 任意位置点击均打开模态窗详情（{@link UsageStatsPanel}）。
 *
 * 宽列：按钮内纵向两行——上行为带"Go 额度"标签的 OpenCode Go 订阅额度
 * 芯片（滚动 5 小时 / 本周 / 本月用量百分比，≥80% 预警、≥100% 超支，
 * hover 仅显示重置时间），下行为图标 + "今日" + 今日 tokens / 调用次数
 * + 三色比例条（缓存/输入/输出，hover 显示各类别具体数值）。
 * 56px rail（折叠列）：按钮内纵向堆叠——上方为滚动 5 小时额度芯片
 * （两行：短标签 + 百分比，居中，tooltip 给出三档窗口完整明细），
 * 下方为圆形图标（tooltip 放今日数字明细）。整块按钮任意位置可点。
 *
 * Go 额度抓取开关、侧边栏展示开关与抓取间隔来自偏好设置（useGoSettings /
 * settings.ts）：关闭抓取则不轮询（go 恒为 null，芯片自然不渲染）；侧边栏
 * 开关只影响底部芯片展示，不影响模态窗内额度详情。
 */

import { useEffect, useRef, useState } from 'react'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '../components/Tooltip.tsx'
import css from './UsageStatsFooter.module.css'
import { useSnapshot } from '../useSnapshot.ts'
import { useGoQuota, type GoWindow } from '../useGoQuota.ts'
import { useGoSettings } from '../useGoSettings.ts'
import { dayTotal, fmt, fmtFull, pctOf, todayOf } from '../stats.ts'
import { cacheTotal, goLevelOf, goPercent, goResetsAt } from '../../utils.ts'
import { UsageStatsPanel } from './UsageStatsPanel.tsx'

export type UsageStatsFooterProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'dsh-usage-stats'>

/** 单个额度窗口的展示条目（短/全名 + 窗口数据）。 */
interface GoWindowEntry {
  key: string
  short: string
  full: string
  win: GoWindow
}

export function UsageStatsFooter({ wide, t }: UsageStatsFooterProps) {
  const [open, setOpen] = useState(false)
  const [data, err, refreshSnapshot] = useSnapshot(4000)
  // Go 额度抓取开关 + 间隔来自偏好设置（默认开启、5 分钟）
  const [settings, updateSettings] = useGoSettings()
  const [go, refreshQuota] = useGoQuota(settings.goEnabled, settings.goFetchMinutes)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    const footerActionsDiv = root?.parentElement?.parentElement as HTMLElement | null
    if (!footerActionsDiv) {
      console.warn('[usage-stats] 未找到 footerActions 容器，flex 布局调整跳过（harness DOM 可能已变更）')
      return
    }
    const prev = footerActionsDiv.style.flexDirection
    footerActionsDiv.style.flexDirection = 'column'
    return () => {
      footerActionsDiv.style.flexDirection = prev
    }
  }, [])

  const today = todayOf(data?.series.all ?? [])
  const todayTokens = today ? dayTotal(today) : 0
  const todayCalls = today?.calls ?? 0
  const missing = (data?.failed ?? 0) > 0

  // 今日各分类 token 数（缓存 = cacheRead + cacheWrite，共用 utils.cacheTotal）
  const cacheTokens = cacheTotal(today ?? {})
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
  const resetsOf = (win: GoWindow): string => goResetsAt(t, win)

  // 单个额度芯片（宽列 chips）：短标签 + 百分比，按档位着色，
  // hover 仅显示重置时间（无重置时间时兜底显示窗口全名）。
  const goChip = ({ key, short, full, win }: GoWindowEntry) => {
    const pct = goPercent(win)
    const level = goLevelOf(pct)
    const cls = level === 'over' ? css.goChipOver : level === 'warn' ? css.goChipWarn : ''
    return (
      <Tooltip key={key} label={resetsOf(win) || full} side="top" delayMs={400}>
        <span className={`${css.goChip} ${cls}`}>{short} {pct}%</span>
      </Tooltip>
    )
  }

  // 折叠 rail tooltip（用量图标）：顺序与热力图一致（缓存、输入、输出、总计、缓存命中率、调用次数、平均每次调用）
  // 不含 Go 额度（Go 明细由上方额度芯片的 tooltip 承载），日期左对齐、其他标签左/数值右。
  const railContent = (() => {
    if (!today || todayTokens === 0) return t('footer.railEmpty')
    const avgPerCall = todayCalls > 0 ? Math.round(todayTokens / todayCalls) : 0
    const rows: Array<[string, string]> = [
      [t('table.cacheRead'), fmtFull(cacheTokens)],
      [t('table.input'), fmtFull(inputTokens)],
      [t('table.output'), fmtFull(outputTokens)],
      [t('table.total'), fmtFull(todayTokens)],
      [t('footer.cacheHitRate'), pctOf(cacheHitRate)],
      [t('table.calls'), fmtFull(todayCalls)],
      [t('table.avgPerCall'), fmtFull(avgPerCall)],
    ]
    return (
      <div style={{ minWidth: 200 }}>
        <div style={{ fontWeight: 600, marginBottom: 6, whiteSpace: 'nowrap', textAlign: 'left' }}>{t('footer.railHeader')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: 12, lineHeight: '18px' }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
              <span style={{ opacity: 0.85, textAlign: 'left' }}>{k}</span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    )
  })()

  // 折叠态芯片：只展示滚动 5 小时窗口（移在圆形按钮上方）。
  const railRolling = goWindows.find((w) => w.key === 'rolling')

  // 折叠态 Go 芯片 tooltip：完整三档窗口明细（用量百分比 + 重置时间），
  // 与宽列三档窗口同款内容，全部数据都在这里。
  // 富插槽示例：标题 + 网格两列（窗口名 / 百分比 + 重置时间），避免 \n 拼接换行不精准。
  const railQuotaContent = (() => {
    if (goWindows.length === 0) return ''
    return (
      <div style={{ minWidth: 180 }}>
        <div style={{ fontWeight: 600, marginBottom: 6, whiteSpace: 'nowrap' }}>{t('go.title')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: 12, lineHeight: '18px' }}>
          {goWindows.map((w) => (
            <div key={w.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
              <span style={{ opacity: 0.85, textAlign: 'left' }}>{w.full}</span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                {goPercent(w.win)}%{resetsOf(w.win) ? ` · ${resetsOf(w.win)}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  })()

  // 折叠态芯片档位：正常态用底色，预警 / 超支沿用芯片警示色。
  const railLevel = railRolling === undefined ? undefined : goLevelOf(goPercent(railRolling.win))
  const railCls = railLevel === 'over' ? css.goChipOver : railLevel === 'warn' ? css.goChipWarn : ''

  // 展开（宽列）比例条 tooltip：顺序与热力图一致（缓存、输入、输出、总计、缓存命中率、调用次数、平均每次调用）
  const barContent = (() => {
    if (!today || todayTokens === 0) return null
    const avgPerCall = todayCalls > 0 ? Math.round(todayTokens / todayCalls) : 0
    const rows: Array<[string, string]> = [
      [t('table.cacheRead'), fmtFull(cacheTokens)],
      [t('table.input'), fmtFull(inputTokens)],
      [t('table.output'), fmtFull(outputTokens)],
      [t('table.total'), fmtFull(todayTokens)],
      [t('footer.cacheHitRate'), pctOf(cacheHitRate)],
      [t('table.calls'), fmtFull(todayCalls)],
      [t('table.avgPerCall'), fmtFull(avgPerCall)],
    ]
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: 12, lineHeight: '18px', minWidth: 180 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
            <span style={{ opacity: 0.85, textAlign: 'left' }}>{k}</span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
    )
  })()

  const toggle = () => setOpen((v) => !v)
  const ariaLabel = t('footer.railAria', { tokens: fmtFull(todayTokens), calls: fmtFull(todayCalls) } as unknown as Record<string, unknown>)

  return (
    <div ref={rootRef} className={wide ? css.root : `${css.root} ${css.rail}`} data-usage-stats-footer>
      <UsageStatsPanel
        open={open}
        data={data}
        err={err}
        go={go}
        settings={settings}
        onUpdateSettings={updateSettings}
        onClose={() => setOpen(false)}
        onRefresh={() => { refreshSnapshot(); refreshQuota() }}
        onRefreshGo={refreshQuota}
        t={t}
      />
      {wide ? (
        // 宽列合一按钮：整块可点，含 Go 额度行 + 今日用量行 + 比例条
        <button
          type="button"
          className={css.unified}
          data-active={open || undefined}
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={toggle}
        >
          {settings.showGoInSidebar && go !== null && (
            <span className={css.unifiedGoRow}>
              <span className={css.goLabel}>{t('go.label')}</span>
              {go.status === 'ok' && goWindows.length > 0 && goWindows.map(goChip)}
              {go.status === 'ok' && goWindows.length === 0 && <span className={css.goChip}>—</span>}
              {go.status === 'no-key' && (
                <Tooltip label={t('go.notConfigured')} side="top" delayMs={400}>
                  <span className={css.goChip}>—</span>
                </Tooltip>
              )}
              {go.status === 'error' && (
                <Tooltip label={t('go.unavailable')} side="top" delayMs={400}>
                  <span className={`${css.goChip} ${css.goChipOver}`}>!</span>
                </Tooltip>
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
                    <span className={css.badgeTokens}>· {fmt(todayTokens)}</span>
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
        // 折叠 rail 合一按钮：Go 芯片在上、图标在下，整块可点
        <button
          type="button"
          className={css.railUnified}
          data-active={open || undefined}
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={toggle}
        >
          {settings.showGoInSidebar && go !== null && (
            <span className={css.goRailChip}>
              {go.status === 'ok' && railRolling !== undefined ? (
                <Tooltip content={railQuotaContent} side="top" delayMs={400}>
                  <span className={`${css.goRailChipBox} ${railCls}`}>
                    <span className={css.goRailChipLabel}>{railRolling.short}</span>
                    <span className={css.goRailChipPct}>{goPercent(railRolling.win)}%</span>
                  </span>
                </Tooltip>
              ) : go.status === 'no-key' ? (
                <Tooltip label={t('go.notConfigured')} side="top" delayMs={400}>
                  <span className={`${css.goRailChipBox}`}>
                    <span className={css.goRailChipLabel}>{t('go.label')}</span>
                    <span className={css.goRailChipPct}>—</span>
                  </span>
                </Tooltip>
              ) : go.status === 'error' ? (
                <Tooltip label={t('go.unavailable')} side="top" delayMs={400}>
                  <span className={`${css.goRailChipBox} ${css.goChipOver}`}>
                    <span className={css.goRailChipLabel}>{t('go.label')}</span>
                    <span className={css.goRailChipPct}>!</span>
                  </span>
                </Tooltip>
              ) : (
                <Tooltip content={railQuotaContent} side="top" delayMs={400}>
                  <span className={`${css.goRailChipBox}`}>
                    <span className={css.goRailChipLabel}>{t('go.label')}</span>
                    <span className={css.goRailChipPct}>—</span>
                  </span>
                </Tooltip>
              )}
            </span>
          )}
          <Tooltip content={railContent} side="right" delayMs={500}>
            <span className={css.railUnifiedIcon}><IconDataOutline16 size={18} /></span>
          </Tooltip>
        </button>
      )}
    </div>
  )
}
