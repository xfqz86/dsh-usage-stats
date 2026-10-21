/**
 * 「立即升级」hook：调用 usageStats/upgrade 把 profile 依赖装到指定版本，
 * 并把结果归一为 idle / upgrading / success / error 四态。
 *
 * 服务端要等 CLI 退出才返回（最长 180 秒），busyRef 在响应回来前拒绝重复点击；
 * seqRef 让关闭弹窗时的 reset 丢弃迟到的响应，避免弹窗已关又被置成成功或失败。
 */

import { useCallback, useRef, useState } from 'react';

import { usageStatsRemote } from './remote.ts';

import type { UpgradeFailureReason } from '../types.ts';

/** 升级四态：upgrading 期间弹窗不可关闭，success 提示重启 DSH，error 带本地化原因。 */
export type UpgradeState =
  | { status: 'idle' }
  | { status: 'upgrading'; version: string }
  | { status: 'success'; version: string }
  | { status: 'error'; version: string; reason: UpgradeFailureReason };

/** useUpgrade 的返回值：当前状态、发起升级与重置。 */
export interface UseUpgradeResult {
  /** 当前升级状态。 */
  state: UpgradeState
  /** 安装指定版本；升级进行中重复调用直接忽略。 */
  upgrade: (version: string) => void
  /** 回到 idle 并丢弃在途响应，关闭弹窗时调用。 */
  reset: () => void
}

/** 把 Remote 信封与异常归一为界面状态。 */
async function runUpgrade(version: string): Promise<UpgradeState> {
  try {
    const result = await usageStatsRemote().upgrade({ version });
    // 网关层失败没有安装原因可展示，统一按 failed 提示重试或在发布页手动安装。
    if (!result.ok) return { status: 'error', version, reason: 'failed' };
    if (result.value.status === 'ok') return { status: 'success', version: result.value.version };
    return { status: 'error', version, reason: result.value.reason };
  } catch {
    return { status: 'error', version, reason: 'network' };
  }
}

/** 管理一次升级的状态机；同一时间只允许一次升级请求。 */
export function useUpgrade(): UseUpgradeResult {
  const [state, setState] = useState<UpgradeState>({ status: 'idle' });
  // 单飞：服务端安装期间不再发第二次，避免后端 busy 与界面状态来回切换。
  const busyRef = useRef(false);
  // 乱序守卫：reset 递增序号后，在途请求回来不会再覆盖 idle。
  const seqRef = useRef(0);

  const upgrade = useCallback((version: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const mine = ++seqRef.current;
    setState({ status: 'upgrading', version });
    void (async () => {
      const next = await runUpgrade(version);
      busyRef.current = false;
      if (mine !== seqRef.current) return;
      setState(next);
    })();
  }, []);

  const reset = useCallback(() => {
    seqRef.current += 1;
    setState({ status: 'idle' });
  }, []);

  return { state, upgrade, reset };
}
