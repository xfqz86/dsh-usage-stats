/**
 * 本插件版本号：tsdown 构建时把 package.json 的 version 注入 DSH_USAGE_STATS_VERSION，
 * 「关于」页的版本展示与更新比较都读这里，避免与包版本漂移。
 * 该常量只在构建产物中存在，源码直跑（如纯逻辑测试）不会导入本模块。
 */

declare const DSH_USAGE_STATS_VERSION: string;

/** 当前安装的插件版本，形如 0.5.1（不带 v 前缀）。 */
export const PLUGIN_VERSION = DSH_USAGE_STATS_VERSION;
