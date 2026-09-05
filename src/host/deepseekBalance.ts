/**
 * DeepSeek 余额查询：通过 `GET https://api.deepseek.com/user/balance` 获取当前余额。
 *
 * 机制要点：
 *   - 官方固定域名端点，使用 Bearer key 与浏览器 UA，与 GoQuota 同款以防前置拦截。
 *   - key 解析仅走 DSH 凭据中心，支持 `DEEPSEEK_API_KEY` 等，由 `ctx.credentials` 统一托管，不直接读 `process.env` 或配置文件。
 *   - 结果带 TTL 缓存与单飞，TTL 默认 5 分钟，单飞即并发请求只打一次官方端点。
 *   - is_available 归一化：仅当官方返回 boolean true 时为 true，其余按 false。
 *   - 金额字段如 total_balance 等为字符串小数，归一化保留字符串避免浮点丢失。
 *
 * DeepSeekBalance / DeepSeekBalanceInfo 协议类型定义在 types.ts，与客户端 useDeepSeekBalance 统一。
 * 纯数据模块：请求失败 / 未配置 key 都返回带 status 的结构化结果，由
 * 客户端按 status 本地化文案，不在服务端拼用户文案。
 * 本功能不写入 ledger，仅只读查询与内存缓存。
 */
import { QUOTA_MIN_FETCH_MS } from '../utils.ts';

import { QUOTA_UA, createQuotaQuery, resolveFirstKey } from './quota.ts';

import type { DeepSeekBalance, DeepSeekBalanceInfo } from '../types.ts';
import type { CredentialsService } from './quota.ts';

/** 协议类型单一定义在 types.ts，此处 re-export 保持对外引用面。 */
export type { DeepSeekBalance, DeepSeekBalanceInfo } from '../types.ts';
export type { CredentialsService } from './quota.ts';

/** DeepSeek 官方余额端点，固定域名。 */
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
/** 服务端强制下限：复用共享常量，对外保持原名，与客户端设置下限对齐。 */
export const DEEPSEEK_MIN_FETCH_MS = QUOTA_MIN_FETCH_MS;

/** 解析 DeepSeek API Key，仅走 DSH 凭据中心，支持 DEEPSEEK_API_KEY 等。 */
export async function resolveDeepSeekKeyWithCredentials(credentials?: CredentialsService): Promise<string | null> {
  return resolveFirstKey(credentials, ['DEEPSEEK_API_KEY', 'DEEPSEEK_APIKEY', 'DEEPSEEK_API_TOKEN', 'DEEPSEEK_TOKEN']);
}

/** 归一化单条余额明细，字段缺失或非法返回 null，不使整批失败。 */
function normalizeBalanceInfo(raw: unknown): DeepSeekBalanceInfo | null {
  if (raw === null || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const currency = rec.currency;
  if (typeof currency !== 'string' || currency.trim().length === 0) return null;
  // 金额字段仅接受 string | number，统一转为 string，缺失回退 "0.00"
  const toAmount = (v: unknown): string => {
    if (typeof v === 'string') {
      const t = v.trim();
      return t.length > 0 ? t : '0.00';
    }
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return '0.00';
  };
  return {
    currency: currency.trim(),
    totalBalance: toAmount(rec.total_balance),
    grantedBalance: toAmount(rec.granted_balance),
    toppedUpBalance: toAmount(rec.topped_up_balance),
  };
}

/** 实时查询 DeepSeek 余额，无缓存。 */
export async function fetchDeepSeekBalance(credentials?: CredentialsService): Promise<DeepSeekBalance> {
  const key = await resolveDeepSeekKeyWithCredentials(credentials);
  if (key === null) {
    // 未配置 Key 属预期场景：客户端以中性提示展示。
    return { status: 'no-key', fetchedAt: Date.now(), isAvailable: false, balances: [], todayAmount: null, todayCurrency: null };
  }
  try {
    const response = await fetch(DEEPSEEK_BALANCE_URL, {
      headers: {
        authorization: `Bearer ${key}`,
        'user-agent': QUOTA_UA,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) {
      // 无订阅 / Key 无效：同样属预期场景。
      return { status: 'no-key', fetchedAt: Date.now(), isAvailable: false, balances: [], todayAmount: null, todayCurrency: null };
    }
    if (!response.ok) {
      return { status: 'error', fetchedAt: Date.now(), isAvailable: false, balances: [], todayAmount: null, todayCurrency: null };
    }
    const data = (await response.json()) as { is_available?: unknown; balance_infos?: unknown };
    // is_available 归一化：仅 boolean true 为 true，其余按 false
    const isAvailable = data.is_available === true;
    const rawInfos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    const balances = rawInfos
      .map(normalizeBalanceInfo)
      .filter((v): v is DeepSeekBalanceInfo => v !== null);
    return {
      status: 'ok',
      fetchedAt: Date.now(),
      isAvailable,
      balances,
      todayAmount: null,
      todayCurrency: null,
    };
  } catch {
    return { status: 'error', fetchedAt: Date.now(), isAvailable: false, balances: [], todayAmount: null, todayCurrency: null };
  }
}

/**
 * 带 TTL 缓存与单飞的余额查询，路由每次调用都走这里。
 *
 * @param intervalMinutes 客户端抓取间隔，单位为分钟；有效 TTL 见共享公式，
 *   未提供时用默认 5 分钟。
 * @param force 为 true 时绕过 TTL 缓存强制重新抓取，供概览 DeepSeek 磁贴的立即
 *   刷新按钮使用；仍走单飞，避免并发打官方端点。
 */
export const queryDeepSeekBalance = createQuotaQuery(
  (credentials?: CredentialsService) => fetchDeepSeekBalance(credentials),
);
