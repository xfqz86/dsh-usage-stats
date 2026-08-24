/**
 * 模型 Tab：按模型/Provider 拆分表（含占比条）。
 * 独立成文件（一个组件一个文件）。
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ModelsTab.module.css'
import shared from '../components/UsageStatsCommon.module.css'
import type { ModelStat } from '../useSnapshot.ts'
import { fmt, fmtFull, pctOf, usageTotal } from '../stats.ts'

/** 模型 Tab：按模型/Provider 拆分表（含占比条）。 */
export function ModelsTab({
  models, t,
}: {
  models: ModelStat[]
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  if (models.length === 0) {
    return <div className={shared.empty}>{t('state.noUsage')}</div>
  }

  // 占比分母应为全量总和（非最大值），并用最大余数法修正 1 位小数舍入误差，保证总和为 100%
  const sumTotal = models.reduce((s, m) => s + usageTotal(m.usage), 0)
  let shares: number[] = []
  if (sumTotal > 0) {
    const raws = models.map((m) => (usageTotal(m.usage) / sumTotal) * 100)
    const floors = raws.map((v) => Math.floor(v * 10) / 10)
    const sumFloorsTenths = floors.reduce((a, b) => a + Math.round(b * 10), 0)
    let remainingTenths = 1000 - sumFloorsTenths
    // 按小数余数降序，把剩余的 0.1% 单位分给余数最大的项
    const order = raws
      .map((v, i) => ({ i, frac: v * 10 - Math.floor(v * 10) }))
      .sort((a, b) => b.frac - a.frac)
    const result = [...floors]
    for (let k = 0; k < remainingTenths && k < order.length; k += 1) {
      const idx = order[k].i
      result[idx] = Math.round((result[idx] + 0.1) * 10) / 10
    }
    shares = result
  } else {
    shares = models.map(() => 0)
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
            <th>{t('table.share')}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m, idx) => {
            const total = usageTotal(m.usage)
            const share = shares[idx] ?? 0
            return (
              <tr key={m.provider + '\u0000' + m.model}>
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
