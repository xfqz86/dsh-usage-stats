/**
 * 服务端（Host）的插件偏好设置 schema：`usage-stats` 插件条目（cordis.patch.yml
 * 插入的 Loader 条目，id 即 USAGE_SETTINGS_NAMESPACE）的 Config，被 harness 设置
 * 服务（ctx.settings）投影成设置表单，偏好因此落在 profile 配置文档里、属于部署
 * 而不是某一个浏览器。
 *
 * 注册方式与官方范式（llm-deepseek、ui-theme 等）一致：插件条目自带 Config schema，
 * 设置服务按「schema 默认值 → 组合 base → profile 片段」顺序解析；用户片段只存显式
 * 改过的字段（浏览器端 ConfigForm 走路径写入），未写过的字段继续跟随默认值。同一个
 * schema 随 describe 下发浏览器，ConfigForm 用它校验收到的取值。
 *
 * 每个字段必须标 `.volatile()`：设置服务只把 volatile 字段投影成表单，也只有
 * volatile 路径接受写入（packages/settings/settings/src/schema.ts）。字段名与默认值
 * 必须与 USAGE_SETTINGS_DEFAULTS 逐一对齐，test/pure.mjs 直接断言这一点。
 *
 * 旧版本把偏好注册成 `$DSH_HOME/settings.yaml` 的独立命名空间。基座升级时会把该文档
 * 一次性导入 profile（改名 settings.yaml.imported），但那一版插件没有 Config schema，
 * 导入到本条目时必然失败且不重试——于是旧偏好只剩在那份 .imported 副本里。收尾见
 * {@link recoverLegacyUsageSettings}。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Schema from '@deepseek-ai/schemastery';
import { parse } from 'yaml';

import {
  DEEPSEEK_FETCH_DEFAULT_MINUTES,
  diffFromDefaults,
  GO_FETCH_DEFAULT_MINUTES,
  normalizeUsageSettings,
  USAGE_SETTINGS_DEFAULTS,
  USAGE_SETTINGS_NAMESPACE,
  ZAI_FETCH_DEFAULT_MINUTES,
} from '../utils.ts';

import { storageDir } from './ledger.ts';
import { getDshHome } from './logs.ts';

import type { UsageSettings } from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-settings';

/**
 * 偏好设置 schema：字段默认值与 USAGE_SETTINGS_DEFAULTS 同源（utils.ts），
 * 数值字段只约束类型，不在 schema 里设 min——手改 profile 文档写出越界间隔时，
 * 整段失效回退默认值远不如夹到下限友好，夹取统一由浏览器端归一化负责
 * （clampGoFetchMinutes 等，下限 3 分钟）。
 *
 * modelRedirects 是模型统计重定向规则表：每条规则四个字符串字段各自带空串
 * 默认值，手写文档漏字段时按空串解析而不是让整段判非法；规则内容不在 schema 里设
 * min/长度约束，条数上限与空白清洗由浏览器端的 normalizeModelRedirects 负责
 * （与服务端解析值同源，见 utils.ts）。
 */
export const UsageSettingsSchema = Schema.object({
  goEnabled: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.goEnabled).volatile(),
  showGoInSidebar: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showGoInSidebar).volatile(),
  goFetchMinutes: Schema.number().default(GO_FETCH_DEFAULT_MINUTES).volatile(),
  deepseekEnabled: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.deepseekEnabled).volatile(),
  showDeepSeekInSidebar: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showDeepSeekInSidebar).volatile(),
  deepseekFetchMinutes: Schema.number().default(DEEPSEEK_FETCH_DEFAULT_MINUTES).volatile(),
  zaiEnabled: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.zaiEnabled).volatile(),
  showZaiInSidebar: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showZaiInSidebar).volatile(),
  zaiFetchMinutes: Schema.number().default(ZAI_FETCH_DEFAULT_MINUTES).volatile(),
  showSessionId: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showSessionId).volatile(),
  modelRedirects: Schema.array(Schema.object({
    fromProvider: Schema.string().default(''),
    fromModel: Schema.string().default(''),
    toProvider: Schema.string().default(''),
    toModel: Schema.string().default(''),
  })).default([]).volatile(),
});

/** 废弃的用户设置文档文件名（旧版本偏好所在），回收只读它的 .imported 遗留副本。 */
const LEGACY_SETTINGS_FILE = 'settings.yaml';
/**
 * 旧设置文档的「已处理」标记（写在插件存储目录）：标记在即不再看旧文档，旧值不会复活。
 * 落标记的是三种已有定论的现场，见 {@link recoverLegacyUsageSettings}。
 */
const LEGACY_RECOVERY_MARKER = 'legacy-settings-recovered.json';

/** 标记记录的处置结果：回收成功 / 条目已有用户偏好而让位 / 旧文档里没有本插件那段。 */
type LegacyRecoveryAction = 'recovered' | 'skipped-user-config' | 'nothing-to-restore';

