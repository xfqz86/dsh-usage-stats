/**
 * Z.ai 智谱额度查询：滚动 5 小时、每周 7 天百分比与每月 Web 搜索次数，端点为 GET https://api.z.ai/api/monitor/usage/quota/limit。
 *
 * 机制要点：
 *   - 官方固定域名端点，Bearer key 与浏览器 UA 与 GoQuota、DeepSeek 同款以防前置拦截。
 *   - key 解析：仅走 DSH 凭据中心 `ZAI_CODING_CN_API_KEY` 到 `ZAI_API_KEY`，经 `ctx.credentials`
 *     由 `~/.dsh/.credentials.yaml` 等统一托管，不直接读 `process.env`，亦不使用 `GLM_API_KEY`。
 *   - 结果带 TTL 缓存 5 分钟与单飞机制，并发请求仅打一次官方端点。
 *   - 语义：无 key / 401/403 判为 no-key；合法 key 但无 GLM Coding Plan，success 为 false 且
 *     msg 含 "coding plan" 时判为 no-plan；非 2xx、超时或结构非法判为 error；成功判为 ok。
 *   - quota 端点响应：{ code:200, success:true, data:{ level?, limits:[{type, unit, number,
 *     percentage?, nextResetTime?, usage?, currentValue?}] } }；CREDIT_LIMIT /
 *     TOKENS_LIMIT 为百分比窗口，按 unit 归类为 session 与 weekly，TIME_LIMIT 为月度 Web 搜索计数。
 *
 * ZaiQuota / ZaiWindow / ZaiWebSearchQuota 协议类型定义在 types.ts，与客户端 useZaiQuota 统一。
 * 纯数据模块：请求失败 / 未配置 key 都返回带 status 的结构化结果，由
 * 客户端按 status 本地化文案，不在服务端拼用户文案。
 * 本功能不写入 ledger，仅只读查询与内存缓存。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';

import type { ZaiQuota, ZaiWebSearchQuota, ZaiWindow } from '../types.ts';
// 凭据中心类型来自 harness，AGENTS §0 约定禁止手写注入服务镜像类型。
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';

/** 协议类型单一定义在 types.ts，此处 re-export 保持对外引用面。 */
export type { ZaiQuota, ZaiWindow, ZaiWebSearchQuota } from '../types.ts';

/** DSH 凭据中心服务，Context.credentials 合并类型，cordis 可选注入，运行时可能缺席。 */
export type CredentialsService = CredentialProvider;

/** Z.ai 官方额度端点，固定域名，参考 openusage ZAIUsageClient.quotaURL。 */
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
/** 浏览器 UA：避免被前置 Cloudflare 拦截，与 GoQuota 同款。 */
const ZAI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** 服务端强制下限：官方额度端点任何情况下不低于 3 分钟打一次，与客户端设置下限对齐。 */
export const ZAI_MIN_FETCH_MS = 3 * 60 * 1000;
/** 结果缓存上限：默认 5 分钟；客户端可按抓取间隔调短有效缓存。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 解析 Z.ai API Key：仅走 DSH 凭据中心，经 ZAI_CODING_CN_API_KEY 到 ZAI_API_KEY。 */
export async function resolveZaiKeyWithCredentials(credentials?: CredentialsService): Promise<string | null> {
  if (credentials && typeof credentials.resolve === 'function') {
    for (const name of ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY']) {
      try {
        const ref = credentialRef(name);
        const resolved = await credentials.resolve(ref);
        if (resolved && typeof resolved.value === 'string' && resolved.value.trim().length > 0) return resolved.value.trim();
      } catch {
        // 凭据解析失败：继续尝试下一个名字
      }
    }
  }
  return null;
}

