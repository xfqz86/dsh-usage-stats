/**
 * 用量统计的浏览器端入口：侧边栏底部动作（今日统计角标 + 模态窗详情）与会话标题旁的 session-id 徽标。
 *
 * - 注册 `sidebar.footer.action`（cell id `dsh-usage-stats`，order 1）与
 *   `conversation.session.header.utilities`（entry id `dsh-usage-stats-session-id`，order -20）。
 * - 底部角标宽列显示今日 tokens、调用数与三色比例条，56px rail 收窄为额度与今日迷你芯片，
 *   点击打开模态窗详情；数据经 usageStatsRemote() 取命名空间服务调用 usageStats/snapshot。
 * - 偏好设置（三额度开关/展示/间隔、会话徽标、模型重定向规则）来自服务端 profile 配置文档：
 *   表单取自 ctx.configForms 的 `usage-stats` 条目（schema 在 src/host/settings.ts），组件经
 *   useUsageSettings 读写；旧版本 localStorage 偏好由 migrateLegacySettings 一次性迁移。
 */

import { createElement } from 'react';

import { USAGE_SETTINGS_NAMESPACE } from '../utils.ts';

import { SessionIdBadge } from './components/SessionIdBadge.tsx';
import { NS, zh, en } from './locales.ts';
import { mountUsageStatsRemote } from './remote.ts';
import { attachUsageSettings, detachUsageSettings, migrateLegacySettings } from './settings.ts';
import { UsageStatsFooter } from './views/UsageStatsFooter.tsx';

import type { UsageSettings } from '../types.ts';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-slots';

/** 必需服务，为 cordis fiber inject：configForms 提供偏好设置的跨端存储。 */
export const inject = ['slots', 'locale', 'remote', 'configForms'];

/** 挂载 Remote 贡献、绑定偏好设置表单，并注册侧边栏底部动作。 */
export async function apply(ctx: ClientContext): Promise<void> {
  // 先挂载再注册界面：轮询与按钮回调只在挂载完成后发起调用。
  const disposeMount = await mountUsageStatsRemote(ctx);
  ctx.effect(() => disposeMount, 'dsh-usage-stats: remote 挂载');

  // 偏好设置表单：绑定后组件即可读写 profile 配置文档里 `usage-stats` 条目的字段。
  const settingsForm = ctx.configForms.get<UsageSettings>(USAGE_SETTINGS_NAMESPACE);
  attachUsageSettings(settingsForm);
  // 清理带表单身份：热重载时新表单已挂上，旧清理不得把它抹掉。
  ctx.effect(() => () => detachUsageSettings(settingsForm), 'dsh-usage-stats: 偏好设置表单');
  // 旧 localStorage 偏好迁移到配置文档；失败不影响界面（仍按服务端取值为准）。
  void migrateLegacySettings(settingsForm).catch(() => { /* 迁移失败：保持服务端取值 */ });

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-usage-stats: 文案字典');

  if (ctx.slots === undefined) return;

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-usage-stats',
    locale: NS,
    order: 1,
  }, (props) => createElement(UsageStatsFooter, props)));

  // order 取 -20 而不是与基座同值：列表插槽按 order 升序、同值保持注册顺序，
  // 基座的「用应用打开」entry（open-in-app，order -10）先于本插件注册，同值会把
  // 徽标挤到它右边；徽标要贴住会话标题、排在该插槽最左，必须落在 -10 之前。
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-usage-stats-session-id',
    locale: NS,
    order: -20,
  }, (props) => createElement(SessionIdBadge, props)));
}
