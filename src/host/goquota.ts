/**
 * OpenCode Go 订阅额度查询：滚动 5 小时 / 本周 / 本月三档用量百分比
 * 与重置时间（`GET https://opencode.ai/zen/go/v1/usage`）。
 *
 * 机制与 dsh-cost-meter 同款：
 *   - 官方固定域名端点；Bearer key + 浏览器 UA（否则被 opencode.ai 前置
 *     Cloudflare 以 error 1010 拦截）。
 *   - key 解析：环境变量 OPENCODE_GO_API_KEY → 兼容旧名 OPENCODE_API_KEY
 *     → opencode CLI 登录态 auth.json 自动发现（与 opencode CLI 共用登录态，
 *     key 在 `auth.json['opencode-go'].key`）。
 *   - 结果带 TTL 缓存（5 分钟）+ 单飞（并发请求只打一次官方端点）。
 *
 * 纯数据模块：请求失败 / 未配置 key 都返回带 status 的结构化结果，由
 * 客户端按 status 本地化文案，不在服务端拼用户文案。
 */
import { readFileSync } from 'node:fs'

/** OpenCode Go 官方额度端点（固定域名）。 */
const GO_QUOTA_URL = 'https://opencode.ai/zen/go/v1/usage'
/** 浏览器 UA：避免被 opencode.ai 前置 Cloudflare 以 error 1010 拦截。 */
const GO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** 结果缓存时长：客户端轮询期间不反复打官方端点。 */
const CACHE_TTL_MS = 5 * 60 * 1000

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

/** 从 opencode auth.json 自动发现 opencode-go 的 API Key（与 opencode CLI 共用登录态）。 */
function findGoKeyInAuthJson(): string | null {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = [
    home ? `${home}/.local/share/opencode/auth.json` : '',
    process.env.XDG_CONFIG_HOME ? `${process.env.XDG_CONFIG_HOME}/opencode/auth.json` : '',
    home ? `${home}/.config/opencode/auth.json` : '',
  ].filter(Boolean)
  for (const path of candidates) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'))
      const key = data?.['opencode-go']?.key
      if (typeof key === 'string' && key.length > 0) return key
    } catch {
      // 文件不存在或不可读：继续尝试下一个位置。
    }
  }
  return null
}

/** 解析 OpenCode Go API Key：环境变量 → opencode auth.json 兜底。 */
export function resolveGoKey(): string | null {
  for (const name of ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']) {
    const value = String(process.env[name] ?? '').trim()
    if (value.length > 0) return value
  }
  return findGoKeyInAuthJson()
}

/** 归一化单个额度窗口（percent + resetsAt），字段缺失/非法返回 null。 */
function normalizeGoWindow(raw: unknown): GoWindow | null {
  if (raw === null || typeof raw !== 'object') return null
  const { percent, resetsAt } = raw as { percent?: unknown; resetsAt?: unknown }
  const p = Number(percent)
  if (!Number.isFinite(p)) return null
  return { percent: p, resetsAt: typeof resetsAt === 'string' ? resetsAt : '' }
}

/** 实时查询 OpenCode Go 额度（无缓存）。 */
export async function fetchGoQuota(): Promise<GoQuota> {
  const key = resolveGoKey()
  if (key === null) {
    // 未配置 Key 属预期场景：客户端以中性提示展示。
    return { status: 'no-key', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null }
  }
  try {
    const response = await fetch(GO_QUOTA_URL, {
      headers: {
        authorization: `Bearer ${key}`,
        'user-agent': GO_UA,
      },
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 401 || response.status === 403) {
      // 无订阅 / Key 无效：同样属预期场景。
      return { status: 'no-key', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null }
    }
    if (!response.ok) {
      return { status: 'error', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null }
    }
    const data = (await response.json()) as { usage?: { rolling?: unknown; weekly?: unknown; monthly?: unknown } }
    const usage = data?.usage
    if (usage === null || typeof usage !== 'object') {
      return { status: 'error', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null }
    }
    return {
      status: 'ok',
      fetchedAt: Date.now(),
      rolling: normalizeGoWindow(usage.rolling),
      weekly: normalizeGoWindow(usage.weekly),
      monthly: normalizeGoWindow(usage.monthly),
    }
  } catch {
    return { status: 'error', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null }
  }
}

let cache: { at: number; quota: GoQuota } | null = null
let inflight: Promise<GoQuota> | null = null

/** 带 TTL 缓存 + 单飞的额度查询（路由每次调用都走这里）。 */
export async function queryGoQuota(): Promise<GoQuota> {
  const now = Date.now()
  if (cache !== null && now - cache.at < CACHE_TTL_MS) return cache.quota
  if (inflight === null) {
    inflight = fetchGoQuota().then((quota) => {
      cache = { at: Date.now(), quota }
      return quota
    }).finally(() => {
      inflight = null
    })
  }
  return inflight
}