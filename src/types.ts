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

/** 额度查询结果，status 由客户端本地化展示；no-plan 为已配置 Key 但未开通订阅。 */
export interface GoQuota {
  status: 'ok' | 'no-key' | 'no-plan' | 'error'
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
  /** 按日细分，用于时间范围筛选与堆叠柱；可缺省（明细类接口的单日行不带）。 */
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
 * 单个模型的明细：范围内合计 + 按日序列 + 按会话明细，
 * 为 usageStats/modelDetail 成功时的 value；日序列与会话行元素直接复用
 * SeriesPoint 与 SessionStat，与快照同形，浏览器端合并重定向来源时不必另建形状。
 */
export interface ModelDetail {
  provider: string
  model: string
  calls: number
  usage: UsageAgg
  /** 范围内按本地日升序，只含有用量的日子；`since` 缺省（全部历史）时不作 366 天截断。 */
  daily: SeriesPoint[]
  /** 范围内用过该模型的会话，按总计降序；元素与快照 sessionsList 同形。 */
  sessions: SessionStat[]
}

/**
 * usageStats/dateDetail 请求：某一个本地日的明细。
 * `day` 是浏览器端日期表行里的本地日零点（`SeriesPoint.t` 原样传来），
 * 服务端按同一套 `startOfDay` 归一；非有限或不大于 0 的取值返回空明细。
 */
export interface DateDetailRequest {
  day: number
}

/**
 * 单日明细：某一天的合计 + 按模型 + 按会话，为 usageStats/dateDetail 成功时的 value。
 * 两个维度都只含当天有量的行；模型行与快照 `models[]` 同形（单日不重复下发 `series`），
 * 会话行与快照 `sessionsList` 同形，浏览器端据此复用同一套分组、排序与表格实现。
 */
export interface DateDetail {
  /** 归一后的本地日零点，与请求同值；非法请求为 0。 */
  day: number
  calls: number
  usage: UsageAgg
  /** 当天有量的模型，按总计降序。 */
  models: ModelStat[]
  /** 当天有量的会话，按总计降序。 */
  sessions: SessionStat[]
}

/**
 * usageStats/sessionDetail 请求：按会话集合取一条会话明细。
 * 集合由客户端界定——会话页所点行的折叠分组（主会话 + `groupSessions` 展平的全部子代理），
 * 与服务端各自按父子关系重建子树相比，只有这样才能与「行数字」同源（见 docs/API.md §2.3）。
 */
export interface SessionDetailRequest {
  /** 该行折叠集合的会话 id（主会话 + 展平的全部子代理）；顺序无关、重复无效、未知 id 按 0 计。 */
  sessionIds: string[]
}

/**
 * 会话明细：集合合计 + 按本地日 + 按模型，为 usageStats/sessionDetail 成功时的 value。
 * 子会话与主会话一视同仁，合计按集合求和；`daily` 只含有量的日子且升序，
 * `models` 为账本原始「供应商 + 模型」行（重定向归并归浏览器端）、省略 `series`。
 */
export interface SessionDetail {
  calls: number
  usage: UsageAgg
  daily: SeriesPoint[]
  models: ModelStat[]
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

/**
 * usageStats/modelDetail 请求：按「供应商 + 模型」取单个模型的明细。
 * `since` 是浏览器端算好的本地日零点，服务端不认「7天/1月」这类范围概念，
 * 缺省或非正数即全部历史；模型统计重定向的多个来源由浏览器端各查一次再合并。
 */
export interface ModelDetailRequest {
  provider: string
  model: string
  since?: number
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
 * usageStats/checkUpdate 请求：手动检查时传 force=true 绕过服务端缓存；
 * 打开「关于」页的自动检查不传，落在 6 小时内存缓存内。
 */
export interface UpdateCheckRequest {
  force?: boolean
}

/** 当前安装方式：npm 注册表安装可在弹窗内直接升级；本地链接/文件/git 安装只能在仓库更新。 */
export type UpdateInstallKind = 'npm' | 'local' | 'unknown';

/**
 * usageStats/checkUpdate 结果：成功带 latest（npm registry 上本插件的最新版本号，不带 v 前缀）、
 * Release 正文与安装方式；失败 latest 恒为 null 且不抛错（网络/响应异常由 status 表达）。
 * 浏览器端拿 latest 与当前版本比较，决定是否提示更新；notes 用于更新说明弹窗。
 */
export type UpdateCheckResult =
  | {
    status: 'ok'
    latest: string
    /** 更新说明页：对应版本的 GitHub Release tag（取到 html_url 时用它）。 */
    url: string
    /** GitHub Release 正文（Markdown）；接口失败或无正文时为 null。 */
    notes: string | null
    /** Release 发布时间（毫秒）；未知为 null。 */
    publishedAt: number | null
    /** 当前安装方式，决定弹窗里是否提供「立即升级」。 */
    install: UpdateInstallKind
  }
  | {
    status: 'error'
    latest: null
    /** 查询失败时的兜底更新说明页（releases 列表）。 */
    url: string
    notes: null
    publishedAt: null
    /** 查询失败时仍能识别安装方式，供失败页说明。 */
    install: UpdateInstallKind
  };

/** usageStats/upgrade 请求：安装指定的精确版本（来自 checkUpdate 的 latest）。 */
export interface UpgradeRequest {
  version: string
}

/** 升级失败原因，由浏览器端本地化成文案；升级动作本身不抛错。 */
export type UpgradeFailureReason = 'busy' | 'link-install' | 'unsupported' | 'timeout' | 'network' | 'failed';

/**
 * usageStats/upgrade 结果：成功表示新版本已写入 profile 的依赖，但运行中的 DSH 仍加载旧版本，
 * restartRequired 恒为 true；失败带原因，由浏览器端本地化，只有可重试的原因才给「重试」。
 */
export type UpgradeResult =
  | {
    status: 'ok'
    version: string
    restartRequired: true
    reason: null
  }
  | {
    status: 'error'
    version: string
    restartRequired: false
    reason: UpgradeFailureReason
  };

/**
 * 一条模型统计重定向规则：把「来源供应商 + 来源模型」的用量算到
 * 「目标供应商 + 目标模型」名下（影响模型页与日期、会话明细的按模型统计，不动账本）。
 */
export interface ModelRedirect {
  /** 来源供应商，如 opencode-go-vision。 */
  fromProvider: string
  /** 来源模型，如 deepseek-v4-flash。 */
  fromModel: string
  /** 目标供应商，如 opencode-go。 */
  toProvider: string
  /** 目标模型，如 deepseek-v4-flash。 */
  toModel: string
}

/**
 * 插件偏好设置：OpenCode Go 额度、DeepSeek 余额与 Z.ai 额度监控各三项，
 * 会话标题 session-id 徽标开关，加模型统计重定向规则表；字段与 host 侧
 * `usage-stats` 条目的 schemastery schema（src/host/settings.ts）一一对应，
 * client 侧经 ctx.configForms 取得同一形状的解析值。
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
  /** 是否在会话标题右侧展示 session-id 徽标（含悬停复制），默认开启。 */
  showSessionId: boolean
  /**
   * 模型统计重定向规则：按顺序匹配来源（同一来源只有最上面一条生效），
   * 由浏览器端在模型页与日期、会话明细的按模型表归并，见 `src/client/stats.ts` 的 redirectModels。
   */
  modelRedirects: ModelRedirect[]
}
