/**
 * 用量统计界面的纯函数：格式化、分桶、曲线与热力图几何。
 * 不依赖 React / DOM，可单测，角标与模态窗共用。
 */

import type { SeriesPoint, UsageAgg } from './useSnapshot.ts'

/** 紧凑 token 格式化：1.2万 / 3.4亿 / 万以下原样。 */
export function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '--'
  const trim = (v: number, d: number): string => String(v.toFixed(d)).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
  if (n >= 1e8) { const v = n / 1e8; return trim(v, v >= 100 ? 0 : v >= 10 ? 1 : 2) + '亿' }
  if (n >= 1e4) { const v = n / 1e4; return trim(v, v >= 100 ? 0 : v >= 10 ? 1 : 2) + '万' }
  return String(Math.round(n))
}

/** 完整 token 计数（千分位）。 */
export function fmtFull(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '--'
  return Math.round(n).toLocaleString('en-US')
}

/** 短会话 id：前 6 位 + … + 后 4 位。 */
export function shortId(id: string): string {
  if (!id) return '--'
  const s = String(id)
  return s.length > 10 ? s.slice(0, 6) + '…' + s.slice(-4) : s
}

/** total = input + output + cacheRead + cacheWrite（reasoning 不计入）。 */
export function dayTotal(b: SeriesPoint | Partial<UsageAgg>): number {
  return (b.input || 0) + (b.output || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0)
}

export function usageTotal(u: UsageAgg): number {
  return u && u.total || 0
}

export function pctOf(v: number | null | undefined): string {
  return v === null || v === undefined || isNaN(v) ? '--' : v + '%'
}

/** 全角字符（CJK 表意文字、假名、谚文、全角标点）在视觉上占 2 个半角单位。 */
const FULLWIDTH_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

/** 字符串的视觉宽度（半角单位）：全角字符计 2，其余计 1。 */
export function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) w += FULLWIDTH_RE.test(ch) ? 2 : 1
  return w
}

/** 对齐填充字符：U+3000 恰好 1em（与全角字符等宽），NBSP 为半角空格。 */
const PAD_FULL = '\u3000'
const PAD_HALF = '\u00a0'

/**
 * 补 n 个半角单位的填充：每 2 单位用 U+3000（1em），余 1 单位用 NBSP。
 * NBSP / U+3000 都不是可折叠空格，tooltip 的 white-space: pre-line 不会
 * 吞掉它们（U+3000 恰好 1em，能跟全角标签严格对齐；NBSP 用于半角缺口）。
 */
function padUnits(n: number): string {
  return PAD_FULL.repeat(n >> 1) + PAD_HALF.repeat(n & 1)
}

/**
 * 构建对齐的多行 tooltip 文本：标签列按视觉宽度补足（全角字符计 2 个半角
 * 单位，避免中英混排按字符数填充导致的错位），数字列右对齐。
 * @param rows [标签, 数字] 数组
 */
export function alignedRows(rows: [string, string][]): string {
  if (rows.length === 0) return ''
  const maxLabel = Math.max(...rows.map((r) => visualWidth(r[0])))
  const maxNum = Math.max(...rows.map((r) => visualWidth(r[1])))
  return rows
    .map((r) => r[0] + padUnits(maxLabel - visualWidth(r[0])) + PAD_HALF + padUnits(maxNum - visualWidth(r[1])) + r[1])
    .join('\n')
}

export const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
export const dayLabel = (t: number): string => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() }
export const fullDayLabel = (t: number): string => {
  const d = new Date(t)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 取序列中最新一天的点（底部角标读今日数据用）。 */
export function todayOf(series: SeriesPoint[]): SeriesPoint | undefined {
  const today = startOfDay(Date.now())
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].t === today) return series[i]
    if (series[i].t < today) break
  }
  return undefined
}

