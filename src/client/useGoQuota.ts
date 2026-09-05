/**
 * OpenCode Go 订阅额度轮询，浏览器端实现。
 *
 * 服务端 Host 提供 POST /usage-stats/api/go-quota，具备回环围栏与 TTL 缓存，
 * 与全部 /usage-stats/api/* 一样要求携带 x-dsh-usage-stats CSRF 围栏头。
 * 额度窗口含滚动 5 小时、本周与本月，显示在底部角标与模态窗详情里。
 * 轮询骨架收拢于 useQuota，本文件只配端点、夹取与 error 占位。
 * GoWindow / GoQuota 协议类型定义在 types.ts，与 host 端 goquota 统一。
 */

import { clampGoFetchMinutes } from './settings.ts';
import { useQuota } from './useQuota.ts';

import type { GoQuota } from '../types.ts';

/** 协议类型单一定义在 types.ts，此处 re-export 保持对外引用面。 */
export type { GoQuota, GoWindow } from '../types.ts';

/** Go 额度端点。 */
const ENDPOINT = '/usage-stats/api/go-quota';

/** 首屏失败时的 error 占位：保证侧边栏/概览组件可见（模块级稳定引用）。 */
function makeError(): GoQuota {
  return { status: 'error', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null };
}

/**
 * 每 `intervalMinutes` 分钟轮询一次额度；未启用 / 请求失败 / 尚未加载时为
 * null。返回 [数据, 手动刷新]。`intervalMinutes` 下限 3 分钟、默认 5 分钟，
 * 请求体携带 intervalMinutes，服务端据此把 TTL 缓存调成 min(5 分钟, 间隔)。
 */
export function useGoQuota(
  enabled: boolean,
  intervalMinutes: number,
): [GoQuota | null, () => void] {
  return useQuota({ enabled, intervalMinutes, endpoint: ENDPOINT, clampMinutes: clampGoFetchMinutes, makeError });
}
