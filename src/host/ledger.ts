/**
 * 原始事件流账本（Ledger）：用量事件的唯一事实来源 —— 自管理 SQLite。
 *
 * 不依赖 harness 的 storage 家族：直接用 node:sqlite 的同步 API
 * （DatabaseSync，Node ≥22 内置；运行时仅打印一条 experimental 警告）。
 * 数据落在 `$DSH_HOME/storages/dsh-usage-statistics/ledger.sqlite`：
 *
 *   - `events` 表：一行一条用量事件，PRIMARY KEY (session_id, seq, t) 天然
 *     幂等（同一条事件重复写入收敛，重开账本时每行只折一次；seq=-1 的未知
 *     序事件再按毫秒时间戳区分）。结构化列，无旧版按天分片 + 行水位。
 *   - `session_meta` 表：key = session_id，value = title/cwd/createdAt/
 *     lastActive（初始化扫描抄录、实时 session/title 事件更新）。
 *   - `PRAGMA user_version` = LEDGER_VERSION：结构不兼容时清空重建
 *     （事件表为空后下次启动全量重扫 —— 账本结构升级的安全网）。
 *
 * 所有读写同步：append / setMeta 即写即持久（自动提交），崩溃后重启从
 * sqlite 恢复，无需周期性对账；会话元数据在内存缓存一份供快照读取。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { getDshHome } from './logs.ts'
import { modelKeyOf } from './agg.ts'
import { splitModelKey } from '../utils.ts'

/** 账本 schema 版本（PRAGMA user_version）：结构不兼容时自动清库重建。 */
export const LEDGER_VERSION = 1
/** 归属目录名（storages 下，与插件同名）。 */
export const LEDGER_DIR_NAME = 'dsh-usage-statistics'
/** 账本 sqlite 文件名。 */
export const DB_FILE_NAME = 'ledger.sqlite'

/** 账本数据库文件绝对路径（默认 $DSH_HOME/storages/dsh-usage-statistics/）。 */
export function ledgerDatabasePath(): string {
  return join(getDshHome(), 'storages', LEDGER_DIR_NAME, DB_FILE_NAME)
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

/** events 表 DDL（列名 snake_case，读回时映射回 camelCase）。 */
const EVENT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  t           INTEGER NOT NULL,
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, seq, t)
)`

/** session_meta 表 DDL。 */
const META_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS session_meta (
  session_id  TEXT    PRIMARY KEY,
  title       TEXT    NOT NULL DEFAULT '',
  cwd         TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0,
  last_active INTEGER NOT NULL DEFAULT 0
)`

/** 预编译语句集（open 时在迁移完成后统一准备，复用避免重复解析）。 */
interface LedgerStatements {
  hasEvent: ReturnType<DatabaseSync['prepare']>
  insertEvent: ReturnType<DatabaseSync['prepare']>
  allEvents: ReturnType<DatabaseSync['prepare']>
  upsertMeta: ReturnType<DatabaseSync['prepare']>
  allMeta: ReturnType<DatabaseSync['prepare']>
}

/** 新建空会话元数据（字段可增量补齐）。 */
export function emptySessionMeta(): SessionMeta {
  return { title: '', cwd: '', createdAt: 0, lastActive: 0 }
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
  const { provider, model } = splitModelKey(modelKeyOf(event))
  return {
    t: Number(event.time) || Date.now(),
    sessionId,
    provider,
    model,
    seq: typeof event.seq === 'number' ? event.seq : -1,
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadTokens),
    cacheWrite: num(u.cacheWriteTokens),
    reasoning: num(u.reasoningTokens),
  }
}

/**
 * 自管理 SQLite 账本：events / session_meta 两表；读走内存缓存 + 按需
 * SELECT，写同步即持久（自动提交）。测试注入 DSH_HOME 即可隔离介质。
 */
export class Ledger {
  private db!: DatabaseSync
  private stmts!: LedgerStatements
  private readonly metaCache = new Map<string, SessionMeta>()
  private closed = false

  constructor(private readonly path: string = ledgerDatabasePath()) {}

