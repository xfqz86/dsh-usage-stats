/**
 * 用量统计界面的纯函数：格式化、分桶、曲线与热力图几何。
 * 不依赖 React / DOM，可单测，角标与模态窗共用。
 * 本地日划分 / 日期键（startOfDay / dateKeyOf）来自 utils.ts；类型
 * （SeriesPoint / UsageAgg）来自 types.ts（与 host 端共用，避免两端镜像漂移）。
 */

import type { SeriesPoint, UsageAgg } from '../types.ts'
import type { SessionStat } from './useSnapshot.ts'
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

/** 按会话分组：主会话 + 其子代理（子代理折叠到主会话，孤儿回落顶层，多级展平到根）。 */
export interface SessionGroup {
  main: SessionStat
  children: SessionStat[]
  agg: { calls: number; usage: UsageAgg }
  childCount: number
}

/** 将用量聚合相加（纯函数，返回新 UsageAgg）。 */
function addUsage(a: UsageAgg, b: UsageAgg): UsageAgg {
  return {
    input: (a.input || 0) + (b.input || 0),
    output: (a.output || 0) + (b.output || 0),
    cacheRead: (a.cacheRead || 0) + (b.cacheRead || 0),
    cacheWrite: (a.cacheWrite || 0) + (b.cacheWrite || 0),
    reasoning: (a.reasoning || 0) + (b.reasoning || 0),
    total: (a.total || 0) + (b.total || 0),
  }
}

/** 按会话 id 分组：子代理（origin==='subagent' 且 parentSession 指向存在会话）折叠到根主会话，孤儿回落顶层，多级展平。 */
export function groupSessions(list: SessionStat[]): SessionGroup[] {
  if (!list || list.length === 0) return []
  const byId = new Map<string, SessionStat>()
  for (const s of list) byId.set(s.id, s)

  // 判定是否为子代理（需 parent 存在）
  const isChild = (s: SessionStat): boolean =>
    s.origin === 'subagent' && typeof s.parentSession === 'string' && s.parentSession !== '' && byId.has(s.parentSession)

  // 找根主会话：从 parent 出发沿链上溯至不再是子代理的节点（多级展平），防环
  const findRoot = (parentId: string): string => {
    let cur = parentId
    const seen = new Set<string>()
    while (true) {
      if (seen.has(cur)) break
      seen.add(cur)
      const node = byId.get(cur)
      if (!node) break
      if (node.origin !== 'subagent' || !node.parentSession || !byId.has(node.parentSession)) break
      cur = node.parentSession!
    }
    return cur
  }

  const childrenMap = new Map<string, SessionStat[]>()
  const mains = new Set<string>()

  for (const s of list) {
    if (isChild(s)) {
      const rootId = findRoot(s.parentSession!)
      if (byId.has(rootId)) {
        const arr = childrenMap.get(rootId)
        if (arr) arr.push(s)
        else childrenMap.set(rootId, [s])
      } else {
        // 根不存在（理论上 isChild 已保证 parent 存在，此分支仅防御并发或环）
        mains.add(s.id)
      }
    } else {
      mains.add(s.id)
    }
  }

  // 构建分组：每个主会话对应一个桶，子列表为归入该主的全部子代理
  const groups: SessionGroup[] = []
  for (const mainId of mains) {
    const main = byId.get(mainId)
    if (!main) continue
    const children = childrenMap.get(mainId) ?? []
    // 子按 lastActive 降序
    children.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
    let calls = main.calls
    let usage = { ...main.usage }
    for (const ch of children) {
      calls += ch.calls
      usage = addUsage(usage, ch.usage)
    }
    groups.push({ main, children, agg: { calls, usage }, childCount: children.length })
  }

  // 若某个 childrenMap 的 key 未在 mains 中（如根本身是子代理但被展平到更高根，此情况已处理；剩余未覆盖的根可能是因主被归类为 child 却仍有子，需补漏）
  for (const [rootId, children] of childrenMap) {
    if (mains.has(rootId)) continue
    const main = byId.get(rootId)
    if (!main) continue
    // root 本身是子代理但因链展平未被视为 main，仍需为其创建分组（兜底）
    children.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
    let calls = main.calls
    let usage = { ...main.usage }
    for (const ch of children) {
      calls += ch.calls
      usage = addUsage(usage, ch.usage)
    }
    groups.push({ main, children, agg: { calls, usage }, childCount: children.length })
  }

  // 主会话按 lastActive 降序（与 snapshot 保持一致）
  groups.sort((a, b) => (b.main.lastActive || 0) - (a.main.lastActive || 0))
  return groups
}

