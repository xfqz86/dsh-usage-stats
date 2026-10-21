/**
 * 用量统计的服务端 Host 插件入口：default 导出服务类，由 Loader 实例化。
 *
 * 实现在 service.ts（UsageStatsService，12 个 @Remote 方法 + 账本装配），本模块只做
 * 入口转口与类型再导出；信任与认证由网关载体统一处理，不注册 HTTP 路由。
 */

export { default } from './service.ts';
export { default as UsageStatsService } from './service.ts';

/** 对外类型再导出，Agg 定义在 types.ts，SessionInfo 定义在 agg.ts。 */
export type { Agg, SessionInfo } from './agg.ts';
