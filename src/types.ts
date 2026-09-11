/**
 * 跨端共用的协议类型，host 与 client 两个 bundle 各自内联所需子集。
 *
 * 本模块**只放类型声明**，包括 interface、type，构建后是空模块、零运行时开销；
 * 对应的纯函数在 utils.ts。协议类型与纯函数分离，避免类型与逻辑混杂。这些类型是插件自有协议的单一事实来源，host 与 client 各自 re-export。
 *
 * 设计约束：本文件禁止任何运行时语句，包括值、函数、有副作用的 import，
 * 以保证两端 bundle 都能安全剔除。
 */

/** 单个额度窗口，包含用量百分比与重置时间。 */
export interface GoWindow {
  percent: number
  resetsAt: string
}

/** 额度查询结果，status 由客户端本地化展示。 */
export interface GoQuota {
  status: 'ok' | 'no-key' | 'error'
  fetchedAt: number
  rolling: GoWindow | null
  weekly: GoWindow | null
  monthly: GoWindow | null
}

/** DeepSeek 单币种余额明细，归一化后金额保持字符串以避免浮点精度丢失。 */
export interface DeepSeekBalanceInfo {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

/** DeepSeek 余额查询结果，与 GoQuota 同级，status 由客户端本地化。 */
export interface DeepSeekBalance {
  status: 'ok' | 'no-key' | 'error'
  fetchedAt: number
  isAvailable: boolean
  balances: DeepSeekBalanceInfo[]
  /** 预留：官方今日消耗金额，v1 无官方日耗接口固定为 null，未来有接口时填充。 */
  todayAmount?: string | null
  /** 预留：对应币种，v1 为 null。 */
  todayCurrency?: string | null
}

/**
 * Z.ai 单个百分比额度窗口，与 GoWindow 同形，用于滚动 5 小时、周额度。
 * `used`/`limit` 为点数明细，对应官方 `currentValue`、`usage`，官方未下发时为 null。
 */
export interface ZaiWindow {
  percent: number
  resetsAt: string
  used: number | null
  limit: number | null
}

/** Z.ai 每月 Web 搜索额度，次数型，已用、总量、百分比与重置时间。 */
export interface ZaiWebSearchQuota {
  used: number
  limit: number
  percent: number
  resetsAt: string
}

/** Z.ai 额度查询结果，与 GoQuota、DeepSeekBalance 同级，status 由客户端本地化。 */
export interface ZaiQuota {
  status: 'ok' | 'no-key' | 'no-plan' | 'error'
  fetchedAt: number
  /** 计划名，如来自 data.level 的 "Z.ai pro"，无时为 null。 */
  plan: string | null
  /** 5 小时会话窗口，百分比额度。 */
  session: ZaiWindow | null
  /** 周窗口，百分比额度。 */
  weekly: ZaiWindow | null
  /** 每月 Web 搜索次数额度，类型为 TIME_LIMIT。 */
  webSearches: ZaiWebSearchQuota | null
}

/** 对外暴露的用量形状，total 为 input、output、cacheRead 与 cacheWrite 之和，reasoning 单列。 */
export interface UsageAgg {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

/** 一组聚合计数：UsageAgg 加调用次数，host 折叠与 client 展示共用。 */
export interface Agg extends UsageAgg {
  calls: number
}

/** 按日序列点，为快照 series 元素，host snapshot 构建与 client 图表共用。 */
export interface SeriesPoint {
  t: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  calls: number
}

/** 快照中按模型、Provider 的拆分条目，host snapshot 构建与 client 图表共用。 */
export interface ModelStat {
  provider: string
  model: string
  calls: number
  usage: UsageAgg
  /** 按日细分，用于时间范围筛选与堆叠柱，可能缺失于旧快照。 */
  series?: SeriesPoint[]
}

/** 快照中按会话的拆分条目，已含子代理归属字段，复用 SessionHeader 语义。 */
export interface SessionStat {
  id: string
  title: string
  cwd: string
  createdAt: number
  lastActive: number
  calls: number
  usage: UsageAgg
  parentSession: string | null
  origin: string | null
  delegationDepth: number
}

/**
 * usageStats/snapshot 的 value 部分快照协议，为本插件自有 API 协议，
 * 见 AGENTS §8，host snapshot() 构建与 client useSnapshot 消费共用，避免两端镜像漂移。
 * Remote 传输外层为 { ok, value } 信封，此类型对应成功时的 value。
 */
export interface UsageSnapshot {
  scanning: boolean
  scans: number
  failed: number
  rawSessions: number
  harnessSessions: number
  foldedEvents: number
  dedupSkipped: number
  lastError: string | null
  scanError: string | null
  lastScanAt: number
  time: number
  sessions: number
  current: { id: string; calls: number; usage: UsageAgg } | null
  all: { calls: number; usage: UsageAgg }
  series: { all: SeriesPoint[]; current: SeriesPoint[] }
  models: ModelStat[]
  sessionsList: SessionStat[]
}

/**
 * Remote 请求与结果类型：每个 @Remote 方法取单个具名必填 request 对象
 * （严格约定禁可选参数/解构/默认值，字段级可选不受限），返回结果值；
 * 传输信封 RemoteResult（{ ok:true,value } | { ok:false,error }）由网关负责。
 */

/** usageStats/snapshot 请求：按会话过滤与明细分页上限。 */
export interface SnapshotRequest {
  sessionId: string | null
  limit?: number
}

/** usageStats/rebuild 结果：清空账本后全量重扫的折叠事件数。 */
export interface RebuildResult {
  rebuilt: boolean
  foldedEvents: number
}

/** usageStats/clear 结果：清空账本不重扫，计数归零。 */
export interface ClearResult {
  cleared: boolean
  foldedEvents: number
}

/** usageStats/seal 结果：手动物化预统计的密封边界与事件数。 */
export interface SealResult {
  sealed: boolean
  sealedUntil: number
  foldedEvents: number
}

/** 额度/余额轮询请求：客户端抓取间隔与强制刷新。 */
export interface QuotaRequest {
  intervalMinutes?: number
  force?: boolean
}

/**
 * 插件偏好设置：OpenCode Go 额度、DeepSeek 余额与 Z.ai 额度监控各三项，
 * 字段与 `usage-stats` 设置命名空间（服务端 schemastery schema）一一对应。
 * host 侧 schema 用它做泛型参数，client 侧经 settingsScope 取得同一形状。
 */
export interface UsageSettings {
  /** 是否启用 OpenCode Go 额度监控，关闭后不再请求官方额度接口。 */
  goEnabled: boolean
  /** 是否在侧边栏底部展示 OpenCode Go 剩余额度芯片。 */
  showGoInSidebar: boolean
  /** OpenCode Go 额度抓取间隔，单位分钟，下限 3 分钟。 */
  goFetchMinutes: number
  /** 是否启用 DeepSeek 余额监控，关闭后不再请求官方余额接口。 */
  deepseekEnabled: boolean
  /** 是否在侧边栏底部展示 DeepSeek 余额芯片。 */
  showDeepSeekInSidebar: boolean
  /** DeepSeek 余额抓取间隔，单位分钟，下限 3 分钟。 */
  deepseekFetchMinutes: number
  /** 是否启用 Z.ai 额度监控，关闭后不再请求官方额度接口。 */
  zaiEnabled: boolean
  /** 是否在侧边栏底部展示 Z.ai 额度芯片。 */
  showZaiInSidebar: boolean
  /** Z.ai 额度抓取间隔，单位分钟，下限 3 分钟。 */
  zaiFetchMinutes: number
}
