/**
 * OpenCode Go 订阅额度查询：滚动 5 小时 / 本周 / 本月三档用量百分比
 * 与重置时间，端点为 `GET https://opencode.ai/zen/go/v1/usage`。
 *
 * 机制要点：
 *   - 官方固定域名端点；Bearer key + 浏览器 UA，否则会被 opencode.ai 前置
 *     Cloudflare 以 error 1010 拦截。
 *   - key 解析：仅走 DSH 凭据中心 `OPENCODE_GO_API_KEY`，即 `ctx.credentials`，
 *     由 `~/.dsh/.credentials.yaml` 等统一托管，不直接读 `process.env`。
 *   - 结果带 TTL 缓存 5 分钟与单飞机制，并发请求只打一次官方端点。
 *
 * GoWindow / GoQuota 协议类型定义在 types.ts，与客户端 useGoQuota 统一。
 * 纯数据模块：请求失败 / 未配置 key 都返回带 status 的结构化结果，由
 * 客户端按 status 本地化文案，不在服务端拼用户文案。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';

import type { GoQuota, GoWindow } from '../types.ts';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';

/** 协议类型单一定义在 types.ts，此处 re-export 保持对外引用面。 */
export type { GoQuota, GoWindow } from '../types.ts';

/** DSH 凭据中心服务，为 Context.credentials 合并类型，cordis 可选注入，运行时可能缺席。 */
export type CredentialsService = CredentialProvider;

/** OpenCode Go 官方额度端点，固定域名。 */
const GO_QUOTA_URL = 'https://opencode.ai/zen/go/v1/usage';
/** 浏览器 UA：避免被 opencode.ai 前置 Cloudflare 以 error 1010 拦截。 */
const GO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** 服务端强制下限：官方额度端点任何情况下不低于 3 分钟打一次，与客户端设置下限对齐。 */
export const GO_MIN_FETCH_MS = 3 * 60 * 1000;
/** 结果缓存上限：默认 5 分钟；客户端可按抓取间隔调短有效缓存。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 解析 OpenCode Go API Key：仅走 DSH 凭据中心 OPENCODE_GO_API_KEY。 */
export async function resolveGoKeyWithCredentials(credentials?: CredentialsService): Promise<string | null> {
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const ref = credentialRef('OPENCODE_GO_API_KEY');
      const resolved = await credentials.resolve(ref);
      if (resolved && typeof resolved.value === 'string' && resolved.value.trim().length > 0) return resolved.value.trim();
    } catch {
      // 凭据解析失败：返回无 key
    }
  }
  return null;
}

/** 归一化单个额度窗口，包含 percent 和 resetsAt，字段缺失或非法返回 null。 */
function normalizeGoWindow(raw: unknown): GoWindow | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { percent, resetsAt } = raw as { percent?: unknown; resetsAt?: unknown };
  const p = Number(percent);
  if (!Number.isFinite(p)) return null;
  return { percent: p, resetsAt: typeof resetsAt === 'string' ? resetsAt : '' };
}

/** 实时查询 OpenCode Go 额度，无缓存。 */
export async function fetchGoQuota(credentials?: CredentialsService): Promise<GoQuota> {
  const key = await resolveGoKeyWithCredentials(credentials);
  if (key === null) {
    // 未配置 Key 属预期场景：客户端以中性提示展示。
    return { status: 'no-key', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null };
  }
  try {
    const response = await fetch(GO_QUOTA_URL, {
      headers: {
        authorization: `Bearer ${key}`,
        'user-agent': GO_UA,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) {
      // 无订阅 / Key 无效：同样属预期场景。
      return { status: 'no-key', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null };
    }
    if (!response.ok) {
      return { status: 'error', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null };
    }
    const data = (await response.json()) as { usage?: { rolling?: unknown; weekly?: unknown; monthly?: unknown } };
    const usage = data?.usage;
    if (usage === null || typeof usage !== 'object') {
      return { status: 'error', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null };
    }
    return {
      status: 'ok',
      fetchedAt: Date.now(),
      rolling: normalizeGoWindow(usage.rolling),
      weekly: normalizeGoWindow(usage.weekly),
      monthly: normalizeGoWindow(usage.monthly),
    };
  } catch {
    return { status: 'error', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null };
  }
}

let cache: { at: number; quota: GoQuota } | null = null;
let inflight: Promise<GoQuota> | null = null;

/**
 * 带 TTL 缓存与单飞的额度查询，路由每次调用都走这里。
 *
 * @param intervalMinutes 客户端抓取间隔，单位分钟；有效缓存为 5 分钟上限
 *   与 3 分钟下限和请求间隔较大值之中的较小值，让实际打官方端点的频率与
 *   设置一致，且不短于 3 分钟；未提供时用默认 5 分钟。
 * @param force 为 true 时绕过 TTL 缓存强制重新抓取，供概览 Go 磁贴的“立即
 *   刷新”按钮使用；仍走单飞，避免并发打官方端点。
 * @param credentials DSH 凭据中心，必选，仅 OPENCODE_GO_API_KEY。
 */
export async function queryGoQuota(intervalMinutes?: number, force = false, credentials?: CredentialsService): Promise<GoQuota> {
  const effectiveTtlMs =
    typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes)
      ? Math.min(CACHE_TTL_MS, Math.max(GO_MIN_FETCH_MS, Math.round(intervalMinutes * 60 * 1000)))
      : CACHE_TTL_MS;
  const now = Date.now();
  if (!force && cache !== null && now - cache.at < effectiveTtlMs) return cache.quota;
  if (force && cache !== null && now - cache.at < GO_MIN_FETCH_MS && inflight === null) {
    // force 距上次抓取过近且无进行中的请求：打官方端点频率受强制下限保护，
    // 返回上一次结果即可，避免刷爆官方额度接口。
    return cache.quota;
  }
  if (inflight === null) {
    inflight = fetchGoQuota(credentials).then((quota) => {
      cache = { at: Date.now(), quota };
      return quota;
    }).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
