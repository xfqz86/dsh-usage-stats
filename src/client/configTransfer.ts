/**
 * 配置串编解码：把整份偏好打包成可复制粘贴的 Base64 文本，并反向解析。
 *
 * 纯浏览器端能力——不新增 Remote 方法、不走线路、不落账本；写入落点由
 * settings.ts 的整份替换负责，界面接线在设置 Tab 的配置迁移区。载荷格式与
 * 失败语义的唯一权威是 docs/API.md §5.1。编解码只用 TextEncoder/TextDecoder
 * 与 btoa/atob（浏览器与 Node 22 都有），不引 Buffer，两个运行时都能直跑。
 *
 * 纯逻辑模块，无 React，可单测。
 */
import { normalizeUsageSettings, settingsValueEqual, USAGE_SETTINGS_DEFAULTS } from '../utils.ts';

import type { UsageSettings } from '../types.ts';

/** 载荷格式标识：不等于此值的载荷一律 unknown-format，挡住别的插件的配置串。 */
export const CONFIG_TRANSFER_FORMAT = 'dsh-usage-stats';

/** 当前载荷版本：读到别的版本直接拒绝，不猜旧/新字段语义。 */
export const CONFIG_TRANSFER_VERSION = 1;

/** 解码失败原因：浏览器端按码选本地化文案，错误码本身不进线路。 */
export type ConfigTransferError = 'empty' | 'invalid-base64' | 'invalid-payload' | 'unknown-format' | 'unsupported-version';

/** 解码结果：成功给出归一化后的整份偏好与导出时间（缺失或非字符串为 null）。 */
export type ConfigTransferResult =
  | { ok: true; settings: UsageSettings; exportedAt: string | null }
  | { ok: false; error: ConfigTransferError };

/** 标准 Base64 字母表与最多两个填充符：先判字符再补填充，让缺失填充成为唯一被容忍的长度异常。 */
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

/** JSON 解析结果里的普通对象判定：排除 null 与数组，其余对象都按记录读字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 文本 → 标准 Base64（带填充）；逐字节拼二进制串，避免 Buffer。 */
function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 标准 Base64 → UTF-8 文本；长度非法时 atob 抛异常，由调用方兜住转成 invalid-base64。 */
function base64Decode(text: string): string {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * 把整份偏好评成配置串：紧凑 JSON → UTF-8 → Base64 单行文本。
 *
 * settings 先经 normalizeUsageSettings 归一化，导入方据此逐字段还原（含等于默认
 * 值的字段，故「导出 → 导入」等价于整份覆盖）。`exportedAt` 只作诊断。
 */
export function encodeConfigTransfer(settings: UsageSettings, exportedAt: Date = new Date()): string {
  const payload = {
    format: CONFIG_TRANSFER_FORMAT,
    version: CONFIG_TRANSFER_VERSION,
    exportedAt: exportedAt.toISOString(),
    settings: normalizeUsageSettings(settings),
  };
  return base64Encode(JSON.stringify(payload));
}

/**
 * 解析配置串：容错空白/换行、URL 安全字母表与缺失填充，其余按失败语义逐码返回。
 *
 * 校验顺序即错误码优先级：空串 → 字符集 → JSON → format → version → settings 形状。
 * 成功时 settings 再经归一化，手改过的配置串不会把坏值带进界面。
 */
export function decodeConfigTransfer(text: string): ConfigTransferResult {
  const compact = text.replace(/\s+/g, '');
  if (compact === '') return { ok: false, error: 'empty' };
  const standard = compact.replace(/-/g, '+').replace(/_/g, '/');
  if (!BASE64_BODY.test(standard)) return { ok: false, error: 'invalid-base64' };
  let json: string;
  try {
    json = base64Decode(standard + '='.repeat((4 - (standard.length % 4)) % 4));
  } catch {
    return { ok: false, error: 'invalid-base64' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid-payload' };
  }
  if (!isRecord(parsed) || parsed.format !== CONFIG_TRANSFER_FORMAT) return { ok: false, error: 'unknown-format' };
  if (parsed.version !== CONFIG_TRANSFER_VERSION) return { ok: false, error: 'unsupported-version' };
  if (!isRecord(parsed.settings)) return { ok: false, error: 'invalid-payload' };
  const exportedAt = typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null;
  return { ok: true, settings: normalizeUsageSettings(parsed.settings as Partial<UsageSettings>), exportedAt };
}

/**
 * 逐字段比较两份偏好，按 USAGE_SETTINGS_DEFAULTS 的键序返回不相等的字段名。
 *
 * 键序即 schema 声明序，界面据此稳定列出「将被覆盖的项」；规则表按值比较
 * （归一化每次都新建数组，引用比较会把等值规则表误判为改动）。
 */
export function changedSettingFields(current: UsageSettings, next: UsageSettings): (keyof UsageSettings)[] {
  const changed: (keyof UsageSettings)[] = [];
  for (const field of Object.keys(USAGE_SETTINGS_DEFAULTS) as (keyof UsageSettings)[]) {
    if (!settingsValueEqual(current[field], next[field])) changed.push(field);
  }
  return changed;
}
