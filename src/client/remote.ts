/**
 * usageStats 命名空间的浏览器端挂载与调用入口。
 *
 * 独立仓库自挂载：Client 程序集（api-remotes）只挂载官方选单，
 * 本插件在 apply 内把自己的严格贡献 USAGE_STATS_REMOTE 经
 * ctx.remote.$mount 挂载，返回的 disposer 由调用方经 ctx.effect 随 fiber 撤回。
 * hooks 经 usageStatsRemote 取命名空间服务，调用签名与返回信封均为手写严格类型
 * （见 src/remote/contribution.ts 的命名空间合并）。
 *
 * 取句柄必须经挂载上下文 get('remote.usageStats')（本模块由 usageStatsRemote 封装，
 * 每次调用经 get 实时解析，不缓存服务实例），不可暂存 ctx.remote 再读
 * .usageStats：插件行跑在子 scope，暂存的 remote 句柄在 hooks（fiber 之外）
 * 触发命名空间属性查找会报 without-inject（命名空间服务挂在父级）；
 * get 走 fiber 链向上查找，任意位置可用，且挂载重建后自动跟随最新实例。
 */

import { NAMESPACE, USAGE_STATS_REMOTE } from '../remote/contribution.ts';

import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { TypertRemoteNamespace$75736167655374617473 } from '@deepseek-ai/dsh-typert-protocol';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 网关客户端以 `remote.<命名空间>` 为键注册的命名空间服务。 */
    'remote.usageStats': TypertRemoteNamespace$75736167655374617473
  }
}

/** 命名空间服务键，与网关客户端的 remoteServiceKey 同形。 */
const SERVICE_KEY = `remote.${NAMESPACE}` as const;

let mountCtx: ClientContext | undefined;

/**
 * 挂载本插件的 Remote 贡献并记住挂载上下文。
 * @param ctx - 浏览器端 cordis 上下文（已注入 remote 服务）。
 * @returns 撤回挂载的 disposer。
 */
export async function mountUsageStatsRemote(ctx: ClientContext): Promise<() => Promise<void>> {
  const dispose = await ctx.remote.$mount(USAGE_STATS_REMOTE);
  mountCtx = ctx;
  return async () => {
    if (mountCtx === ctx) mountCtx = undefined;
    await dispose();
  };
}

/**
 * 取已挂载的命名空间服务（每次调用经挂载上下文 get 实时解析，不缓存实例）。
 * @returns 命名空间服务，挂载完成后恒有值。
 */
export function usageStatsRemote(): TypertRemoteNamespace$75736167655374617473 {
  let svc: TypertRemoteNamespace$75736167655374617473 | undefined;
  try {
    svc = mountCtx?.get(SERVICE_KEY) ?? undefined;
  } catch {
    svc = undefined;
  }
  if (svc === undefined) throw new Error('usageStats remote 尚未挂载');
  return svc;
}
