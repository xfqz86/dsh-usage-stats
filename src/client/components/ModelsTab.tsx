/**
 * 模型 Tab：按模型/Provider 拆分表（含占比条）。
 * 独立成文件（一个组件一个文件）。
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ModelsTab.module.css'
import shared from './UsageStatsCommon.module.css'
import type { ModelStat } from '../useSnapshot.ts'
import { fmt, fmtFull, pctOf, usageTotal } from '../stats.ts'

/** 模型 Tab：按模型/Provider 拆分表（含占比条）。 */
export function ModelsTab({
  models, t,
}: {
  models: ModelStat[]
  t: PropsLocale<'dsh-usage-statistics'>['t']
}) {
  const maxModel = models.length
    ? Math.max(1, ...models.map((m) => usageTotal(m.usage)))
    : 1

  if (models.length === 0) {
    return <div className={shared.empty}>{t('state.noUsage')}</div>
  }

  return (
    <div className={shared.section}>
      <div className={shared.sectionHead}>
        <span className={shared.sectionLabel}>{t('panel.models')}</span>
      </div>
      <table className={shared.table}>
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
                <td className={shared.cellText}>
                  {m.model} <span className={shared.sub}>· {m.provider}</span>
                </td>
                <td className={shared.num}>{fmtFull(m.calls)}</td>
                <td className={shared.num}>{fmt(m.usage.input)}</td>
                <td className={shared.num}>{fmt(m.usage.output)}</td>
                <td className={shared.num}>{fmt(m.usage.cacheRead)}</td>
                <td className={`${shared.num} ${shared.strong}`}>{fmt(total)}</td>
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
