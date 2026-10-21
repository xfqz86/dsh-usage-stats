/**
 * usageStats 命名空间的手写严格 Remote 贡献。
 *
 * 本插件是独立仓库，跑不了 harness 仓库内 Typert 生成器的 workspace 管线（包发现强制
 * 要求包位于 <root>/packages/ 下），因此 Client 挂载用的严格描述符与 zod 编解码在此手写，
 * Host 侧走文档化的 SRC 分发（@Remote 标记 + 实时服务绑定）。等价性由测试锁定：
 * test/pure.mjs 断言每个方法的 zod 收发与 service 实际出入相容，test/smoke.mjs 验证业务语义。
 *
 * 维护规则：只改方法实现体不动本文件；增删方法、改命名空间、改参数/返回值形状时必须
 * 同步这里的描述符与 schema，否则 Client 挂载或调用校验会失败。错误分支有意放宽（code
 * 为任意字符串，未知码也不该破坏信封解析），成功分支保持精确。
 */

import { z } from 'zod';

import type {
  ClearResult,
  DateDetail,
  DateDetailRequest,
  DeepSeekBalance,
  GoQuota,
  ModelDetail,
  ModelDetailRequest,
  QuotaRequest,
  RebuildResult,
  SealResult,
  SessionDetail,
  SessionDetailRequest,
  SnapshotRequest,
  UpdateCheckRequest,
  UpdateCheckResult,
  UpdateInstallKind,
  UpgradeFailureReason,
  UpgradeRequest,
  UpgradeResult,
  UsageSnapshot,
  ZaiQuota,
} from '../types.ts';
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';

/** Remote 命名空间，与服务键同名。 */
export const NAMESPACE = 'usageStats';

/** 包名，与 package.json 的 name 完全一致，用于描述符归属。 */
export const PACKAGE = '@xfqz86/dsh-usage-stats';

const usageAggSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  total: z.number(),
});

const seriesPointSchema = z.object({
  t: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  calls: z.number(),
});

const modelStatSchema = z.object({
  provider: z.string(),
  model: z.string(),
  calls: z.number(),
  usage: usageAggSchema,
  series: z.array(seriesPointSchema).optional(),
});

const sessionStatSchema = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
  lastActive: z.number(),
  calls: z.number(),
  usage: usageAggSchema,
  parentSession: z.string().nullable(),
  origin: z.string().nullable(),
  delegationDepth: z.number(),
});

/** 模型明细：范围内合计 + 按日序列 + 按会话明细，元素与快照同形。 */
const modelDetailSchema = z.object({
  provider: z.string(),
  model: z.string(),
  calls: z.number(),
  usage: usageAggSchema,
  daily: z.array(seriesPointSchema),
  sessions: z.array(sessionStatSchema),
});

/** 单日明细：当天合计 + 当天模型行 + 当天会话行；模型行不下发 series（单日行再带按日序列没有意义）。 */
const dateDetailSchema = z.object({
  day: z.number(),
  calls: z.number(),
  usage: usageAggSchema,
  models: z.array(modelStatSchema),
  sessions: z.array(sessionStatSchema),
});

/** 会话明细：集合合计 + 按本地日 + 按模型；模型行省略 series（明细不画该模型的按日图）。 */
const sessionDetailSchema = z.object({
  calls: z.number(),
  usage: usageAggSchema,
  daily: z.array(seriesPointSchema),
  models: z.array(modelStatSchema),
});

const usageSnapshotSchema = z.object({
  scanning: z.boolean(),
  scans: z.number(),
  failed: z.number(),
  rawSessions: z.number(),
  harnessSessions: z.number(),
  foldedEvents: z.number(),
  dedupSkipped: z.number(),
  lastError: z.string().nullable(),
  scanError: z.string().nullable(),
  lastScanAt: z.number(),
  time: z.number(),
  sessions: z.number(),
  current: z.object({ id: z.string(), calls: z.number(), usage: usageAggSchema }).nullable(),
  all: z.object({ calls: z.number(), usage: usageAggSchema }),
  series: z.object({ all: z.array(seriesPointSchema), current: z.array(seriesPointSchema) }),
  models: z.array(modelStatSchema),
  sessionsList: z.array(sessionStatSchema),
});

