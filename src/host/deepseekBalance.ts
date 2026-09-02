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
import { credentialRef } from '@deepseek-ai/dsh-credentials';

import type { DeepSeekBalance, DeepSeekBalanceInfo } from '../types.ts';
// 凭据中心类型与 ref 构造均来自 harness，遵循 AGENTS §0 禁止手写注入服务镜像类型。
// 运行时值导入可接受：本插件运行于 dsh 基座，基座原生带有 @deepseek-ai/* 模块。
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';

/** 协议类型单一定义在 types.ts，此处 re-export 保持对外引用面。 */
export type { DeepSeekBalance, DeepSeekBalanceInfo } from '../types.ts';

/** DSH 凭据中心服务，为 Context.credentials 合并类型，cordis 可选注入，运行时可能缺席。 */
export type CredentialsService = CredentialProvider;

/** DeepSeek 官方余额端点，固定域名。 */
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
/** 浏览器 UA：避免被前置 Cloudflare 拦截，与 GoQuota 同款。 */
const DEEPSEEK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** 服务端强制下限：官方余额端点任何情况下不低于 3 分钟打一次，与客户端设置下限对齐。 */
export const DEEPSEEK_MIN_FETCH_MS = 3 * 60 * 1000;
/** 结果缓存上限：默认 5 分钟；客户端可按抓取间隔调短有效缓存。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 解析 DeepSeek API Key，仅走 DSH 凭据中心，支持 DEEPSEEK_API_KEY 等。 */
export async function resolveDeepSeekKeyWithCredentials(credentials?: CredentialsService): Promise<string | null> {
  if (credentials && typeof credentials.resolve === 'function') {
    for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_APIKEY', 'DEEPSEEK_API_TOKEN', 'DEEPSEEK_TOKEN']) {
      try {
        const ref = credentialRef(name);
        const resolved = await credentials.resolve(ref);
        if (resolved && typeof resolved.value === 'string' && resolved.value.trim().length > 0) return resolved.value.trim();
      } catch {
        // 凭据解析失败：继续尝试下一个名字
      }
    }
  }
  return null;
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
        'user-agent': DEEPSEEK_UA,
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

let cache: { at: number; value: DeepSeekBalance } | null = null;
let inflight: Promise<DeepSeekBalance> | null = null;

/**
 * 带 TTL 缓存与单飞的余额查询，路由每次调用都走这里。
 *
 * @param intervalMinutes 客户端抓取间隔，单位为分钟；有效缓存按 5 分钟上限与
 *   3 分钟下限、请求间隔经 min 与 max 组合计算 —— 让实际打官方端点的频率与
 *   设置一致，且不短于 3 分钟；未提供时用默认 5 分钟。
 * @param force 为 true 时绕过 TTL 缓存强制重新抓取，供概览 DeepSeek 磁贴的立即
 *   刷新按钮使用；仍走单飞，避免并发打官方端点。
 */
export async function queryDeepSeekBalance(
  intervalMinutes?: number,
  force = false,
  credentials?: CredentialsService,
): Promise<DeepSeekBalance> {
  const effectiveTtlMs =
    typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes)
      ? Math.min(CACHE_TTL_MS, Math.max(DEEPSEEK_MIN_FETCH_MS, Math.round(intervalMinutes * 60 * 1000)))
      : CACHE_TTL_MS;
  const now = Date.now();
  if (!force && cache !== null && now - cache.at < effectiveTtlMs) return cache.value;
  if (force && cache !== null && now - cache.at < DEEPSEEK_MIN_FETCH_MS && inflight === null) {
    // force 距上次抓取过近且无进行中的请求：打官方端点频率受强制下限保护，
    // 返回上一次结果即可，避免刷爆官方余额接口。
    return cache.value;
  }
  if (inflight === null) {
    inflight = fetchDeepSeekBalance(credentials)
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
