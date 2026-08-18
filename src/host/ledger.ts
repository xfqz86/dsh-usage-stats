/**
 * 原始事件流账本（Ledger）：用量事件的唯一事实来源。
 *
 * 存储布局（$DSH_HOME/storages/dsh-usage-statistics/）：
 *   events/YYYY-MM-DD.jsonl —— 按天分片的原始事件流（追加写，全量保留）。
 *     每行一条 usage 事件（LedgerEvent），带 seq 供去重/审计。
 *   session-meta.json       —— 会话元数据表（title/cwd/createdAt/lastActive），
 *     初始化扫描时从会话日志抄录、实时 session/title 事件更新；临时文件 +
 *     原子重命名 + 2s 防抖落盘。
 *
 * 账本与聚合缓存的边界：账本只负责「存」（追加、读取、元数据、版本），
 * 不负责统计；聚合（按天/模型/会话）由 store.ts 的 UsageStore 作为派生缓存
 * 维护（启动全量重建 + 实时增量 + 60s 对账补齐）。version 不兼容时上层
 * 视为空账本并自动重建。
 *
 * 纯 Node 实现：只 import node:fs / node:path，不触碰 ctx。
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DSH_HOME } from './logs.ts'
import { modelKeyOf } from './agg.ts'

/** 账本版本：结构不兼容时上层自动重建（见 index.ts）。 */
export const LEDGER_VERSION = 1
/** 归属目录名（storages 下）。 */
export const LEDGER_DIR_NAME = 'dsh-usage-statistics'
/** 事件流子目录。 */
export const EVENTS_DIR_NAME = 'events'
/** 会话元数据文件名。 */
export const META_FILE_NAME = 'session-meta.json'

/** 账本根目录（默认 $DSH_HOME/storages/dsh-usage-statistics，可在测试注入）。 */
export function ledgerRoot(): string {
  return join(DSH_HOME, 'storages', LEDGER_DIR_NAME)
}
export function eventsRoot(root = ledgerRoot()): string {
  return join(root, EVENTS_DIR_NAME)
}
export function metaPath(root = ledgerRoot()): string {
  return join(root, META_FILE_NAME)
}

