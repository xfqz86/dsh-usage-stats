/**
 * 服务端（Host）的插件偏好设置 schema：`usage-stats` 插件条目（cordis.patch.yml
 * 插入的 Loader 条目，id 即 USAGE_SETTINGS_NAMESPACE）的 Config，被 harness 设置
 * 服务（ctx.settings）投影成设置表单，偏好因此落在 profile 配置文档里、属于部署而不是某一个浏览器。
 *
 * 每字段必须标 `.volatile()`（否则不投影成表单、也不接受写入）；字段名与默认值必须
 * 与 USAGE_SETTINGS_DEFAULTS 对齐，`test/pure.mjs` 直接断言。schema 只约束类型、不设
 * 间隔下限——越界值夹取由浏览器端归一化负责（见 docs/API.md §5）。
 *
 * 旧设置文档（`$DSH_HOME/settings.yaml.imported`）里本插件那段的回收见
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
 * 回收卡在旧设置文档里的偏好（基座导入失败后的收尾）：写在 Loader 落定之后，
 * settings 服务缺席或组合里没有 Loader 时静默跳过。
 *
 * 一次性语义与落标记/不落标记各种现场的完整说明见 docs/API.md §5；这里只做执行：
 * 读 `.imported` 里本插件那段 → 条目已有用户片段则让位 → 写入与标记，写失败只记 warn。
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
