/**
 * DeepSeek 余额轮询，浏览器端。
 *
 * 服务端 Host 提供 POST /usage-stats/api/deepseek-balance，具备回环围栏与 TTL 缓存，
 * 与全部 /usage-stats/api/* 一样要求携带 x-dsh-usage-stats CSRF 围栏头。
 * 余额信息含多币种 total、granted 与 toppedUp，显示在底部角标与模态窗详情里。
 * 轮询骨架收拢于 useQuota，本文件只配端点、夹取与 error 占位。
 * DeepSeekBalance / DeepSeekBalanceInfo 协议类型定义在 types.ts，与 host 端 deepseekBalance 统一。
 */

import { clampDeepSeekFetchMinutes } from './settings.ts';
import { useQuota } from './useQuota.ts';

import type { DeepSeekBalance } from '../types.ts';

/** 协议类型单一定义在 types.ts，此处 re-export 保持对外引用面。 */
export type { DeepSeekBalance, DeepSeekBalanceInfo } from '../types.ts';

/** DeepSeek 余额端点。 */
const ENDPOINT = '/usage-stats/api/deepseek-balance';

/** 首屏失败时的 error 占位：保证侧边栏/概览组件可见（模块级稳定引用）。 */
function makeError(): DeepSeekBalance {
  return { status: 'error', fetchedAt: Date.now(), isAvailable: false, balances: [] };
}

/**
 * 每 `intervalMinutes` 分钟轮询一次余额；未启用 / 请求失败 / 尚未加载时为
 * null。返回 [数据, 手动刷新]。间隔下限 3 分钟、默认 5 分钟。
 */
export function useDeepSeekBalance(
  enabled: boolean,
  intervalMinutes: number,
): [DeepSeekBalance | null, () => void] {
  return useQuota({ enabled, intervalMinutes, endpoint: ENDPOINT, clampMinutes: clampDeepSeekFetchMinutes, makeError });
}