/**
 * 把旧设置文档里的 `usage-stats` 段转成路径写入补丁：段不是普通对象时给空补丁，
 * 已知字段按 normalizeUsageSettings 归一化，与默认值相同的字段丢掉（配置文档只存
 * 显式改过的字段）。
 * @param section - 旧设置文档里该段的原始解析结果。
 * @returns 待写入 profile 的字段补丁；无可回收内容时为空对象。
 */
export function legacySettingsPatch(section: unknown): Partial<UsageSettings> {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return {};
  return diffFromDefaults(normalizeUsageSettings(section as Partial<UsageSettings>));
}

/** 解析旧设置文档文本并取出本插件那一段；文档为空或不是映射时给 undefined。 */
function legacySectionOf(text: string): unknown {
  const document = parse(text) as Record<string, unknown> | null;
  if (document === null || typeof document !== 'object') return undefined;
  return document[USAGE_SETTINGS_NAMESPACE];
}

/** 写下「旧文档已处理完毕」标记：内容只作诊断，判断只看文件在不在。 */
function markLegacySettingsHandled(marker: string, source: string, action: LegacyRecoveryAction, fields: string[]): void {
  mkdirSync(storageDir(), { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ handledAt: new Date().toISOString(), source, action, fields })}\n`);
}

/**
 * 回收卡在旧设置文档里的偏好（基座导入失败后的收尾）。
 *
 * 基座的一次性导入在 Loader 落定后跑，且**改名后不重试**：升级那一刻插件若还没有
 * Config schema（0.4.4 及更早），本条目那段导入必然失败，`settings.yaml` 已被改名成
 * `settings.yaml.imported`，此后永不重试——用户旧偏好就只能靠这一次回收搬回来。
 *
 * **同一份旧文档只处理一次**：处理完毕即写下 {@link LEGACY_RECOVERY_MARKER} 标记，
 * 此后启动直接返回——标记记的是「旧文档已有定论」，不要求这次真的搬了值，否则用户
 * 把条目清空时旧值会在之后某次启动突然复活。三种落标记的现场：①回收成功；②条目已有
 * 用户片段（用户在界面上改过值，回收让位不覆盖，但不再反复尝试）；③旧文档里没有本
 * 条目那段。其余现场都没有定论，一律不落标记、下次启动重看：`settings.yaml` 还在
 * （基座自己会导，不抢写——两侧同时写有先后竞态）、`.imported` 不存在、条目不在
 * describe 里（插件被禁用或没装）、写入被设置服务拒绝。
 *
 * 写在 Loader 落定之后：条目的设置表单要等本条目 fiber 就绪才出现在 describe 里，
 * 与基座导入同一时机；`settings` 缺席（无设置后端的部署）、组合里没有 Loader 时静默跳过。
 * @param ctx - 服务端插件上下文。
 */
export function recoverLegacyUsageSettings(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (typeof settings?.describe !== 'function' || typeof settings.update !== 'function') return;
    const loader = ctx.get('loader');
    if (loader === undefined) return;
    const run = async (): Promise<void> => {
      await loader.await();
      const marker = join(storageDir(), LEGACY_RECOVERY_MARKER);
      if (existsSync(marker)) return;
      const home = getDshHome();
      if (existsSync(join(home, LEGACY_SETTINGS_FILE))) return;
      const imported = join(home, `${LEGACY_SETTINGS_FILE}.imported`);
      if (!existsSync(imported)) return;
      const patch = legacySettingsPatch(legacySectionOf(readFileSync(imported, 'utf8')));
      const fields = Object.keys(patch);
      const entry = settings.describe().find((candidate) => candidate.ns === USAGE_SETTINGS_NAMESPACE);
      if (entry === undefined) return;
      // user 是条目当前的用户片段：字段存在即用户在界面上改过值，回收一律让位。
      const userConfigured = entry.user !== undefined && entry.user !== null && Object.keys(entry.user).length > 0;
      if (fields.length === 0 || userConfigured) {
        markLegacySettingsHandled(marker, imported, userConfigured ? 'skipped-user-config' : 'nothing-to-restore', fields);
        ctx.logger?.info('usage-stats: 旧偏好文档已处理，不再回收（%s）', imported);
        return;
      }
      await settings.update(USAGE_SETTINGS_NAMESPACE, patch);
      markLegacySettingsHandled(marker, imported, 'recovered', fields);
      ctx.logger?.info('usage-stats: 已从 %s 回收旧版偏好（%s）', imported, fields.join(', '));
    };
    void run().catch((error: unknown) => {
      ctx.logger?.warn('usage-stats: 旧版偏好回收失败（偏好保持默认值，可在设置页重设）');
      ctx.logger?.warn(error);
    });
  });
}
