/**
 * 「关于」页的更新检查 hook：面板打开时自动查一次，手动检查带 force 绕过服务端缓存。
 *
 * 自动检查只在首次打开时触发（startedRef），失败不自动重试，重试交给用户点按钮；
 * seqRef 乱序守卫丢弃旧响应，避免慢请求覆盖后发结果。成功结果把 Release 说明、
 * 发布时间与当前安装方式一并带进状态，供更新说明弹窗展示并决定是否提供「立即升级」。
 * 版本关系分六态（含本地版本领先线上的 ahead），不再用布尔比较，避免领先时误报「已是最新」。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { updateRelation } from '../utils.ts';

import { usageStatsRemote } from './remote.ts';
import { PLUGIN_VERSION } from './version.ts';

import type { UpdateInstallKind } from '../types.ts';

/**
 * 成功检查携带的版本信息：最新版本、更新说明页、Release 正文与发布时间、安装方式。
 * latest/update/ahead 三态共有；仅 update 态会打开更新说明弹窗。
 */
export interface UpdateInfo {
  /** npm registry 上的最新版本号，不带 v 前缀。 */
  latest: string
  /** 更新说明页：对应版本的 GitHub Release，取不到 Release 时回退到 tag 页。 */
  url: string
  /** GitHub Release 正文（Markdown），接口失败或无正文时为 null。 */
  notes: string | null
  /** Release 发布时间（毫秒），未知为 null。 */
  publishedAt: number | null
  /** 当前安装方式；local 时弹窗只提示在仓库更新，不提供立即升级。 */
  install: UpdateInstallKind
}

/** 没有版本信息的状态（idle/checking/error）共用的空字段。 */
const EMPTY_INFO = { latest: null, url: null, notes: null, publishedAt: null, install: null } as const;

/**
 * 检查更新的六态。latest/update/ahead 才带服务端返回的版本、说明与安装方式，
 * 其余状态没有可展示的版本信息。
 */
export type UpdateCheckState =
  | { status: 'idle'; latest: null; url: null; notes: null; publishedAt: null; install: null }
  | { status: 'checking'; latest: null; url: null; notes: null; publishedAt: null; install: null }
  | { status: 'error'; latest: null; url: null; notes: null; publishedAt: null; install: null }
  | ({ status: 'latest' } & UpdateInfo)
  | ({ status: 'ahead' } & UpdateInfo)
  | ({ status: 'update' } & UpdateInfo);

/** 初始空闲态。 */
const IDLE_STATE: UpdateCheckState = { status: 'idle', ...EMPTY_INFO };

/** 发起一次检查并把协议结果归一为界面状态：网络异常与业务失败都落 error。 */
async function runCheck(force: boolean): Promise<UpdateCheckState> {
  try {
    const result = await usageStatsRemote().checkUpdate(force ? { force: true } : {});
    // 判别联合：status 不是 ok 时 latest 恒为 null，不能拿来做版本比较。
    if (!result.ok || result.value.status !== 'ok') {
      return { status: 'error', ...EMPTY_INFO };
    }
    const info: UpdateInfo = {
      latest: result.value.latest,
      url: result.value.url,
      notes: result.value.notes,
      publishedAt: result.value.publishedAt,
      install: result.value.install,
    };
    const relation = updateRelation(info.latest, PLUGIN_VERSION);
    if (relation === 'update') return { status: 'update', ...info };
    if (relation === 'ahead') return { status: 'ahead', ...info };
    return { status: 'latest', ...info };
  } catch {
    return { status: 'error', ...EMPTY_INFO };
  }
}

/** useUpdateCheck 的返回值：当前状态与手动检查入口。 */
export interface UseUpdateCheckResult {
  /** 当前检查状态。 */
  state: UpdateCheckState
  /** 手动检查；force=true 绕过服务端 6 小时缓存，失败可直接重试。 */
  check: (force?: boolean) => void
}

/**
 * 面板打开时自动检查一次更新，之后只由用户手动触发。
 * @param open - 面板是否打开；首次变为 true 时发起一次非强制检查。
 * @returns 当前状态与手动检查函数。
 */
export function useUpdateCheck(open: boolean): UseUpdateCheckResult {
  const [state, setState] = useState<UpdateCheckState>(IDLE_STATE);
  // 自动检查只发起一次：失败也不在下次打开时重试，避免离线环境下每次开面板都打网络。
  const startedRef = useRef(false);
  // 乱序守卫：自动检查与手动重试共享递增序号，最后发起者胜出。
  const seqRef = useRef(0);

  const check = useCallback((force = false) => {
    const mine = ++seqRef.current;
    setState({ status: 'checking', ...EMPTY_INFO });
    void (async () => {
      const next = await runCheck(force);
      if (mine !== seqRef.current) return;
      setState(next);
    })();
  }, []);

  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    check(false);
  }, [open, check]);

  return { state, check };
}