  /** 打开账本：建目录/建表/迁移（user_version 不匹配则清库）+ 载入 meta 缓存。 */
  open(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseSync(this.path)
    this.db.exec(EVENT_TABLE_DDL)
    this.db.exec(META_TABLE_DDL)
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: unknown }
    const version = typeof row?.user_version === 'number' ? row.user_version : 0
    if (version !== LEDGER_VERSION) {
      // 首次使用（version 0）或结构不兼容：清空重建，事件表为空 → 下次
      // 启动走全量重扫（账本结构升级的安全网，与旧版语义一致）。
      console.warn(`[usage-statistics] 账本 schema 版本 ${String(version)} 与 ${String(LEDGER_VERSION)} 不一致，重建空账本`)
      this.db.exec('DROP TABLE IF EXISTS events')
      this.db.exec('DROP TABLE IF EXISTS session_meta')
      this.db.exec(EVENT_TABLE_DDL)
      this.db.exec(META_TABLE_DDL)
      this.db.exec(`PRAGMA user_version = ${LEDGER_VERSION}`)
    }
    const hasEvent = this.db.prepare('SELECT 1 AS x FROM events LIMIT 1')
    const insertEvent = this.db.prepare(
      `INSERT INTO events (session_id, seq, t, provider, model, input, output, cache_read, cache_write, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq, t) DO UPDATE SET
         provider = excluded.provider, model = excluded.model,
         input = excluded.input, output = excluded.output,
         cache_read = excluded.cache_read, cache_write = excluded.cache_write,
         reasoning = excluded.reasoning`,
    )
    const allEvents = this.db.prepare(
      'SELECT session_id, seq, t, provider, model, input, output, cache_read, cache_write, reasoning FROM events',
    )
    const upsertMeta = this.db.prepare(
      `INSERT INTO session_meta (session_id, title, cwd, created_at, last_active)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         title = excluded.title, cwd = excluded.cwd,
         created_at = excluded.created_at, last_active = excluded.last_active`,
    )
    const allMeta = this.db.prepare('SELECT session_id, title, cwd, created_at, last_active FROM session_meta')
    this.stmts = { hasEvent, insertEvent, allEvents, upsertMeta, allMeta }
    for (const row of allMeta.all() as Array<Record<string, unknown>>) {
      const id = String(row.session_id)
      this.metaCache.set(id, {
        title: String(row.title ?? ''),
        cwd: String(row.cwd ?? ''),
        createdAt: Number(row.created_at) || 0,
        lastActive: Number(row.last_active) || 0,
      })
    }
  }

  /** 事件流是否已有内容（决定首启扫描 / 直接重建）。 */
  hasEvents(): boolean {
    this.assertOpen()
    return this.stmts.hasEvent.get() !== undefined
  }

  /** 追加一条事件（幂等：同 session+seq+毫秒 收敛为 upsert）。 */
  append(ev: LedgerEvent): void {
    this.assertOpen()
    this.stmts.insertEvent.run(
      ev.sessionId, ev.seq, ev.t,
      ev.provider, ev.model,
      ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning,
    )
  }

  /** 更新会话元数据（增量合并；内存缓存 + 同步写回）。 */
  setMeta(id: string, patch: Partial<SessionMeta>): void {
    this.assertOpen()
    const current = this.metaCache.get(id) ?? emptySessionMeta()
    const next: SessionMeta = {
      title: typeof patch.title === 'string' ? patch.title : current.title,
      cwd: typeof patch.cwd === 'string' ? patch.cwd : current.cwd,
      createdAt: Number(patch.createdAt) || current.createdAt,
      lastActive: Number(patch.lastActive) || current.lastActive,
    }
    this.metaCache.set(id, next)
    this.stmts.upsertMeta.run(id, next.title, next.cwd, next.createdAt, next.lastActive)
  }

  /** 取会话元数据（无则 null）。 */
  getMeta(id: string): SessionMeta | null {
    this.assertOpen()
    return this.metaCache.get(id) ?? null
  }

  /** 全部账本事件（冷启动/重建：逐条折叠进聚合缓存）。 */
  allEvents(): LedgerEvent[] {
    this.assertOpen()
    const rows = this.stmts.allEvents.all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      t: Number(r.t) || 0,
      sessionId: String(r.session_id),
      provider: String(r.provider),
      model: String(r.model),
      seq: Number(r.seq) || 0,
      input: Number(r.input) || 0,
      output: Number(r.output) || 0,
      cacheRead: Number(r.cache_read) || 0,
      cacheWrite: Number(r.cache_write) || 0,
      reasoning: Number(r.reasoning) || 0,
    }))
  }

  /** 清空事件流与元数据（重建账本用；保留表结构）。 */
  clear(): void {
    this.assertOpen()
    this.db.exec('DELETE FROM events')
    this.db.exec('DELETE FROM session_meta')
    this.metaCache.clear()
  }

  /** 关闭数据库连接（插件卸载；幂等）。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ledger is closed')
  }
}