/** 把 number/数字字符串归一为非负有限数，其余返回 null。 */
function parseNonNegNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw >= 0 ? raw : null;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/** 归一化单个百分比额度窗口，非法返回 null。 */
function normalizeZaiWindow(raw: unknown): ZaiWindow | null {
  if (raw === null || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const percent = parseNonNegNumber(rec.percentage);
  if (percent === null) return null;
  // 夹在 0..100，由 utils.goPercent 再做最终夹取，此处保留原始浮点
  let resetsAt = '';
  const rt = rec.nextResetTime;
  if (typeof rt === 'number' && Number.isFinite(rt) && rt > 0) {
    // epoch 毫秒
    resetsAt = new Date(rt).toISOString();
  } else if (typeof rt === 'string' && rt.trim().length > 0) {
    // 已是字符串，ISO 或毫秒字符串
    const n = Number(rt);
    if (Number.isFinite(n) && n > 0) resetsAt = new Date(n).toISOString();
    else resetsAt = rt;
  } else if (typeof rec.resetsAt === 'string' && (rec.resetsAt as string).length > 0) {
    resetsAt = rec.resetsAt as string;
  }
  // 点数明细：官方 currentValue 已用量与 usage 总量，旧 payload 或部分账号不下发时为 null，
  // percentage 仍独立可用，与 openusage、OpenTokenUsage 文档的真实响应结构一致。
  const used = parseNonNegNumber(rec.currentValue ?? rec.used);
  const limit = parseNonNegNumber(rec.usage ?? rec.limit);
  return { percent, resetsAt, used, limit };
}

/** 归一化 Web 搜索次数额度，非法返回 null。 */
function normalizeZaiWebSearch(raw: unknown): ZaiWebSearchQuota | null {
  if (raw === null || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const used = parseNonNegNumber(rec.currentValue ?? rec.used);
  const limit = parseNonNegNumber(rec.usage ?? rec.limit);
  if (used === null || limit === null) return null;
  const percent = limit > 0 ? (used / limit) * 100 : 0;
  let resetsAt = '';
  const rt = rec.nextResetTime;
  if (typeof rt === 'number' && Number.isFinite(rt) && rt > 0) resetsAt = new Date(rt).toISOString();
  else if (typeof rt === 'string' && rt.trim().length > 0) {
    const n = Number(rt);
    if (Number.isFinite(n) && n > 0) resetsAt = new Date(n).toISOString();
    else resetsAt = rt;
  }
  return { used, limit, percent, resetsAt };
}

/** 按 unit 归类百分比窗口：子日为 session，多日为 weekly，与 ZAIUsageMapper.classifyTokenWindow 一致。 */
function classifyTokenWindow(entry: Record<string, unknown>): 'session' | 'weekly' | null {
  const unitRaw = entry.unit;
  const numberRaw = entry.number;
  const unit = typeof unitRaw === 'number' && Number.isFinite(unitRaw) ? unitRaw : null;
  const number = typeof numberRaw === 'number' && Number.isFinite(numberRaw) ? numberRaw : null;
  if (unit === null || number === null || number <= 0) return null;
  let unitMs: number | null = null;
  switch (unit) {
    case 3: unitMs = 60 * 60 * 1000; break; // 小时
    case 4: unitMs = 24 * 60 * 60 * 1000; break; // 天
    case 6: unitMs = 7 * 24 * 60 * 60 * 1000; break; // 周
    case 5: unitMs = 30 * 24 * 60 * 60 * 1000; break; // 月
    default: return null;
  }
  const periodMs = unitMs * number;
  if (periodMs < 24 * 60 * 60 * 1000) return 'session';
  return 'weekly';
}

/** 从 limits 数组中解析出各窗口。 */
function parseLimits(limits: unknown[]): { session: ZaiWindow | null; weekly: ZaiWindow | null; webSearches: ZaiWebSearchQuota | null; sawRecognized: boolean } {
  let session: ZaiWindow | null = null;
  let weekly: ZaiWindow | null = null;
  let webSearches: ZaiWebSearchQuota | null = null;
  let sawRecognized = false;

  // 百分比窗口 CREDIT_LIMIT 与 TOKENS_LIMIT 按 unit 归类
  const percentEntries: Record<string, unknown>[] = [];
  let timeEntry: Record<string, unknown> | null = null;
  for (const raw of limits) {
    if (raw === null || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    let type = '';
    if (typeof rec.type === 'string') type = rec.type;
    else if (typeof rec.name === 'string') type = rec.name;
    const rawType = typeof rec.rawType === 'string' ? rec.rawType : null;
    const effective = rawType ?? type;
    if (effective === 'CREDIT_LIMIT' || effective === 'TOKENS_LIMIT') {
      percentEntries.push(rec);
    } else if (type === 'TIME_LIMIT' || effective === 'TIME_LIMIT') {
      if (timeEntry === null) timeEntry = rec;
    } else if (type === 'CREDIT_LIMIT' || type === 'TOKENS_LIMIT' || type === 'TIME_LIMIT') {
      // 兼容仅含 type 字段且无 rawType 的情况
      if (type === 'TIME_LIMIT' && timeEntry === null) timeEntry = rec;
      else if ((type === 'CREDIT_LIMIT' || type === 'TOKENS_LIMIT')) percentEntries.push(rec);
    }
  }

  for (const entry of percentEntries) {
    const win = classifyTokenWindow(entry);
    if (win === null) continue;
    // 即使 percentage 缺失也算已识别，后续整体判为 error，避免静默丢弃
    sawRecognized = true;
    const norm = normalizeZaiWindow(entry);
    if (norm === null) continue;
    if (win === 'session' && session === null) session = norm;
    else if (win === 'weekly' && weekly === null) weekly = norm;
  }

  if (timeEntry !== null) {
    const norm = normalizeZaiWebSearch(timeEntry);
    if (norm !== null) {
      sawRecognized = true;
      webSearches = norm;
    } else {
      // TIME_LIMIT 存在但非法，仍算已识别，避免误判为空数据
      sawRecognized = true;
    }
  }

  // 兜底：若未按 rawType 命中，尝试按 type 精确匹配，兼容旧 payload 仅含 type 字段且值为 CREDIT_LIMIT 等的情况
  // 已在上循环覆盖，额外处理 TIME_LIMIT 遗漏
  if (webSearches === null) {
    for (const raw of limits) {
      if (raw === null || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const type = typeof rec.type === 'string' ? rec.type : '';
      if (type === 'TIME_LIMIT' && timeEntry === null) {
        const norm = normalizeZaiWebSearch(rec);
        if (norm !== null) {
          sawRecognized = true;
          webSearches = norm;
        }
        break;
      }
    }
  }

  return { session, weekly, webSearches, sawRecognized };
}

/** 实时查询 Z.ai 额度，无缓存。 */
export async function fetchZaiQuota(credentials?: CredentialsService): Promise<ZaiQuota> {
  const key = await resolveZaiKeyWithCredentials(credentials);
  if (key === null) {
    return { status: 'no-key', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
  }
  try {
    const response = await fetch(ZAI_QUOTA_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'user-agent': ZAI_UA,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'no-key', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
    }
    if (!response.ok) {
      return { status: 'error', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
    }
    const body = (await response.json()) as Record<string, unknown>;
    // 无 Coding Plan 信号：2xx 但 success 为 false 且 msg 含 coding plan，与 ZAIUsageMapper.isNoCodingPlan 一致
    const success = body.success;
    let msg = '';
    if (typeof body.msg === 'string') msg = body.msg;
    else if (typeof body.message === 'string') msg = body.message;
    if (success === false && typeof msg === 'string' && msg.toLowerCase().includes('coding plan')) {
      return { status: 'no-plan', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
    }
    // 成功码校验：code 200 或 success true 才视为可用，否则按 error 处理，除上述 no-plan 外
    const code = body.code;
    if (code !== undefined && code !== 200 && code !== '200' && success !== true) {
      // 某些旧响应可能无 success 字段，仅靠 code；此处若 code 非 200 且未被 no-plan 捕获，视为错误
      // 但若 code 缺失且 success 未显式 false，仍继续尝试解析 data.limits
      if (typeof code === 'number' || typeof code === 'string') {
        // 有明确错误码且非 200，判 error
        if (Number(code) !== 200) {
          return { status: 'error', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
        }
      }
    }
    const dataRaw = body.data;
    let dataObj: Record<string, unknown> | null = null;
    if (dataRaw !== null && typeof dataRaw === 'object' && !Array.isArray(dataRaw)) dataObj = dataRaw as Record<string, unknown>;
    else if (Array.isArray(dataRaw)) {
      // 异常形态：data 为数组时无 limits
      return { status: 'error', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
    }
    // 兼容 data 缺失时直接取顶层 limits，参考 ZAIUsageMapper 的容错
    const container: Record<string, unknown> = dataObj ?? body;
    const limitsRaw = container.limits;
    if (limitsRaw === undefined || limitsRaw === null) {
      // 无 limits 字段：若 success:false 已处理过，此处判 error
      return { status: 'error', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
    }
    if (!Array.isArray(limitsRaw)) {
      return { status: 'error', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
    }
    // 空数组：有效但无数据，对应 openusage 的 No usage data，仍返回 ok 且窗口全空
    if (limitsRaw.length === 0) {
      // plan 可能仍有 level
      let plan: string | null = null;
      const level = typeof container.level === 'string' ? container.level.trim() : '';
      if (level.length > 0) plan = 'Z.ai ' + level;
      return { status: 'ok', fetchedAt: Date.now(), plan, session: null, weekly: null, webSearches: null };
    }
    // plan 名：优先 data.level，如 pro 转为 Z.ai pro，与 quotas 的 parse_response 一致
    let plan: string | null = null;
    const levelRaw = container.level;
    if (typeof levelRaw === 'string' && levelRaw.trim().length > 0) {
      plan = 'Z.ai ' + levelRaw.trim();
    }

    const parsed = parseLimits(limitsRaw);
    // 若没有任何可识别窗口且 sawRecognized 为 false，说明 limits 全为未知类型，视为 ok 但无数据
    // 若 sawRecognized 为 true 但解析后全空，如 percentage 缺失时视为 error，参考 ZAIQuotaValidationTests
    const hasAny = parsed.session !== null || parsed.weekly !== null || parsed.webSearches !== null;
    if (!hasAny && parsed.sawRecognized) {
      // 已识别类型但归一化失败，如缺 percentage 等，视为 error
      return { status: 'error', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
    }

    return {
      status: 'ok',
      fetchedAt: Date.now(),
      plan,
      session: parsed.session,
      weekly: parsed.weekly,
      webSearches: parsed.webSearches,
    };
  } catch {
    return { status: 'error', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
  }
}

let cache: { at: number; value: ZaiQuota } | null = null;
let inflight: Promise<ZaiQuota> | null = null;

/**
 * 带 TTL 缓存与单飞的额度查询，路由每次调用都走这里。
 *
 * @param intervalMinutes 客户端抓取间隔，单位分钟，有效缓存为
 *   min 5 分钟上限、max 3 分钟下限与请求间隔的较大值 —— 让实际打官方端点的频率与
 *   设置一致，且不短于 3 分钟，未提供时用默认 5 分钟。
 * @param force 为 true 时绕过 TTL 缓存强制重新抓取，概览 Z.ai 磁贴的立即刷新按钮用，仍走单飞，避免并发打官方端点。
 */
export async function queryZaiQuota(
  intervalMinutes?: number,
  force = false,
  credentials?: CredentialsService,
): Promise<ZaiQuota> {
  const effectiveTtlMs =
    typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes)
      ? Math.min(CACHE_TTL_MS, Math.max(ZAI_MIN_FETCH_MS, Math.round(intervalMinutes * 60 * 1000)))
      : CACHE_TTL_MS;
  const now = Date.now();
  if (!force && cache !== null && now - cache.at < effectiveTtlMs) return cache.value;
  if (force && cache !== null && now - cache.at < ZAI_MIN_FETCH_MS && inflight === null) {
    // force 距上次抓取过近且无进行中的请求：打官方端点频率受强制下限保护，
    // 返回上一次结果即可，避免刷爆官方额度接口。
    return cache.value;
  }
  if (inflight === null) {
    inflight = fetchZaiQuota(credentials)
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
