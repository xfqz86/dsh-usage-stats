/**
 * usageStats 命名空间的手写严格 Remote 贡献。
 *
 * 本插件是独立仓库，跑不了 harness 仓库内 Typert 生成器的
 * workspace 管线（包发现强制要求包位于 <root>/packages/ 下），
 * 因此 Client 挂载用的严格描述符与 zod 编解码在此手写，
 * Host 侧则走文档化的 SRC 分发（@Remote 装饰器标记 + 实时服务绑定，
 * 与 dev 模式同源）。两者等价性由测试锁定：
 * test/pure.mjs 断言每个方法的 zod 收发与 service 实际出入相容，
 * test/smoke.mjs 直接调用 service 方法验证业务语义。
 *
 * 维护规则与生成产物一致：只改方法实现体不动本文件；
 * 增删方法、改命名空间、改参数/返回值形状时必须同步改这里的
 * 描述符与 schema，否则 Client 挂载或调用校验会失败。
 * 错误分支有意放宽（code 为任意字符串）：网关透传的码原样过线，
 * 未知码也不应破坏信封解析；成功分支保持精确。
 */

import { z } from 'zod';

import type {
  ClearResult,
  DeepSeekBalance,
  GoQuota,
  QuotaRequest,
  RebuildResult,
  SealResult,
  SnapshotRequest,
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
  status: z.union([z.literal('ok'), z.literal('no-key'), z.literal('error')]),
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

const quotaRequestSchema = z.object({
  intervalMinutes: z.number().optional(),
  force: z.boolean().optional(),
});

const rebuildResultSchema = z.object({ rebuilt: z.boolean(), foldedEvents: z.number() });
const clearResultSchema = z.object({ cleared: z.boolean(), foldedEvents: z.number() });
const sealResultSchema = z.object({
  sealed: z.boolean(),
  sealedUntil: z.number(),
  foldedEvents: z.number(),
});

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

/** 单个具名必填 request 参数的描述符条目。 */
function requestParam(typeSymbol: string, schema: z.ZodTypeAny): {
  readonly name: 'request';
  readonly wire: 'request';
  readonly source: 'json';
  readonly codec: { readonly mode: 'strict'; readonly typeSymbol: string; readonly schema: z.ZodTypeAny };
} {
  return { name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol, schema } };
}

/** 可挂载的严格贡献：7 个一元方法，无 lookup、无取消。 */
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
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#UsageSnapshot`, schema: envelope(usageSnapshotSchema) },
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/rebuild`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'rebuild',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#RebuildResult`, schema: envelope(rebuildResultSchema) },
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/clear`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'clear',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ClearResult`, schema: envelope(clearResultSchema) },
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/seal`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'seal',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#SealResult`, schema: envelope(sealResultSchema) },
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/goQuota`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'goQuota',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#QuotaRequest`, quotaRequestSchema)],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#GoQuota`, schema: envelope(goQuotaSchema) },
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/deepseekBalance`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'deepseekBalance',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#QuotaRequest`, quotaRequestSchema)],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#DeepSeekBalance`, schema: envelope(deepSeekBalanceSchema) },
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/zaiQuota`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'zaiQuota',
      invocation: { kind: 'direct' },
      parameters: [requestParam(`${PACKAGE}/types#QuotaRequest`, quotaRequestSchema)],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ZaiQuota`, schema: envelope(zaiQuotaSchema) },
    },
  ],
};

/** 方法名表：测试断言贡献与服务一致的单一来源。 */
export const METHOD_NAMES = [
  'snapshot',
  'rebuild',
  'clear',
  'seal',
  'goQuota',
  'deepseekBalance',
  'zaiQuota',
] as const;

/** Client 类型合并：引入本模块即挂上 ctx.remote.usageStats 的完整签名。 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$75736167655374617473 {
    snapshot: (request: SnapshotRequest) => Promise<RemoteResult<UsageSnapshot>>
    rebuild: () => Promise<RemoteResult<RebuildResult>>
    clear: () => Promise<RemoteResult<ClearResult>>
    seal: () => Promise<RemoteResult<SealResult>>
    goQuota: (request: QuotaRequest) => Promise<RemoteResult<GoQuota>>
    deepseekBalance: (request: QuotaRequest) => Promise<RemoteResult<DeepSeekBalance>>
    zaiQuota: (request: QuotaRequest) => Promise<RemoteResult<ZaiQuota>>
  }
  interface TypertRemoteMap {
    'usageStats/snapshot': (request: SnapshotRequest) => Promise<RemoteResult<UsageSnapshot>>
    'usageStats/rebuild': () => Promise<RemoteResult<RebuildResult>>
    'usageStats/clear': () => Promise<RemoteResult<ClearResult>>
    'usageStats/seal': () => Promise<RemoteResult<SealResult>>
    'usageStats/goQuota': (request: QuotaRequest) => Promise<RemoteResult<GoQuota>>
    'usageStats/deepseekBalance': (request: QuotaRequest) => Promise<RemoteResult<DeepSeekBalance>>
    'usageStats/zaiQuota': (request: QuotaRequest) => Promise<RemoteResult<ZaiQuota>>
  }
  interface TypertRemoteNamespaceMap {
    'usageStats': TypertRemoteNamespace$75736167655374617473
  }
}

/** 静态类型 re-export：Client 以 import type 引入本模块即激活命名空间合并。 */
export type {
  ClearResult,
  DeepSeekBalance,
  GoQuota,
  QuotaRequest,
  RebuildResult,
  SealResult,
  SnapshotRequest,
  UsageSnapshot,
  ZaiQuota,
};
