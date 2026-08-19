/**
 * 会话 Tab：按会话表（标题/cwd/最近活跃，默认 8 条可展开）。
 * 独立成文件（一个组件一个文件）。
 */

import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './UsageStatsPanel.module.css'
import type { SessionStat } from './useSnapshot.ts'
import { fmt, fmtFull, fullDayLabel, shortId, usageTotal } from './stats.ts'

/** 会话 Tab：按会话表（默认 8 条，可展开全部）。 */
export function SessionsTab({
  sessionsList, t,
}: {
  sessionsList: SessionStat[]
  t: PropsLocale<'dsh-usage-statistics'>['t']
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