/** 按范围分桶：'7d' | '14d' | '30d' | 'all'。 */
export function buildSet(series: SeriesPoint[], range: string): SeriesPoint[] {
  const days = range === '7d' ? 7 : range === '14d' ? 14 : range === '30d' ? 30 : null
  const raw = (series && series.length ? series : [])
  const map: Record<number, SeriesPoint> = {}
  raw.forEach((p) => { if (p && p.t != null) map[p.t] = p })
  const todayStart = startOfDay(Date.now())
  const zero = (t: number): SeriesPoint =>
    ({ t, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 })

  if (days !== null) {
    const buckets: SeriesPoint[] = []
    for (let i = days - 1; i >= 0; i--) {
      const t = todayStart - i * 86400000
      buckets.push(Object.assign(zero(t), map[t]))
    }
    return buckets
  }
  let spanDays = 1
  if (raw.length > 0) {
    let firstT = todayStart
    raw.forEach((p) => { if (p.t != null && p.t < firstT) firstT = p.t })
    spanDays = Math.max(1, Math.round((todayStart - startOfDay(firstT)) / 86400000))
  }
  const buckets: SeriesPoint[] = []
  for (let i = spanDays; i >= 0; i--) {
    const t = todayStart - i * 86400000
    buckets.push(Object.assign(zero(t), map[t]))
  }
  return buckets
}

export interface CurveGeometry {
  line: string
  area: string
  W: number
  H: number
  hits: Array<{ cx: number; cy: number; v: number; label: string; b: SeriesPoint }>
}

/** Catmull-Rom → 三次贝塞尔平滑路径（与 harness 图表同款平滑）。 */
function smoothPath(pts: number[][]): string {
  if (!pts || pts.length === 0) return ''
  if (pts.length === 1) return 'M' + pts[0][0] + ',' + pts[0][1]
  let d = 'M' + pts[0][0] + ',' + pts[0][1]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6) + ',' + (p1[1] + (p2[1] - p0[1]) / 6) + ' '
      + (p2[0] - (p3[0] - p1[0]) / 6) + ',' + (p2[1] - (p3[1] - p1[1]) / 6) + ' '
      + p2[0] + ',' + p2[1]
  }
  return d
}

/** 由日分桶构建 SVG 曲线几何。 */
export function curveOf(buckets: SeriesPoint[], W = 300, H = 140): CurveGeometry | null {
  if (!buckets.length) return null
  const PAD = 6
  let max = 1
  buckets.forEach((x) => { const v = dayTotal(x); if (v > max) max = v })
  const pts = buckets.map((x, i) => {
    const v = dayTotal(x)
    const px = PAD + (W - 2 * PAD) * (buckets.length === 1 ? 0.5 : i / (buckets.length - 1))
    const py = H - PAD - (H - 2 * PAD) * (v / max)
    return [px, py, v]
  })
  const line = smoothPath(pts.map((p) => [p[0], p[1]]))
  const area = pts.length
    ? line + ' L' + pts[pts.length - 1][0] + ',' + (H - PAD) + ' L' + pts[0][0] + ',' + (H - PAD) + ' Z'
    : ''
  const hits = pts.map((p, i) => ({ cx: p[0], cy: p[1], v: p[2], label: dayLabel(buckets[i].t), b: buckets[i] }))
  return { line, area, W, H, hits }
}

export interface HeatCell {
  t: number
  v: number
  calls: number
  lvl: number
  label: string
}

/** 热力图格子（每行 ≤7 列），强度 0..7 按最大值占比。 */
export function heatOf(buckets: SeriesPoint[]): { cols: number; cells: HeatCell[] } {
  if (!buckets.length) return { cols: 7, cells: [] }
  const cols = Math.min(7, buckets.length)
  const cells = buckets.map((x) => {
    const v = dayTotal(x)
    return { t: x.t, v, calls: x.calls || 0, lvl: 0, label: fullDayLabel(x.t) }
  })
  let max = 1
  cells.forEach((c) => { if (c.v > max) max = c.v })
  cells.forEach((c) => {
    const f = c.v / max
    c.lvl = f <= 0 ? 0 : Math.min(7, Math.max(1, Math.ceil(f * 7)))
  })
  return { cols, cells }
}