/** 一条账本事件：一次模型调用的用量（t 为毫秒时间戳）。 */
export interface LedgerEvent {
  t: number
  sessionId: string
  provider: string
  model: string
  seq: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

/** 会话元数据（来自会话种子记录 + session/title 事件）。 */
export interface SessionMeta {
  title: string
  cwd: string
  createdAt: number
  lastActive: number
}

/** 会话元数据表文件形状。 */
interface MetaFileShape {
  version: number
  sessions: Record<string, SessionMeta>
}

/** 新建空会话元数据（字段可增量补齐）。 */
export function emptySessionMeta(): SessionMeta {
  return { title: '', cwd: '', createdAt: 0, lastActive: 0 }
}

/** 时间戳 → 按天分片文件名（YYYY-MM-DD.jsonl）。 */
export function shardNameOf(t: number): string {
  const d = new Date(t)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`
}

/** 会话事件 → 账本事件（无 usage 时返回 null）。 */
export function toLedgerEvent(sessionId: string, event: SessionEvent<'assistant/message'>): LedgerEvent | null {
  const usage = event.data?.usage
  if (usage === null || typeof usage !== 'object') return null
  const u = usage as { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown; reasoningTokens?: unknown }
  // 归一化：非有限/负数一律按 0 处理，防止污染账本聚合。
  const num = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const key = modelKeyOf(event)
  const sep = key.indexOf('\u0000')
  return {
    t: Number(event.time) || Date.now(),
    sessionId,
    provider: sep === -1 ? 'unknown' : key.slice(0, sep),
    model: sep === -1 ? 'unknown' : key.slice(sep + 1),
    seq: typeof event.seq === 'number' ? event.seq : -1,
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadTokens),
    cacheWrite: num(u.cacheWriteTokens),
    reasoning: num(u.reasoningTokens),
  }
}

/** 解析一行 NDJSON：坏行返回 null（不中断读取）。 */
export function parseEventLine(line: string): LedgerEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as LedgerEvent
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.t === 'number' && typeof parsed.sessionId === 'string') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** 原子写 JSON（临时文件 + rename）。 */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  renameSync(tmp, path)
}

/**
 * 事件流账本实例：持有会话元数据表内存副本 + 写防抖，事件流按天分片追加。
 * 所有方法同步（appendFileSync / readFileSync），量级为单条事件/小文件，
 * 不阻塞事件循环可忽略。
 */
export class Ledger {
  /** 账本根目录。 */
  readonly root: string
  /** 会话元数据内存副本（权威=文件，写防抖）。 */
  readonly meta: Map<string, SessionMeta>
  /** 事件流已处理行数水位（分片名 → 行数），供 60s 对账增量消费。 */
  readonly watermarks: Map<string, number>
  private metaDirty = false
  private metaTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(root = ledgerRoot()) {
    this.root = root
    this.meta = new Map()
    this.watermarks = new Map()
  }

  /** 打开账本：读会话元数据表；不存在按空账本启动。返回版本号（0=空账本）。 */
  open(): number {
    mkdirSync(eventsRoot(this.root), { recursive: true })
    try {
      const parsed = JSON.parse(readFileSync(metaPath(this.root), 'utf8')) as MetaFileShape
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.sessions === 'object' && parsed.sessions !== null) {
        for (const [id, meta] of Object.entries(parsed.sessions)) {
          if (meta !== null && typeof meta === 'object') {
            this.meta.set(id, {
              title: typeof meta.title === 'string' ? meta.title : '',
              cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
              createdAt: Number(meta.createdAt) || 0,
              lastActive: Number(meta.lastActive) || 0,
            })
          }
        }
        return typeof parsed.version === 'number' ? parsed.version : 0
      }
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code !== 'ENOENT') console.warn(`[usage-statistics] 会话元数据读取失败，按空表启动: ${String((error as Error)?.message ?? error)}`)
      return 0
    }
    return 0
  }

  /** 事件流是否已有内容（决定首启初始化 vs 直接加载）。 */
  hasEvents(): boolean {
    try {
      const entries = readdirSync(eventsRoot(this.root))
      return entries.some((name) => name.endsWith('.jsonl'))
    } catch {
      return false
    }
  }

  /** 追加一条事件到当天分片（同步落盘；全量保留，不做剪枝）。
   *  同时推进该分片水位（= 已追加行数），对账 readShardSince 据此跳过已折叠行。 */
  append(ev: LedgerEvent): void {
    if (this.closed) return
    const shard = shardNameOf(ev.t)
    const dir = eventsRoot(this.root)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, shard), JSON.stringify(ev) + '\n', 'utf8')
    this.watermarks.set(shard, (this.watermarks.get(shard) ?? 0) + 1)
  }

  /** 清空事件流与元数据（重建账本用；保留目录）。 */
  clear(): void {
    const dir = eventsRoot(this.root)
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.jsonl')) rmSync(join(dir, name), { force: true })
      }
    } catch {
      // 目录不存在即空。
    }
    this.meta.clear()
    this.watermarks.clear()
    this.markMetaDirty()
  }

  /** 列出全部事件流分片（按名称排序 = 按天排序）。 */
  shards(): string[] {
    try {
      return readdirSync(eventsRoot(this.root))
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
    } catch {
      return []
    }
  }

  /** 读取某分片并更新该分片水位（返回新行；水位之前的行跳过）。 */
  readShardSince(name: string): LedgerEvent[] {
    const path = join(eventsRoot(this.root), name)
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return []
    }
    const lines = text.split('\n')
    const start = this.watermarks.get(name) ?? 0
    const out: LedgerEvent[] = []
    for (let i = start; i < lines.length; i += 1) {
      const ev = parseEventLine(lines[i] ?? '')
      if (ev) out.push(ev)
    }
    this.watermarks.set(name, lines.length)
    return out
  }

  /** 读取全部事件（冷启动/重建：每分片水位从 0 起，全部行消费并建立水位）。 */
  readAll(): LedgerEvent[] {
    const out: LedgerEvent[] = []
    for (const name of this.shards()) {
      out.push(...this.readShardSince(name))
    }
    return out
  }

  /** 更新会话元数据（增量合并，防抖落盘）。 */
  setMeta(id: string, patch: Partial<SessionMeta>): void {
    if (this.closed) return
    const current = this.meta.get(id) ?? emptySessionMeta()
    const next: SessionMeta = {
      title: typeof patch.title === 'string' ? patch.title : current.title,
      cwd: typeof patch.cwd === 'string' ? patch.cwd : current.cwd,
      createdAt: Number(patch.createdAt) || current.createdAt,
      lastActive: Number(patch.lastActive) || current.lastActive,
    }
    this.meta.set(id, next)
    this.markMetaDirty()
  }

  /** 取会话元数据（无则 null）。 */
  getMeta(id: string): SessionMeta | null {
    return this.meta.get(id) ?? null
  }

  private markMetaDirty(): void {
    if (this.metaDirty || this.closed) return
    this.metaDirty = true
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null
      this.flushMeta()
    }, 2000)
  }

  /** 立即落盘元数据（原子写；防抖到期或 close 时调用）。 */
  flushMeta(): void {
    if (!this.metaDirty || this.closed) return
    this.metaDirty = false
    const sessions: Record<string, SessionMeta> = {}
    for (const [id, meta] of this.meta) sessions[id] = { ...meta }
    try {
      writeJsonAtomic(metaPath(this.root), { version: LEDGER_VERSION, sessions })
    } catch (error) {
      console.warn(`[usage-statistics] 会话元数据写入失败: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /** 停止定时器并最终落盘元数据（插件卸载）。 */
  close(): void {
    this.closed = true
    if (this.metaTimer !== null) {
      clearTimeout(this.metaTimer)
      this.metaTimer = null
    }
    this.flushMeta()
  }
}