/**
 * 用量统计界面的纯函数：格式化、分桶、曲线与热力图几何。
 * 不依赖 React / DOM，可单测，角标与模态窗共用。
 * 本地日划分 / 日期键（startOfDay / dateKeyOf）来自 utils.ts；类型
 * （SeriesPoint / UsageAgg）来自 types.ts（与 host 端共用，避免两端镜像漂移）。
 */

import type { SeriesPoint, UsageAgg } from '../types.ts'
import { dateKeyOf, startOfDay } from '../utils.ts'

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

/** 本地日划分（utils.ts 单一事实来源）。 */
export { startOfDay } from '../utils.ts'
export const dayLabel = (t: number): string => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() }
export const fullDayLabel = (t: number): string => dateKeyOf(t)

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
  // 桶 key 从今天零点按本地日历逐日推进（Date.setDate，与 heatGridOf 同款），
  // 不用 todayStart - i * 86400000 毫秒回推：夏令时切换日的相邻本地零点间隔
  // 不是 24h，毫秒回推会让桶 key 整体漂移、匹配不上 host 端 startOfDay 的
  // 产出；非 DST 时区两者完全等价（t 仍为本地零点毫秒）。
  const cursor = new Date(todayStart)

  if (days !== null) {
    cursor.setDate(cursor.getDate() - (days - 1))
    const buckets: SeriesPoint[] = []
    for (let i = days - 1; i >= 0; i--) {
      const t = cursor.getTime()
      buckets.push(Object.assign(zero(t), map[t]))
      cursor.setDate(cursor.getDate() + 1)
    }
    return buckets
  }
  // 全量范围：从最早一天到今天（含两端），桶数 = diff + 1
  let spanDays = 1
  if (raw.length > 0) {
    let firstT = todayStart
    raw.forEach((p) => { if (p.t != null && p.t < firstT) firstT = p.t })
    const diff = Math.round((todayStart - startOfDay(firstT)) / 86400000)
    spanDays = Math.max(1, diff + 1)
  }
  cursor.setDate(cursor.getDate() - (spanDays - 1))
  const buckets: SeriesPoint[] = []
  for (let i = spanDays - 1; i >= 0; i--) {
    const t = cursor.getTime()
    buckets.push(Object.assign(zero(t), map[t]))
    cursor.setDate(cursor.getDate() + 1)
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

/** 热力图单个格子的数据（Codex 风格 26 周网格的一格）。 */
export interface HeatGridCell {
  /** 当天 0 点时间戳。 */
  t: number
  /** 当天 total tokens（与曲线一致：input+output+cacheRead+cacheWrite）。 */
  v: number
  /** 当天调用次数。 */
  calls: number
  /** 强度档 0..4：0 = 无用量（底色+边框），1..4 按窗口最大值占比。 */
  lvl: number
  /** 是否今天（外框高亮）。 */
  today: boolean
  /** yyyy-mm-dd 标签（tooltip 用）。 */
  label: string
}

/** Codex 风格 26 周热力图：列 = 周（周一..周日，自上而下），列优先。 */
export interface HeatGrid {
  /** 周数（列数）。 */
  cols: number
  /** 列优先的格子序列：每周 7 格（周一..周日），从最老的一周排到本周。 */
  cells: HeatGridCell[]
  /** 每列（周）的月份标签：0..11 月索引；与上一列同月时为 null（不显示）。 */
  months: Array<number | null>
}

/** 由日序列构建 Codex 风格 26 周热力图（列 = 周，行 = 周一..周日）。 */
export function heatGridOf(series: SeriesPoint[], weeks = 26): HeatGrid {
  const byDate = new Map<string, SeriesPoint>()
  for (const p of series) if (p && p.t != null) byDate.set(fullDayLabel(p.t), p)

  const today = startOfDay(Date.now())
  const end = new Date(today)
  // 对齐到本周周日（getDay(): 周日=0 … 周六=6，(d+6)%7 → 周一=0…周日=6）。
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)))

  const cells: HeatGridCell[] = []
  const months: Array<number | null> = []
  let lastMonth = -1
  for (let w = weeks - 1; w >= 0; w -= 1) {
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(end)
      d.setDate(d.getDate() - (w * 7 + (6 - i)))
      const label = fullDayLabel(d.getTime())
      const day = byDate.get(label)
      const v = day ? dayTotal(day) : 0
      cells.push({
        t: d.getTime(), v, calls: day?.calls ?? 0, lvl: 0,
        today: label === fullDayLabel(today), label,
      })
    }
    const m = new Date(end)
    m.setDate(m.getDate() - (w * 7 + 6)) // 该周周一（列首）
    months.push(m.getMonth() !== lastMonth ? m.getMonth() : null)
    lastMonth = m.getMonth()
  }

  // 强度 4 档：按窗口内最大值占比分档。
  let max = 1
  for (const c of cells) if (c.v > max) max = c.v
  for (const c of cells) {
    if (c.v <= 0) continue
    const ratio = c.v / max
    c.lvl = ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4
  }
  return { cols: weeks, cells, months }
}
