/**
 * OpenCode Go 订阅额度查询：滚动 5 小时 / 本周 / 本月三档用量百分比
 * 与重置时间，端点为 `GET https://opencode.ai/zen/go/v1/usage`。
 *
 * key 仅走 DSH 凭据中心 `OPENCODE_GO_API_KEY`；401/403 读响应体，`error.type` 为
 * EntitlementError（已配置 Key 但未开通订阅）判 no-plan，其余仍判 no-key；TTL 缓存与
 * 单飞见 quota.ts。协议与状态语义见 docs/API.md §3.1。
 * 纯数据模块：所有失败都返回带 status 的结构化结果，由客户端本地化文案。
 */
import { QUOTA_UA, createQuotaQuery, resolveFirstKey } from './quota.ts';

import type { GoQuota, GoWindow } from '../types.ts';
import type { CredentialsService } from './quota.ts';

/** 协议类型单一定义在 types.ts，此处 re-export 保持对外引用面。 */
export type { GoQuota, GoWindow } from '../types.ts';
export type { CredentialsService } from './quota.ts';

/** OpenCode Go 官方额度端点，固定域名。 */
const GO_QUOTA_URL = 'https://opencode.ai/zen/go/v1/usage';

/** 官方错误信封（Anthropic 风格）：401/403 响应体形如 { type:'error', error:{ type, message } }。 */
interface GoErrorEnvelope {
  type?: unknown
  error?: { type?: unknown; message?: unknown } | null
}

/** 解析 OpenCode Go API Key：仅走 DSH 凭据中心 OPENCODE_GO_API_KEY。 */
async function resolveGoKeyWithCredentials(credentials?: CredentialsService): Promise<string | null> {
  return resolveFirstKey(credentials, ['OPENCODE_GO_API_KEY']);
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
        'user-agent': QUOTA_UA,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) {
      // 已配置 Key 但被官方拒绝：读响应体区分「未开通订阅」（EntitlementError）
      // 与「Key 无效」，前者属预期场景，客户端以「未开通订阅」提示而非误导性的
      // 「未配置 API Key」；响应体非 JSON 或结构异样时维持 no-key。
      const body = (await response.json().catch(() => null)) as GoErrorEnvelope | null;
      const err = body !== null && typeof body === 'object' && body.error !== null && typeof body.error === 'object'
        ? body.error
        : null;
      if (err !== null && err.type === 'EntitlementError') {
        return { status: 'no-plan', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null };
      }
      // 其余 401/403（Key 无效等）：维持 no-key 语义。
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

/**
 * 带 TTL 缓存与单飞的额度查询，路由每次调用都走这里。
 *
 * @param intervalMinutes 客户端抓取间隔，单位分钟；有效 TTL 见共享公式，
 *   未提供时用默认 5 分钟。
 * @param force 为 true 时绕过 TTL 缓存强制重新抓取，供概览 Go 磁贴的“立即
 *   刷新”按钮使用；仍走单飞，避免并发打官方端点。
 * @param credentials DSH 凭据中心，可选，缺席时返回 no-key，仅 OPENCODE_GO_API_KEY。
 */
export const queryGoQuota = createQuotaQuery((credentials?: CredentialsService) => fetchGoQuota(credentials));