/** 按主会话分组分页（子代理不占页位）。 */
export function paginateGroups(groups: SessionGroup[], page: number, pageSize: number): SessionGroup[] {
  if (!groups || groups.length === 0) return []
  const p = Math.max(1, Math.floor(page))
  const size = Math.max(1, Math.floor(pageSize))
  const start = (p - 1) * size
  if (start >= groups.length) return []
  return groups.slice(start, start + size)
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

/** 模型汇总时间范围：全部/半年/3个月/1个月/14天/7天（默认全部）。 */
export type ModelRange = '7d' | '14d' | '30d' | '90d' | '180d' | 'all'

/** 模型范围对应的天数（all 返回 null）。 */
export function modelRangeToDays(range: ModelRange): number | null {
  switch (range) {
    case '7d': return 7
    case '14d': return 14
    case '30d': return 30
    case '90d': return 90
    case '180d': return 180
    case 'all': return null
    default: return null
  }
}

/** 模型范围的起始零点（all 返回 null）。 */
export function modelRangeCutoff(range: ModelRange): number | null {
  const days = modelRangeToDays(range)
  if (days == null) return null
  const todayStart = startOfDay(Date.now())
  const d = new Date(todayStart)
  d.setDate(d.getDate() - (days - 1))
  return d.getTime()
}

/** 按时间范围过滤模型：基于各模型的 series（按日）聚合，返回排序后的切片。 */
export function filterModelsByRange(models: import('./useSnapshot.ts').ModelStat[], range: ModelRange): import('./useSnapshot.ts').ModelStat[] {
  if (range === 'all') {
    return [...models].sort((a, b) => usageTotal(b.usage) - usageTotal(a.usage))
  }
  const cutoff = modelRangeCutoff(range)
  if (cutoff == null) return [...models].sort((a, b) => usageTotal(b.usage) - usageTotal(a.usage))
  const out: import('./useSnapshot.ts').ModelStat[] = []
  for (const m of models) {
    const series = (m as { series?: SeriesPoint[] }).series ?? []
    // 无细分时（旧快照）该范围下置 0，避免误用全量
    if (!series || series.length === 0) continue
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0, total = 0, calls = 0
    const filteredSeries: SeriesPoint[] = []
    for (const pt of series) {
      if ((pt.t ?? 0) >= cutoff) {
        filteredSeries.push(pt)
        input += pt.input || 0
        output += pt.output || 0
        cacheRead += pt.cacheRead || 0
        cacheWrite += pt.cacheWrite || 0
        reasoning += pt.reasoning || 0
        total += (pt.input || 0) + (pt.output || 0) + (pt.cacheRead || 0) + (pt.cacheWrite || 0)
        calls += pt.calls || 0
      }
    }
    if (total <= 0 && calls <= 0) continue
    out.push({
      provider: m.provider,
      model: m.model,
      calls,
      usage: { input, output, cacheRead, cacheWrite, reasoning, total },
      series: filteredSeries,
    })
  }
  out.sort((a, b) => usageTotal(b.usage) - usageTotal(a.usage))
  return out
}

/** 模型堆叠柱：为给定范围生成按日堆叠数据（横向滚动）。 */
export interface ModelStackDay {
  t: number
  label: string
  total: number
  segments: Array<{ provider: string; model: string; total: number; calls: number }>
}
export interface ModelStack {
  days: ModelStackDay[]
  maxTotal: number
  models: Array<{ provider: string; model: string }>
}
export function buildModelStack(models: import('./useSnapshot.ts').ModelStat[], range: ModelRange): ModelStack {
  const filtered = filterModelsByRange(models, range)
  // 维持与饼图一致的模型顺序（按过滤后 total 降序），堆叠自底向上按此顺序
  const modelOrder = filtered.map((m) => ({ provider: m.provider, model: m.model }))
  const byKey = new Map<string, import('./useSnapshot.ts').ModelStat>()
  for (const m of filtered) byKey.set(m.provider + '\u0000' + m.model, m)
  // 生成日桶（与 buildSet 同款日历推进，避免 DST 漂移）
  const days: number[] = []
  const cutoff = modelRangeCutoff(range)
  if (cutoff != null) {
    const d = new Date(cutoff)
    const todayStart = startOfDay(Date.now())
    const n = modelRangeToDays(range) ?? 0
    for (let i = 0; i < n; i += 1) {
      days.push(d.getTime())
      d.setDate(d.getDate() + 1)
      if (d.getTime() > todayStart) break
    }
    // 保证包含今天
    if (days.length > 0 && days[days.length - 1] !== todayStart) {
      // 若 n 计算与 cutoff 略有偏差，补齐到今天（极少数 DST 边界）
      const last = days[days.length - 1]
      const diff = Math.round((todayStart - last) / 86400000)
      if (diff > 0 && diff < 3) {
        for (let k = 1; k <= diff; k += 1) {
          const dd = new Date(last)
          dd.setDate(dd.getDate() + k)
          days.push(dd.getTime())
        }
      }
    }
  } else {
    // all：从最早一天到今天
    let earliest = Infinity
    for (const m of filtered) {
      const s = (m as { series?: SeriesPoint[] }).series ?? []
      for (const pt of s) if (pt.t < earliest) earliest = pt.t
    }
    if (!Number.isFinite(earliest)) {
      // 无过滤后数据时回落到全量最早日（或今天）
      if (filtered.length === 0) return { days: [], maxTotal: 1, models: [] }
      earliest = startOfDay(Date.now())
    } else {
      earliest = startOfDay(earliest)
    }
    const todayStart = startOfDay(Date.now())
    let span = Math.max(1, Math.round((todayStart - earliest) / 86400000) + 1)
    // 限制最多一年宽度（365 天，闰年 366 天），避免“全部”范围过宽
    const MAX_DAYS = 366
    if (span > MAX_DAYS) {
      span = MAX_DAYS
      const d0 = new Date(todayStart)
      d0.setDate(d0.getDate() - (MAX_DAYS - 1))
      earliest = d0.getTime()
    }
    const d = new Date(earliest)
    for (let i = 0; i < span; i += 1) {
      days.push(d.getTime())
      d.setDate(d.getDate() + 1)
    }
  }
  // 按日构建堆叠
  const byModelDay = new Map<string, Map<number, number>>()
  for (const m of filtered) {
    const key = m.provider + '\u0000' + m.model
    const mp = new Map<number, number>()
    const s = (m as { series?: SeriesPoint[] }).series ?? []
    for (const pt of s) mp.set(pt.t, dayTotal(pt))
    byModelDay.set(key, mp)
  }
  const stackDays: ModelStackDay[] = []
  let maxTotal = 1
  for (const t of days) {
    const segs: ModelStackDay['segments'] = []
    let total = 0
    for (const m of filtered) {
      const key = m.provider + '\u0000' + m.model
      const mp = byModelDay.get(key)
      const v = mp?.get(t) ?? 0
      if (v > 0) segs.push({ provider: m.provider, model: m.model, total: v, calls: 0 })
      total += v
    }
    // 填充 calls（可选，tooltip 用）
    for (const seg of segs) {
      const key = seg.provider + '\u0000' + seg.model
      const mm = byKey.get(key)
      const s = (mm as { series?: SeriesPoint[] })?.series ?? []
      const pt = s.find((p) => p.t === t)
      seg.calls = pt?.calls ?? 0
    }
    // 自底向上保持 filtered 顺序
    stackDays.push({ t, label: dayLabel(t), total, segments: segs })
    if (total > maxTotal) maxTotal = total
  }
  return { days: stackDays, maxTotal, models: modelOrder }
}

/** 日期范围（与模型范围同款枚举，日期 Tab 对齐 ModelsTab 的 6 档）。 */
export type DateRange = '7d' | '14d' | '30d' | '90d' | '180d' | 'all'

/** 日期范围对应的天数（all 返回 null，复用模型范围逻辑保持一致）。 */
export function dateRangeToDays(range: DateRange): number | null {
  return modelRangeToDays(range as ModelRange)
}

/** 日期范围的起始零点（all 返回 null）。 */
export function dateRangeCutoff(range: DateRange): number | null {
  return modelRangeCutoff(range as ModelRange)
}

/** 日期堆叠柱的 token 类型与配色（与 total 分量对应，reasoning 单列也展示）。 */
export const DATE_TOKEN_META = [
  { key: 'input' as const, label: '输入', color: '#4d6bfe' },
  { key: 'output' as const, label: '输出', color: '#00b894' },
  { key: 'cacheRead' as const, label: '缓存', color: '#fdcb6e' },
  { key: 'cacheWrite' as const, label: '缓存写入', color: '#e17055' },
  { key: 'reasoning' as const, label: '推理', color: '#a29bfe' },
] as const

export type DateTokenKey = typeof DATE_TOKEN_META[number]['key']

/** 日期堆叠柱：每日一柱，按 token 类型堆叠。 */
export interface DateStackDay {
  /** 当天 0 点时间戳。 */
  t: number
  /** 轴标签（月/日）。 */
  label: string
  /** 当天 total（input+output+cacheRead+cacheWrite，不含 reasoning） */
  total: number
  /** 当天调用次数 */
  calls: number
  /** 各分量（用于 tooltip / 表格） */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  /** 按 token 类型的分段（仅值 >0 的段，避免渲染空层）。 */
  segments: Array<{ key: DateTokenKey; label: string; value: number; color: string }>
}

export interface DateStack {
  days: DateStackDay[]
  maxTotal: number
}

/** 由日序列构建日期堆叠柱数据（横向滚动，复用 buildModelStack 的日历推进逻辑避免 DST 漂移）。 */
export function buildDateStack(series: SeriesPoint[], range: DateRange): DateStack {
  const byDate = new Map<number, SeriesPoint>()
  for (const p of series) if (p && p.t != null) byDate.set(p.t, p)
  const days: number[] = []
  const cutoff = dateRangeCutoff(range)
  if (cutoff != null) {
    const d = new Date(cutoff)
    const todayStart = startOfDay(Date.now())
    const n = dateRangeToDays(range) ?? 0
    for (let i = 0; i < n; i += 1) {
      days.push(d.getTime())
      d.setDate(d.getDate() + 1)
      if (d.getTime() > todayStart) break
    }
    if (days.length > 0 && days[days.length - 1] !== todayStart) {
      const last = days[days.length - 1]
      const diff = Math.round((todayStart - last) / 86400000)
      if (diff > 0 && diff < 3) {
        for (let k = 1; k <= diff; k += 1) {
          const dd = new Date(last)
          dd.setDate(dd.getDate() + k)
          days.push(dd.getTime())
        }
      }
    }
  } else {
    // all：从最早一天到今天
    let earliest = Infinity
    for (const p of series) if (p.t != null && p.t < earliest) earliest = p.t
    if (!Number.isFinite(earliest)) {
      return { days: [], maxTotal: 1 }
    }
    earliest = startOfDay(earliest)
    const todayStart = startOfDay(Date.now())
    let span = Math.max(1, Math.round((todayStart - earliest) / 86400000) + 1)
    const MAX_DAYS = 366
    if (span > MAX_DAYS) {
      span = MAX_DAYS
      const d0 = new Date(todayStart)
      d0.setDate(d0.getDate() - (MAX_DAYS - 1))
      earliest = d0.getTime()
    }
    const d = new Date(earliest)
    for (let i = 0; i < span; i += 1) {
      days.push(d.getTime())
      d.setDate(d.getDate() + 1)
    }
  }
  const stackDays: DateStackDay[] = []
  let maxTotal = 1
  for (const t of days) {
    const pt = byDate.get(t)
    const input = pt?.input ?? 0
    const output = pt?.output ?? 0
    const cacheRead = pt?.cacheRead ?? 0
    const cacheWrite = pt?.cacheWrite ?? 0
    const reasoning = pt?.reasoning ?? 0
    const calls = pt?.calls ?? 0
    const total = dayTotal(pt ?? { input, output, cacheRead, cacheWrite, reasoning, calls, t })
    const segs: DateStackDay['segments'] = []
    for (const meta of DATE_TOKEN_META) {
      const v = meta.key === 'input' ? input : meta.key === 'output' ? output : meta.key === 'cacheRead' ? cacheRead : meta.key === 'cacheWrite' ? cacheWrite : reasoning
      if (v > 0) segs.push({ key: meta.key, label: meta.label, value: v, color: meta.color })
    }
    // 高度基准：堆叠总和（含 reasoning），保证各类型均可见
    const stackSum = input + output + cacheRead + cacheWrite + reasoning
    if (stackSum > maxTotal) maxTotal = stackSum
    if (total > maxTotal) maxTotal = total
    stackDays.push({ t, label: dayLabel(t), total, calls, input, output, cacheRead, cacheWrite, reasoning, segments: segs })
  }
  if (stackDays.length === 0) return { days: [], maxTotal: 1 }
  return { days: stackDays, maxTotal: Math.max(1, maxTotal) }
}

/** 模型配色：10 色循环，与热力图/三色条区分。 */
export const MODEL_PALETTE = [
  '#4d6bfe',
  '#00b894',
  '#fdcb6e',
  '#e17055',
  '#a29bfe',
  '#fd79a8',
  '#00cec9',
  '#e84393',
  '#0984e3',
  '#6c5ce7',
] as const
export function modelColorAt(index: number): string {
  return MODEL_PALETTE[index % MODEL_PALETTE.length]
}

/** 饼图几何：输入过滤后模型列表，输出扇区路径与占比。 */
export interface PieSlice {
  provider: string
  model: string
  total: number
  share: number
  startAngle: number
  endAngle: number
  path: string
  color: string
}
export function pieSlicesOf(models: import('./useSnapshot.ts').ModelStat[]): PieSlice[] {
  const sum = models.reduce((s, m) => s + usageTotal(m.usage), 0)
  if (sum <= 0 || models.length === 0) return []
  // 与 ModelsTab 表格一致：最大余数法 1 位小数占比，保证总和 100%
  const raws = models.map((m) => (usageTotal(m.usage) / sum) * 100)
  const floors = raws.map((v) => Math.floor(v * 10) / 10)
  const sumFloorsTenths = floors.reduce((a, b) => a + Math.round(b * 10), 0)
  let remainingTenths = 1000 - sumFloorsTenths
  const order = raws.map((v, i) => ({ i, frac: v * 10 - Math.floor(v * 10) })).sort((a, b) => b.frac - a.frac)
  const shares = [...floors]
  for (let k = 0; k < remainingTenths && k < order.length; k += 1) {
    const idx = order[k].i
    shares[idx] = Math.round((shares[idx] + 0.1) * 10) / 10
  }
  // 角度分配：按 raws 精确比例，避免 0.1% 舍入导致角度总和偏差
  let angle = -Math.PI / 2 // 从 12 点钟开始
  const slices: PieSlice[] = []
  for (let i = 0; i < models.length; i += 1) {
    const m = models[i]
    const frac = usageTotal(m.usage) / sum
    const sweep = frac * Math.PI * 2
    const startAngle = angle
    const endAngle = angle + sweep
    // SVG 扇区路径（r=50，中心 60,60）
    const r = 50
    const cx = 60, cy = 60
    const x1 = cx + r * Math.cos(startAngle)
    const y1 = cy + r * Math.sin(startAngle)
    const x2 = cx + r * Math.cos(endAngle)
    const y2 = cy + r * Math.sin(endAngle)
    const largeArc = sweep > Math.PI ? 1 : 0
    const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`
    slices.push({
      provider: m.provider,
      model: m.model,
      total: usageTotal(m.usage),
      share: shares[i] ?? 0,
      startAngle,
      endAngle,
      path,
      color: modelColorAt(i),
    })
    angle = endAngle
  }
  return slices
}
