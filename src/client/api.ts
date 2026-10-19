/**
 * usageStats 命名空间的浏览器端调用约定：调用前经 usageStatsRemote() 取命名空间服务。
 * 线路协议（RPC 路径、响应信封、认证）见 docs/API.md §1；本模块只定义快照轮询常量
 * 与 rebuild/clear 共用的调用封装。
 */

import { usageStatsRemote } from './remote.ts';

/** 快照轮询间隔：底部角标与模态窗共用同一份数据。 */
export const SNAPSHOT_INTERVAL_MS = 4000;
/** 快照会话明细请求上限：服务端默认 200、上限 1000，此值兼顾完整与序列化开销。 */
export const SNAPSHOT_LIMIT = 500;

/**
 * 账本写操作 Remote 调用：rebuild/clear 同一写法（seal 仅协议保留，界面未暴露）。
 * 成功后调 onRefresh 重拉快照；失败抛错，由调用方落回 idle。二次确认与 busy/done 状态机归 useConfirmOp。
 */
export async function postLedgerApi(endpoint: 'rebuild' | 'clear', onRefresh: () => void): Promise<void> {
  const remote = usageStatsRemote();
  const result = endpoint === 'rebuild' ? await remote.rebuild() : await remote.clear();
  if (!result.ok) throw new Error(`${endpoint} failed`);
  onRefresh();
}
