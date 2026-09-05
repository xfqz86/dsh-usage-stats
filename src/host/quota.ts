/**
 * 额度查询共享基元（服务端）：浏览器 UA、key 回退解析、TTL 缓存单飞工厂。
 *
 * Go/DeepSeek/Z.ai 同一写法：官方端点固定域名 + 浏览器 UA 防前置拦截；
 * key 仅走 DSH 凭据中心、按名回退；结果带 TTL 缓存与单飞（并发只打一次官方端点）；
 * 未配 key / 401 / 403 一律结构化返回、不抛错，由客户端按 status 本地化。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';

import { QUOTA_MIN_FETCH_MS, effectiveQuotaTtl } from '../utils.ts';

import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';

/** DSH 凭据中心服务，为 Context.credentials 合并类型，cordis 可选注入，运行时可能缺席。 */
export type CredentialsService = CredentialProvider;

/** 浏览器 UA：三额度官方端点共用，避免被前置 Cloudflare 拦截。 */
export const QUOTA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 按名回退解析 key：首个成功者胜出（去空格），全部失败回 null。 */
export async function resolveFirstKey(
  credentials: CredentialsService | undefined,
  names: string[],
): Promise<string | null> {
  if (credentials && typeof credentials.resolve === 'function') {
    for (const name of names) {
      try {
        const resolved = await credentials.resolve(credentialRef(name));
        if (resolved && typeof resolved.value === 'string' && resolved.value.trim().length > 0) {
          return resolved.value.trim();
        }
      } catch {
        // 凭据解析失败：继续尝试下一个名字
      }
    }
  }
  return null;
}

/**
 * 带 TTL 缓存与单飞的查询工厂：每个调用处实例独立缓存。
 * force 绕过 TTL 但仍受强制下限保护（距上次抓取不足时直接回缓存）。
 */
export function createQuotaQuery<T, C>(
  fetch: (credentials?: C) => Promise<T>,
): (intervalMinutes?: number, force?: boolean, credentials?: C) => Promise<T> {
  let cache: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;
  return async (intervalMinutes?: number, force = false, credentials?: C): Promise<T> => {
    const effectiveTtlMs = effectiveQuotaTtl(intervalMinutes);
    const now = Date.now();
    if (!force && cache !== null && now - cache.at < effectiveTtlMs) return cache.value;
    if (force && cache !== null && now - cache.at < QUOTA_MIN_FETCH_MS && inflight === null) {
      // force 距上次抓取过近且无进行中的请求：打官方端点频率受强制下限保护，
      // 返回上一次结果即可，避免刷爆官方额度接口。
      return cache.value;
    }
    if (inflight === null) {
      inflight = fetch(credentials).then((value) => {
        cache = { at: Date.now(), value };
        return value;
      }).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}