const goWindowSchema = z.object({ percent: z.number(), resetsAt: z.string() });

const goQuotaSchema = z.object({
  status: z.union([z.literal('ok'), z.literal('no-key'), z.literal('no-plan'), z.literal('error')]),
  fetchedAt: z.number(),
  rolling: goWindowSchema.nullable(),
  weekly: goWindowSchema.nullable(),
  monthly: goWindowSchema.nullable(),
});

const deepSeekBalanceSchema = z.object({
  status: z.union([z.literal('ok'), z.literal('no-key'), z.literal('error')]),
  fetchedAt: z.number(),
  isAvailable: z.boolean(),
  balances: z.array(z.object({
    currency: z.string(),
    totalBalance: z.string(),
    grantedBalance: z.string(),
    toppedUpBalance: z.string(),
  })),
  todayAmount: z.string().nullable().optional(),
  todayCurrency: z.string().nullable().optional(),
});

const zaiQuotaSchema = z.object({
  status: z.union([z.literal('ok'), z.literal('no-key'), z.literal('no-plan'), z.literal('error')]),
  fetchedAt: z.number(),
  plan: z.string().nullable(),
  session: z.object({
    percent: z.number(),
    resetsAt: z.string(),
    used: z.number().nullable(),
    limit: z.number().nullable(),
  }).nullable(),
  weekly: z.object({
    percent: z.number(),
    resetsAt: z.string(),
    used: z.number().nullable(),
    limit: z.number().nullable(),
  }).nullable(),
  webSearches: z.object({
    used: z.number(),
    limit: z.number(),
    percent: z.number(),
    resetsAt: z.string(),
  }).nullable(),
});

const snapshotRequestSchema = z.object({
  sessionId: z.string().nullable(),
  limit: z.number().optional(),
});

const modelDetailRequestSchema = z.object({
  provider: z.string(),
  model: z.string(),
  since: z.number().optional(),
});

const dateDetailRequestSchema = z.object({
  day: z.number(),
});

/** 会话集合：顺序无关、重复无效，线路层只收字符串数组（服务端仍防御非数组/非字符串）。 */
const sessionDetailRequestSchema = z.object({
  sessionIds: z.array(z.string()),
});

const quotaRequestSchema = z.object({
  intervalMinutes: z.number().optional(),
  force: z.boolean().optional(),
});

const updateCheckRequestSchema = z.object({
  force: z.boolean().optional(),
});

const rebuildResultSchema = z.object({ rebuilt: z.boolean(), foldedEvents: z.number() });
const clearResultSchema = z.object({ cleared: z.boolean(), foldedEvents: z.number() });
const sealResultSchema = z.object({
  sealed: z.boolean(),
  sealedUntil: z.number(),
  foldedEvents: z.number(),
});

const installKindSchema = z.union([z.literal('npm'), z.literal('local'), z.literal('unknown')]);

/** 更新检查结果：成功必须带版本号与安装方式，失败 latest 恒为 null；错误不抛、走 status。 */
const updateCheckResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    latest: z.string(),
    url: z.string(),
    notes: z.string().nullable(),
    publishedAt: z.number().nullable(),
    install: installKindSchema,
  }),
  z.object({
    status: z.literal('error'),
    latest: z.null(),
    url: z.string(),
    notes: z.null(),
    publishedAt: z.null(),
    install: installKindSchema,
  }),
]);

const upgradeRequestSchema = z.object({ version: z.string() });
const upgradeReasonSchema = z.union([
  z.literal('busy'),
  z.literal('link-install'),
  z.literal('unsupported'),
  z.literal('timeout'),
  z.literal('network'),
  z.literal('failed'),
]);
const upgradeResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), version: z.string(), restartRequired: z.literal(true), reason: z.null() }),
  z.object({ status: z.literal('error'), version: z.string(), restartRequired: z.literal(false), reason: upgradeReasonSchema }),
]);

