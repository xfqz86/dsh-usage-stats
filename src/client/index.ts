/**
 * 用量统计的浏览器端入口：侧边栏底部动作，包含今日统计角标与模态窗详情。
 *
 * - 注册到 `sidebar.footer.action` 列表插槽，属主为
 *   @deepseek-ai/dsh-client-ui-sidebar，cell id 为 `dsh-usage-stats`。
 * - 底部角标在宽列形态显示今日 tokens、调用数与三色比例条；56px rail 态
 *   收窄为仅圆形图标按钮，今日数字明细移入按钮 Tooltip；点击打开模态窗
 *   详情，包含汇总、模型拆分、会话列表、每日趋势曲线和热力图。
 * - 数据来自服务端 usageStats/snapshot（ctx.remote，经网关统一鉴权）。
 * - 偏好设置（三额度抓取开关、侧边栏展示开关、抓取间隔、模型统计重定向规则表）来自
 *   服务端用户设置文档：作用域取自 ctx.settingsScope 的 `usage-stats` 命名空间（服务端在
 *   src/host/settings.ts 注册），组件经 useUsageSettings 读写，不再用
 *   localStorage；旧版本的 localStorage 偏好由 migrateLegacySettings 一次性迁移。
 *
 * 所有类型均为 harness 自带：ClientContext 即 cordis Context，插槽表由
 * ui-sidebar 合并，slots 服务来自 ui-renderer，locale 服务来自 client-locale，
 * remote 服务来自 api-gateway，settingsScope 服务来自 client-ui-settings，
 * 各自通过 declare module 合并进 cordis Context。
 */

import { createElement } from 'react';

import { NS, zh, en } from './locales.ts';
import { mountUsageStatsRemote } from './remote.ts';
import { attachUsageSettings, detachUsageSettings, migrateLegacySettings } from './settings.ts';
import { UsageStatsFooter } from './views/UsageStatsFooter.tsx';

import type { UsageSettings } from '../types.ts';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-slots';

/** 必需服务，为 cordis fiber inject：settingsScope 提供偏好设置的跨端存储。 */
export const inject = ['slots', 'locale', 'remote', 'settingsScope'];

/** 挂载 Remote 贡献、绑定偏好设置作用域，并注册侧边栏底部动作。 */
export async function apply(ctx: ClientContext): Promise<void> {
  // 先挂载再注册界面：轮询与按钮回调只在挂载完成后发起调用。
  const disposeMount = await mountUsageStatsRemote(ctx);
  ctx.effect(() => disposeMount, 'dsh-usage-stats: remote 挂载');

  // 偏好设置作用域：绑定后组件即可读写服务端设置文档里的 `usage-stats` 段。
  const settingsScope = ctx.settingsScope.bind<UsageSettings>({ namespace: 'usage-stats' });
  attachUsageSettings(settingsScope);
  // 清理带作用域身份：热重载时新作用域已挂上，旧清理不得把它抹掉。
  ctx.effect(() => () => detachUsageSettings(settingsScope), 'dsh-usage-stats: 偏好设置作用域');
  // 旧 localStorage 偏好迁移到设置文档；失败不影响界面（仍按服务端取值为准）。
  void migrateLegacySettings(settingsScope).catch(() => { /* 迁移失败：保持服务端取值 */ });

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-usage-stats: 文案字典');

  if (ctx.slots === undefined) return;

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-usage-stats',
    locale: NS,
    order: 1,
  }, (props) => createElement(UsageStatsFooter, props)));
}
