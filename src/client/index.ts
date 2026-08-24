/**
 * 用量统计的浏览器端入口：侧边栏底部动作（今日统计角标）+ 模态窗详情。
 *
 * - 注册到 `sidebar.footer.action` 列表插槽（属主为
 *   @deepseek-ai/dsh-client-ui-sidebar），cell id `dsh-usage-stats`。
 * - 底部角标在宽列形态显示今日 tokens/调用数与三色比例条；56px rail 态
 *   收窄为仅圆形图标按钮，今日数字明细移入按钮 Tooltip；点击打开模态窗
 *   详情（汇总、模型拆分、会话列表、每日趋势曲线/热力图）。
 * - 数据来自服务端 POST /usage-stats/api/snapshot。
 *
 * 所有类型均为 harness 自带：ClientContext 来自客户端运行时，插槽表由
 * ui-sidebar 合并，slots 服务来自 ui-slots，locale 服务来自 client-locale
 * （各自通过 declare module 合并进 cordis Context）。
 */

import { createElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NS, zh, en } from './locales.ts'
import { UsageStatsFooter } from './views/UsageStatsFooter.tsx'

/** 必需服务（cordis fiber inject）。 */
export const inject = ['slots', 'locale']

/** 挂载侧边栏底部动作。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-usage-stats: 文案字典')

  if (ctx.slots === undefined) return

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-usage-stats',
    locale: NS,
    order: 1,
  }, (props) => createElement(UsageStatsFooter, props)))
}