/** 错误分支：码与消息透传，details 为任意 JSON 对象。 */
const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
});

/** 成功/失败信封，与 Client 收到的 RemoteResult 同形。 */
function envelope(value: z.ZodTypeAny): z.ZodTypeAny {
  return z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: errorSchema }),
  ]);
}

/**
 * 严格 codec：同时带 `schema` 与 `create` 双形态。
 *
 * 已发布的 dsh 读 `schema` 实例；新版 checkout 改为延迟物化、只认 `create()`
 * 工厂（见 harness `perf(typert): materialize generated schemas on first use`，
 * 旧形态在 `$mount` 校验里以 `has no create() factory` 拒绝，浏览器端 entry 报 failed）。
 * 双字段各取所需：两者指向同一份 zod 定义，无行为差异。
 */
function strictCodec(typeSymbol: string, schema: z.ZodTypeAny): {
  readonly mode: 'strict';
  readonly typeSymbol: string;
  readonly schema: z.ZodTypeAny;
  readonly create: () => z.ZodTypeAny;
} {
  return { mode: 'strict', typeSymbol, schema, create: () => schema };
}

/** 单个具名必填 request 参数的描述符条目。 */
function requestParam(typeSymbol: string, schema: z.ZodTypeAny): {
  readonly name: 'request';
  readonly wire: 'request';
  readonly source: 'json';
  readonly codec: ReturnType<typeof strictCodec>;
} {
  return { name: 'request', wire: 'request', source: 'json', codec: strictCodec(typeSymbol, schema) };
}

/** 可挂载的严格贡献：12 个一元方法，无 lookup、无取消。 */
export const USAGE_STATS_REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors: [
    {
      id: `${PACKAGE}#${NAMESPACE}/snapshot`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'snapshot',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#SnapshotRequest`, snapshotRequestSchema)],
      result: strictCodec(`${PACKAGE}/types#UsageSnapshot`, envelope(usageSnapshotSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/modelDetail`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'modelDetail',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#ModelDetailRequest`, modelDetailRequestSchema)],
      result: strictCodec(`${PACKAGE}/types#ModelDetail`, envelope(modelDetailSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/dateDetail`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'dateDetail',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#DateDetailRequest`, dateDetailRequestSchema)],
      result: strictCodec(`${PACKAGE}/types#DateDetail`, envelope(dateDetailSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/sessionDetail`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'sessionDetail',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#SessionDetailRequest`, sessionDetailRequestSchema)],
      result: strictCodec(`${PACKAGE}/types#SessionDetail`, envelope(sessionDetailSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/rebuild`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'rebuild',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec(`${PACKAGE}/types#RebuildResult`, envelope(rebuildResultSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/clear`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'clear',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec(`${PACKAGE}/types#ClearResult`, envelope(clearResultSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/seal`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'seal',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec(`${PACKAGE}/types#SealResult`, envelope(sealResultSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/goQuota`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'goQuota',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#QuotaRequest`, quotaRequestSchema)],
      result: strictCodec(`${PACKAGE}/types#GoQuota`, envelope(goQuotaSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/deepseekBalance`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'deepseekBalance',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#QuotaRequest`, quotaRequestSchema)],
      result: strictCodec(`${PACKAGE}/types#DeepSeekBalance`, envelope(deepSeekBalanceSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/zaiQuota`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'zaiQuota',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#QuotaRequest`, quotaRequestSchema)],
      result: strictCodec(`${PACKAGE}/types#ZaiQuota`, envelope(zaiQuotaSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/checkUpdate`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'checkUpdate',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#UpdateCheckRequest`, updateCheckRequestSchema)],
      result: strictCodec(`${PACKAGE}/types#UpdateCheckResult`, envelope(updateCheckResultSchema)),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/upgrade`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'upgrade',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#UpgradeRequest`, upgradeRequestSchema)],
      result: strictCodec(`${PACKAGE}/types#UpgradeResult`, envelope(upgradeResultSchema)),
    },
  ],
};

