/**
 * 跨端共用的协议类型（host 与 client 两个 bundle 各自内联所需子集）。
 *
 * 本模块**只放类型声明**（interface / type，构建后是空模块、零运行时开销）；
 * 对应的纯函数在 utils.ts。把通用接口从 utils.ts 拆出来独立成文件，避免
 * 一个文件里类型与逻辑混杂、难以维护。这些类型是插件自有协议的单一事实
 * 来源：host 端与 client 端各自 re-export，不再维护镜像副本。
 *
 * 设计约束：本文件禁止任何运行时语句（值 / 函数 / 有副作用的 import），
 * 以保证两端 bundle 都能安全剔除。
 */

/** 单个额度窗口（用量百分比 + 重置时间）。 */
export interface GoWindow {
  percent: number
  resetsAt: string
}

/** 额度查询结果（status 由客户端本地化展示）。 */
export interface GoQuota {
  status: 'ok' | 'no-key' | 'error'
  fetchedAt: number
  rolling: GoWindow | null
  weekly: GoWindow | null
  monthly: GoWindow | null
}

/** 对外暴露的用量形状（total = input + output + cacheRead + cacheWrite，reasoning 单列）。 */
export interface UsageAgg {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

/** 一组聚合计数：UsageAgg + 调用次数（host 端 agg.ts 的 Agg 与 client 端 UsageAgg 的统一）。 */
export interface Agg extends UsageAgg {
  calls: number
}

/** 按日序列点（快照 series 元素；host snapshot 构建与 client 图表共用）。 */
export interface SeriesPoint {
  t: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  calls: number
}
