/**
 * 服务端（Host）的插件偏好设置：把 `usage-stats` 命名空间注册进 harness 的
 * 用户设置体系（ctx.settings，由 dsh-settings-file 落到 `$DSH_HOME/settings.yaml`），
 * 偏好因此属于部署而不是某一个浏览器。
 *
 * 注册遵循官方范式（ui-theme 等）：schema 提供每个字段的默认值，设置服务按
 * 「schema 默认值 → 组合 base → 用户文档」顺序解析；用户文档只存显式改过的
 * 字段（浏览器端 settingsScope 走路径写入），未写过的字段继续跟随默认值。
 * 同一个 schema 随 describe 下发浏览器，settingsScope 用它校验收到的取值。
 *
 * `settings` 服务是可选依赖：不进 UsageStatsService.inject，缺席时（无设置
 * 后端的部署）不注册命名空间，浏览器端 settingsScope 报 unavailable，偏好
 * 退化为仅当前页面生效。
 */

import Schema from '@deepseek-ai/schemastery';

import {
  DEEPSEEK_FETCH_DEFAULT_MINUTES,
  GO_FETCH_DEFAULT_MINUTES,
  USAGE_SETTINGS_DEFAULTS,
  USAGE_SETTINGS_NAMESPACE,
  ZAI_FETCH_DEFAULT_MINUTES,
} from '../utils.ts';

import type { UsageSettings } from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-settings';

/**
 * 偏好设置 schema：字段默认值与 USAGE_SETTINGS_DEFAULTS 同源（utils.ts），
 * 数值字段只约束类型，不在 schema 里设 min——手改 settings.yaml 写出越界间隔
 * 时，整段失效回退默认值远不如夹到下限友好，夹取统一由浏览器端归一化负责
 * （clampGoFetchMinutes 等，下限 3 分钟）。
 *
 * modelRedirects 是模型统计重定向规则表：每条规则四个字符串字段各自带空串
 * 默认值，手写文档漏字段时按空串解析而不是让整段命名空间判非法；规则内容
 * 不在 schema 里设 min/长度约束，条数上限与空白清洗由浏览器端的
 * normalizeModelRedirects 负责（与服务端解析值同源，见 utils.ts）。
 */
export const UsageSettingsSchema: Schema<UsageSettings> = Schema.object({
  goEnabled: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.goEnabled),
  showGoInSidebar: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showGoInSidebar),
  goFetchMinutes: Schema.number().default(GO_FETCH_DEFAULT_MINUTES),
  deepseekEnabled: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.deepseekEnabled),
  showDeepSeekInSidebar: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showDeepSeekInSidebar),
  deepseekFetchMinutes: Schema.number().default(DEEPSEEK_FETCH_DEFAULT_MINUTES),
  zaiEnabled: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.zaiEnabled),
  showZaiInSidebar: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showZaiInSidebar),
  zaiFetchMinutes: Schema.number().default(ZAI_FETCH_DEFAULT_MINUTES),
  modelRedirects: Schema.array(Schema.object({
    fromProvider: Schema.string().default(''),
    fromModel: Schema.string().default(''),
    toProvider: Schema.string().default(''),
    toModel: Schema.string().default(''),
  })).default([]),
});

/**
 * 把 `usage-stats` 命名空间注册到设置服务；服务缺席时静默跳过。
 * 注册是插件 fiber 上的 effect，插件卸载即注销命名空间。
 *
 * 注册失败（命名空间被别的插件占用、schema 被服务拒绝）只降级偏好：浏览器端
 * settingsScope 随即报 unavailable，设置页如实提示改动不会保存。统计是插件的
 * 主职责，不能因为偏好这一附加能力注册失败就整个插件连同账本一起挂掉。
 * @param ctx - 服务端插件上下文。
 */
export function registerUsageSettings(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.register(USAGE_SETTINGS_NAMESPACE, UsageSettingsSchema);
    } catch (error) {
      console.warn('[usage-stats] 偏好设置命名空间注册失败，偏好退化为仅当前页面生效', error);
    }
  });
}