/** 方法名表：测试断言贡献与服务一致的单一来源。 */
export const METHOD_NAMES = [
  'snapshot',
  'modelDetail',
  'dateDetail',
  'sessionDetail',
  'rebuild',
  'clear',
  'seal',
  'goQuota',
  'deepseekBalance',
  'zaiQuota',
  'checkUpdate',
  'upgrade',
] as const;

/** Client 类型合并：引入本模块即挂上 ctx.remote.usageStats 的完整签名。 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$75736167655374617473 {
    snapshot: (request: SnapshotRequest) => Promise<RemoteResult<UsageSnapshot>>
    modelDetail: (request: ModelDetailRequest) => Promise<RemoteResult<ModelDetail>>
    dateDetail: (request: DateDetailRequest) => Promise<RemoteResult<DateDetail>>
    sessionDetail: (request: SessionDetailRequest) => Promise<RemoteResult<SessionDetail>>
    rebuild: () => Promise<RemoteResult<RebuildResult>>
    clear: () => Promise<RemoteResult<ClearResult>>
    seal: () => Promise<RemoteResult<SealResult>>
    goQuota: (request: QuotaRequest) => Promise<RemoteResult<GoQuota>>
    deepseekBalance: (request: QuotaRequest) => Promise<RemoteResult<DeepSeekBalance>>
    zaiQuota: (request: QuotaRequest) => Promise<RemoteResult<ZaiQuota>>
    checkUpdate: (request: UpdateCheckRequest) => Promise<RemoteResult<UpdateCheckResult>>
    upgrade: (request: UpgradeRequest) => Promise<RemoteResult<UpgradeResult>>
  }
  interface TypertRemoteMap {
    'usageStats/snapshot': (request: SnapshotRequest) => Promise<RemoteResult<UsageSnapshot>>
    'usageStats/modelDetail': (request: ModelDetailRequest) => Promise<RemoteResult<ModelDetail>>
    'usageStats/dateDetail': (request: DateDetailRequest) => Promise<RemoteResult<DateDetail>>
    'usageStats/sessionDetail': (request: SessionDetailRequest) => Promise<RemoteResult<SessionDetail>>
    'usageStats/rebuild': () => Promise<RemoteResult<RebuildResult>>
    'usageStats/clear': () => Promise<RemoteResult<ClearResult>>
    'usageStats/seal': () => Promise<RemoteResult<SealResult>>
    'usageStats/goQuota': (request: QuotaRequest) => Promise<RemoteResult<GoQuota>>
    'usageStats/deepseekBalance': (request: QuotaRequest) => Promise<RemoteResult<DeepSeekBalance>>
    'usageStats/zaiQuota': (request: QuotaRequest) => Promise<RemoteResult<ZaiQuota>>
    'usageStats/checkUpdate': (request: UpdateCheckRequest) => Promise<RemoteResult<UpdateCheckResult>>
    'usageStats/upgrade': (request: UpgradeRequest) => Promise<RemoteResult<UpgradeResult>>
  }
  interface TypertRemoteNamespaceMap {
    'usageStats': TypertRemoteNamespace$75736167655374617473
  }
}

/** 静态类型 re-export：Client 以 import type 引入本模块即激活命名空间合并。 */
export type {
  ClearResult,
  DateDetail,
  DateDetailRequest,
  DeepSeekBalance,
  GoQuota,
  ModelDetail,
  ModelDetailRequest,
  QuotaRequest,
  RebuildResult,
  SealResult,
  SessionDetail,
  SessionDetailRequest,
  SnapshotRequest,
  UpdateCheckRequest,
  UpdateCheckResult,
  UpdateInstallKind,
  UpgradeFailureReason,
  UpgradeRequest,
  UpgradeResult,
  UsageSnapshot,
  ZaiQuota,
};
