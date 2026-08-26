/**
 * JSON API 的 HTTP 辅助：请求体读取、JSON 响应写出、回环信任围栏与 CSRF 自定义头围栏。
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { errorMessage } from '../utils.ts'

/** 读取 POST 请求体（≤1MB），空体按 {} 处理，非法 JSON 抛错。 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > 1 << 20) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 写一段 JSON 响应。 */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** 成功响应：{ ok: true, value }。 */
export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** 内部错误响应：{ ok: false, error: { code: 'internal', message } }。 */
export function writeError(res: ServerResponse, error: unknown): void {
  writeJson(res, 500, { ok: false, error: { code: 'internal', message: errorMessage(error) } })
}

/** JSON API 的信任围栏：仅回环 Host 可访问（防 DNS 重绑定 / 跨站探测，
 *  DSH web 服务绑定 127.0.0.1）。 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  let hostname = hostHeader.trim()
  const at = hostname.lastIndexOf('@')
  if (at !== -1) hostname = hostname.slice(at + 1)
  // 主机名大小写不敏感，统一小写后再校验
  hostname = hostname.toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    if (end === -1) return false
    if (hostname.slice(1, end) !== '::1') return false
    const rest = hostname.slice(end + 1)
    // 括号后只能为空或 :port
    if (rest === '') return true
    return /^:\d+$/.test(rest)
  }
  if (hostname === '::1') return true
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && hostname.indexOf(']') === -1 && hostname.indexOf(':') === colon) {
    hostname = hostname.slice(0, colon)
  }
  if (hostname === 'localhost') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** CSRF 围栏要求的自定义请求头名与值（两者一致）。 */
export const USAGE_STATS_HEADER_NAME = 'x-dsh-usage-stats'
export const USAGE_STATS_HEADER_VALUE = 'dsh-usage-stats'

/**
 * CSRF 自定义头围栏：回环围栏之后的第二道校验。浏览器跨站请求（表单 /
 * 简单请求）无法携带非简单自定义头，缺失或不匹配即拒绝，与回环围栏
 * 共同构成 JSON API 的信任边界（响应与非回环 403 同形）。
 */
export function hasUsageStatsHeader(headers: IncomingHttpHeaders | undefined): boolean {
  if (!headers) return false
  const value = headers[USAGE_STATS_HEADER_NAME]
  if (Array.isArray(value)) return value.includes(USAGE_STATS_HEADER_VALUE)
  return value === USAGE_STATS_HEADER_VALUE
}