/**
 * 原始事件流账本 Ledger：用量事件的唯一事实来源 —— 自管理 SQLite。
 *
 * 不依赖 harness 的 storage 家族：直接用 node:sqlite 的同步 API
 * DatabaseSync，Node ≥22 内置，运行时仅打印一条 experimental 警告。
 * 数据落在 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`：
 *
 *   - `events` 表：一行一条用量事件，PRIMARY KEY 为 t、session_id、seq 天然
 *     幂等，同一条事件重复写入收敛，重开账本时每行只折一次，seq=-1 的未知
 *     序事件再按毫秒时间戳区分。结构化列主键，列顺序为 t、session_id、seq。
 *     无 time 的畸形事件以"当天内确定性毫秒偏移"入账：同日重放幂等，
 *     跨日重放理论上可能重复——防御路径罕见可接受。
 *   - `session_meta` 表：key = session_id，value = title/cwd/createdAt/
 *     lastActive，初始化扫描抄录、实时 session/title 事件更新。
 *   - `agg_*` 预统计表：派生聚合的物化视图，见 §5 预统计，与 events 同库
 *     事务一致，避免重启时重放全量事件。
 *   - `PRAGMA user_version` = LEDGER_VERSION：结构不兼容时清空重建
 *     ，事件表为空后下次启动全量重扫 —— 账本结构升级的安全网。
 *
 * 所有读写同步：append / setMeta 即写即持久，自动提交，崩溃后重启从
 * sqlite 恢复，无需周期性对账；会话元数据在内存缓存一份供快照读取。
 * 预统计表与事件表同库事务，保证聚合与原始事件一致性。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { splitModelKey, startOfDay  } from '../utils.ts';

import { modelKeyOf } from './agg.ts';
import { getDshHome } from './logs.ts';

import type { UsageStore } from './store.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

/** 账本 schema 版本，PRAGMA user_version，结构不兼容时自动清库重建。 */
export const LEDGER_VERSION = 4;
/** 归属目录名，位于 storages 下，与插件同名。 */
export const LEDGER_DIR_NAME = 'dsh-usage-stats';
/** 账本 sqlite 文件名。 */
export const DB_FILE_NAME = 'ledger.sqlite';

/** 账本数据库文件绝对路径，默认位于 $DSH_HOME/storages/dsh-usage-stats/。 */
export function ledgerDatabasePath(): string {
  return join(getDshHome(), 'storages', LEDGER_DIR_NAME, DB_FILE_NAME);
}

/** 一条账本事件：一次模型调用的用量，t 为毫秒时间戳。 */
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

/** 会话元数据，来自会话种子记录与 session/title 事件。 */
export interface SessionMeta {
  title: string
  cwd: string
  createdAt: number
  lastActive: number
  parentSession: string
  origin: string
  delegationDepth: number
}

/** events 表 DDL，列名 snake_case，读回时映射回 camelCase。 */
const EVENT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
  t           INTEGER NOT NULL,
  session_id  TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (t, session_id, seq)
)`;

/** session_meta 表 DDL。 */
const META_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS session_meta (
  session_id       TEXT    PRIMARY KEY,
  title            TEXT    NOT NULL DEFAULT '',
  cwd              TEXT    NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL DEFAULT 0,
  last_active      INTEGER NOT NULL DEFAULT 0,
  parent_session   TEXT    NOT NULL DEFAULT '',
  origin           TEXT    NOT NULL DEFAULT '',
  delegation_depth INTEGER NOT NULL DEFAULT 0
)`;

/** 预统计：全量总表，单行，id=0。 */
const AGG_TOTAL_DDL = `
CREATE TABLE IF NOT EXISTS agg_total (
  id            INTEGER PRIMARY KEY CHECK (id = 0),
  input         INTEGER NOT NULL DEFAULT 0,
  output        INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  reasoning     INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,
  folded_events INTEGER NOT NULL DEFAULT 0
)`;

/** 预统计：按日全量。 */
const AGG_DAILY_DDL = `
CREATE TABLE IF NOT EXISTS agg_daily (
  day         INTEGER PRIMARY KEY,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0
)`;

/** 预统计：按模型。 */
const AGG_MODEL_DDL = `
CREATE TABLE IF NOT EXISTS agg_model (
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, model)
)`;

/** 预统计：按模型×日。 */
const AGG_MODEL_DAILY_DDL = `
CREATE TABLE IF NOT EXISTS agg_model_daily (
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  day         INTEGER NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, model, day)
)`;


/** 预统计：按会话。 */
const AGG_SESSION_DDL = `
CREATE TABLE IF NOT EXISTS agg_session (
  session_id  TEXT    PRIMARY KEY,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  max_seq     INTEGER NOT NULL DEFAULT -1,
  last_active INTEGER NOT NULL DEFAULT 0
)`;

/** 预统计：按会话×日。 */
const AGG_SESSION_DAILY_DDL = `
CREATE TABLE IF NOT EXISTS agg_session_daily (
  session_id  TEXT    NOT NULL,
  day         INTEGER NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, day)
)`;

/** 预统计：水位/检查点，可选，记录已密封的边界。 */
const AGG_CHECKPOINT_DDL = `
CREATE TABLE IF NOT EXISTS agg_checkpoint (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
)`;

/** 预编译语句集，open 时在迁移完成后统一准备，复用避免重复解析。 */
interface LedgerStatements {
  hasEvent: ReturnType<DatabaseSync['prepare']>
  hasEventByPK: ReturnType<DatabaseSync['prepare']>
  insertEvent: ReturnType<DatabaseSync['prepare']>
  allEvents: ReturnType<DatabaseSync['prepare']>
  upsertMeta: ReturnType<DatabaseSync['prepare']>
  allMeta: ReturnType<DatabaseSync['prepare']>
  // 预统计
  hasAgg: ReturnType<DatabaseSync['prepare']>
  getAggTotal: ReturnType<DatabaseSync['prepare']>
  allAggDaily: ReturnType<DatabaseSync['prepare']>
  allAggModel: ReturnType<DatabaseSync['prepare']>
  allAggModelDaily: ReturnType<DatabaseSync['prepare']>
  allAggSession: ReturnType<DatabaseSync['prepare']>
  allAggSessionDaily: ReturnType<DatabaseSync['prepare']>
  incAggTotal: ReturnType<DatabaseSync['prepare']>
  incAggDaily: ReturnType<DatabaseSync['prepare']>
  incAggModel: ReturnType<DatabaseSync['prepare']>
  incAggModelDaily: ReturnType<DatabaseSync['prepare']>
  incAggSession: ReturnType<DatabaseSync['prepare']>
  incAggSessionDaily: ReturnType<DatabaseSync['prepare']>
  insertAggTotalBulk: ReturnType<DatabaseSync['prepare']>
  insertAggDailyBulk: ReturnType<DatabaseSync['prepare']>
  insertAggModelBulk: ReturnType<DatabaseSync['prepare']>
  insertAggModelDailyBulk: ReturnType<DatabaseSync['prepare']>
  insertAggSessionBulk: ReturnType<DatabaseSync['prepare']>
  insertAggSessionDailyBulk: ReturnType<DatabaseSync['prepare']>
  getCheckpoint: ReturnType<DatabaseSync['prepare']>
  upsertCheckpoint: ReturnType<DatabaseSync['prepare']>
  allEventsSince: ReturnType<DatabaseSync['prepare']>
}

/** 新建空会话元数据，字段可增量补齐。 */
export function emptySessionMeta(): SessionMeta {
  return { title: '', cwd: '', createdAt: 0, lastActive: 0, parentSession: '', origin: '', delegationDepth: 0 };
}

/**
 * 清洗写入 sqlite TEXT 列的字符串：node:sqlite 不允许文本包含 U+0000，
 * 异常元数据如标题、cwd、会话 id 等原样写入会让 upsertMeta 抛错，
 * 实时路径因此丢事件、扫描路径记 failed。统一把 NUL 替换为替换符
 * U+FFFD，保留字符占位、可人工识别；清洗确定性一致，重复写同一输入
 * 结果相同，不破坏 upsert 幂等。仅作用于入列前的边界，内存其余路径不受影响。
 */
function sanitizeSqlText(value: string): string {
  return value.includes('\u0000') ? value.replaceAll('\u0000', '\ufffd') : value;
}

/** 会话事件转换为账本事件，无 usage 时返回 null。 */
export function toLedgerEvent(sessionId: string, event: SessionEvent<'assistant/message'>): LedgerEvent | null {
  const usage = event.data?.usage;
  if (usage === null || typeof usage !== 'object') return null;
  const u = usage as { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown; reasoningTokens?: unknown };
  // 归一化：非有限/负数一律按 0 处理，防止污染账本聚合。
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const { provider, model } = splitModelKey(modelKeyOf(event));
  // TEXT 列归一：sessionId、provider、model 写入 sqlite 前清洗 NUL，与 meta
  // 路径同款口径，AGENTS §5，在构造点统一归一，内存聚合键与账本行保持一致。
  const sessionIdText = sanitizeSqlText(sessionId);
  const providerText = sanitizeSqlText(provider);
  const modelText = sanitizeSqlText(model);
  const rawT = (event as { time?: unknown }).time;
  let t: number;
  if (typeof rawT === 'number' && Number.isFinite(rawT) && rawT > 0) {
    t = rawT;
  } else {
    // 无 time 时用内容哈希生成"当天内确定性毫秒偏移"：落在今天 [1s, 当日末]
    // 区间内，保证同一事件同日重放幂等，主键 upsert 收敛，且不同事件仍可
    // 区分；避免旧方案落入 1970 年附近，把客户端 'all' 日桶拉长到两万天。
    // 幂等边界：跨日重放理论上会另落一日产生重复——该分支仅防御畸形事件
    // ，真实事件均带 time，罕见可接受。
    let hashStr = '';
    try { hashStr = JSON.stringify((event as { data?: unknown }).data ?? ''); } catch { hashStr = String((event as { data?: unknown }).data); }
    let h = 0;
    for (let i = 0; i < hashStr.length; i += 1) h = ((h * 31) + hashStr.charCodeAt(i)) >>> 0;
    t = startOfDay(Date.now()) + 1000 + (h % 83_998_999);
  }
  return {
    t,
    sessionId: sessionIdText,
    provider: providerText,
    model: modelText,
    seq: typeof event.seq === 'number' ? event.seq : -1,
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadTokens),
    cacheWrite: num(u.cacheWriteTokens),
    reasoning: num(u.reasoningTokens),
  };
}

/**
 * 自管理 SQLite 账本：events / session_meta 两表；读走内存缓存 + 按需
 * SELECT，写同步即持久，自动提交。测试注入 DSH_HOME 即可隔离介质。
 * 新增 agg_* 预统计表：对不会再变动的历史数据做物化聚合，启动时优先
 * 加载预统计，仅重放少量未密封账本，显著降低冷启动时间。
 */
export class Ledger {
  private db!: DatabaseSync;
  private stmts!: LedgerStatements;
  private readonly metaCache = new Map<string, SessionMeta>();
  private closed = false;
  private aggSuspended = false;
  private inTransaction = false;

  constructor(private readonly path: string = ledgerDatabasePath()) {}

  /** 打开账本：建目录、建表、迁移，user_version 不匹配则清库，再载入 meta 缓存。 */
  open(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec(EVENT_TABLE_DDL);
    this.db.exec(META_TABLE_DDL);
    this.db.exec(AGG_TOTAL_DDL);
    this.db.exec(AGG_DAILY_DDL);
    this.db.exec(AGG_MODEL_DDL);
    this.db.exec(AGG_MODEL_DAILY_DDL);
    this.db.exec(AGG_SESSION_DDL);
    this.db.exec(AGG_SESSION_DAILY_DDL);
    this.db.exec(AGG_CHECKPOINT_DDL);
    const resetAllTables = (): void => {
      this.db.exec('DROP TABLE IF EXISTS events');
      this.db.exec('DROP TABLE IF EXISTS session_meta');
      this.db.exec('DROP TABLE IF EXISTS agg_total');
      this.db.exec('DROP TABLE IF EXISTS agg_daily');
      this.db.exec('DROP TABLE IF EXISTS agg_model');
      this.db.exec('DROP TABLE IF EXISTS agg_model_daily');
      this.db.exec('DROP TABLE IF EXISTS agg_session');
      this.db.exec('DROP TABLE IF EXISTS agg_session_daily');
      this.db.exec('DROP TABLE IF EXISTS agg_checkpoint');
      this.db.exec(EVENT_TABLE_DDL);
      this.db.exec(META_TABLE_DDL);
      this.db.exec(AGG_TOTAL_DDL);
      this.db.exec(AGG_DAILY_DDL);
      this.db.exec(AGG_MODEL_DDL);
      this.db.exec(AGG_MODEL_DAILY_DDL);
      this.db.exec(AGG_SESSION_DDL);
      this.db.exec(AGG_SESSION_DAILY_DDL);
      this.db.exec(AGG_CHECKPOINT_DDL);
    };
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: unknown };
    const version = typeof row?.user_version === 'number' ? row.user_version : 0;
    if (version !== LEDGER_VERSION) {
      if (version === 3) {
        // 3 -> 4 增量迁移：session_meta 新增 parent_session / origin / delegation_depth 三列
        try { this.db.exec("ALTER TABLE session_meta ADD COLUMN parent_session TEXT NOT NULL DEFAULT ''"); } catch {}
        try { this.db.exec("ALTER TABLE session_meta ADD COLUMN origin TEXT NOT NULL DEFAULT ''"); } catch {}
        try { this.db.exec('ALTER TABLE session_meta ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0'); } catch {}
        console.warn(`[usage-stats] 账本 schema 升级 ${String(version)} -> ${String(LEDGER_VERSION)}，保留历史事件`);
        this.db.exec(`PRAGMA user_version = ${LEDGER_VERSION}`);
      } else if (version === 2) {
        // 2 -> 4：2->3 为 agg 表增量，已通过 IF NOT EXISTS 完成 + 3->4 为 meta 三列增量
        try { this.db.exec("ALTER TABLE session_meta ADD COLUMN parent_session TEXT NOT NULL DEFAULT ''"); } catch {}
        try { this.db.exec("ALTER TABLE session_meta ADD COLUMN origin TEXT NOT NULL DEFAULT ''"); } catch {}
        try { this.db.exec('ALTER TABLE session_meta ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0'); } catch {}
        console.warn(`[usage-stats] 账本 schema 升级 ${String(version)} -> ${String(LEDGER_VERSION)}，保留历史事件`);
        this.db.exec(`PRAGMA user_version = ${LEDGER_VERSION}`);
      } else if (version === 0) {
        // 全新库：首次创建，设置版本
        // 若表已存在且为空，无需 DROP
        const hasEvents = (() => {
          try { return this.db.prepare('SELECT 1 FROM events LIMIT 1').get() !== undefined; } catch { return false; }
        })();
        if (hasEvents) {
          // 异常的 0 版本但已有数据，按不兼容处理
          console.warn(`[usage-stats] 账本 schema 版本 ${String(version)} 与 ${String(LEDGER_VERSION)} 不一致，重建空账本`);
          resetAllTables();
        }
        this.db.exec(`PRAGMA user_version = ${LEDGER_VERSION}`);
      } else {
        // 结构不兼容：清空重建，事件表为空 → 下次启动走全量重扫
        console.warn(`[usage-stats] 账本 schema 版本 ${String(version)} 与 ${String(LEDGER_VERSION)} 不一致，重建空账本`);
        resetAllTables();
        this.db.exec(`PRAGMA user_version = ${LEDGER_VERSION}`);
      }
    }
    const hasEvent = this.db.prepare('SELECT 1 AS x FROM events LIMIT 1');
    const hasEventByPK = this.db.prepare('SELECT 1 AS x FROM events WHERE t = ? AND session_id = ? AND seq = ? LIMIT 1');
    const insertEvent = this.db.prepare(
      `INSERT INTO events (t, session_id, seq, provider, model, input, output, cache_read, cache_write, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(t, session_id, seq) DO UPDATE SET
         provider = excluded.provider, model = excluded.model,
         input = excluded.input, output = excluded.output,
         cache_read = excluded.cache_read, cache_write = excluded.cache_write,
         reasoning = excluded.reasoning`,
    );
    const allEvents = this.db.prepare(
      'SELECT t, session_id, seq, provider, model, input, output, cache_read, cache_write, reasoning FROM events',
    );
    const upsertMeta = this.db.prepare(
      `INSERT INTO session_meta (session_id, title, cwd, created_at, last_active, parent_session, origin, delegation_depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         title = excluded.title, cwd = excluded.cwd,
         created_at = excluded.created_at, last_active = excluded.last_active,
         parent_session = excluded.parent_session, origin = excluded.origin, delegation_depth = excluded.delegation_depth`,
    );
    const allMeta = this.db.prepare('SELECT session_id, title, cwd, created_at, last_active, parent_session, origin, delegation_depth FROM session_meta');
    // 预统计语句
    const hasAgg = this.db.prepare('SELECT 1 AS x FROM agg_total LIMIT 1');
    const getAggTotal = this.db.prepare('SELECT input, output, cache_read, cache_write, reasoning, total, calls, folded_events FROM agg_total WHERE id = 0');
    const allAggDaily = this.db.prepare('SELECT day, input, output, cache_read, cache_write, reasoning, total, calls FROM agg_daily');
    const allAggModel = this.db.prepare('SELECT provider, model, input, output, cache_read, cache_write, reasoning, total, calls FROM agg_model');
    const allAggModelDaily = this.db.prepare('SELECT provider, model, day, input, output, cache_read, cache_write, reasoning, total, calls FROM agg_model_daily');
    const allAggSession = this.db.prepare('SELECT session_id, input, output, cache_read, cache_write, reasoning, total, calls, max_seq, last_active FROM agg_session');
    const allAggSessionDaily = this.db.prepare('SELECT session_id, day, input, output, cache_read, cache_write, reasoning, total, calls FROM agg_session_daily');
    const incAggTotal = this.db.prepare(
      `INSERT INTO agg_total(id, input, output, cache_read, cache_write, reasoning, total, calls, folded_events)
       VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         input = agg_total.input + excluded.input,
         output = agg_total.output + excluded.output,
         cache_read = agg_total.cache_read + excluded.cache_read,
         cache_write = agg_total.cache_write + excluded.cache_write,
         reasoning = agg_total.reasoning + excluded.reasoning,
         total = agg_total.total + excluded.total,
         calls = agg_total.calls + excluded.calls,
         folded_events = agg_total.folded_events + excluded.folded_events`,
    );
    const incAggDaily = this.db.prepare(
      `INSERT INTO agg_daily(day, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         input = agg_daily.input + excluded.input,
         output = agg_daily.output + excluded.output,
         cache_read = agg_daily.cache_read + excluded.cache_read,
         cache_write = agg_daily.cache_write + excluded.cache_write,
         reasoning = agg_daily.reasoning + excluded.reasoning,
         total = agg_daily.total + excluded.total,
         calls = agg_daily.calls + excluded.calls`,
    );
    const incAggModel = this.db.prepare(
      `INSERT INTO agg_model(provider, model, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model) DO UPDATE SET
         input = agg_model.input + excluded.input,
         output = agg_model.output + excluded.output,
         cache_read = agg_model.cache_read + excluded.cache_read,
         cache_write = agg_model.cache_write + excluded.cache_write,
         reasoning = agg_model.reasoning + excluded.reasoning,
         total = agg_model.total + excluded.total,
         calls = agg_model.calls + excluded.calls`,
    );
    const incAggModelDaily = this.db.prepare(
      `INSERT INTO agg_model_daily(provider, model, day, input, output, cache_read, cache_write, reasoning, total, calls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, model, day) DO UPDATE SET
          input = agg_model_daily.input + excluded.input,
          output = agg_model_daily.output + excluded.output,
          cache_read = agg_model_daily.cache_read + excluded.cache_read,
          cache_write = agg_model_daily.cache_write + excluded.cache_write,
          reasoning = agg_model_daily.reasoning + excluded.reasoning,
          total = agg_model_daily.total + excluded.total,
          calls = agg_model_daily.calls + excluded.calls`,
    );
    const incAggSession = this.db.prepare(
      `INSERT INTO agg_session(session_id, input, output, cache_read, cache_write, reasoning, total, calls, max_seq, last_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         input = agg_session.input + excluded.input,
         output = agg_session.output + excluded.output,
         cache_read = agg_session.cache_read + excluded.cache_read,
         cache_write = agg_session.cache_write + excluded.cache_write,
         reasoning = agg_session.reasoning + excluded.reasoning,
         total = agg_session.total + excluded.total,
         calls = agg_session.calls + excluded.calls,
         max_seq = CASE WHEN excluded.max_seq > agg_session.max_seq THEN excluded.max_seq ELSE agg_session.max_seq END,
         last_active = CASE WHEN excluded.last_active > agg_session.last_active THEN excluded.last_active ELSE agg_session.last_active END`,
    );
    const incAggSessionDaily = this.db.prepare(
      `INSERT INTO agg_session_daily(session_id, day, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, day) DO UPDATE SET
         input = agg_session_daily.input + excluded.input,
         output = agg_session_daily.output + excluded.output,
         cache_read = agg_session_daily.cache_read + excluded.cache_read,
         cache_write = agg_session_daily.cache_write + excluded.cache_write,
         reasoning = agg_session_daily.reasoning + excluded.reasoning,
         total = agg_session_daily.total + excluded.total,
         calls = agg_session_daily.calls + excluded.calls`,
    );
    const insertAggTotalBulk = this.db.prepare(
      `INSERT INTO agg_total(id, input, output, cache_read, cache_write, reasoning, total, calls, folded_events)
       VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAggDailyBulk = this.db.prepare(
      `INSERT INTO agg_daily(day, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAggModelBulk = this.db.prepare(
      `INSERT INTO agg_model(provider, model, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAggModelDailyBulk = this.db.prepare(
      `INSERT INTO agg_model_daily(provider, model, day, input, output, cache_read, cache_write, reasoning, total, calls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAggSessionBulk = this.db.prepare(
      `INSERT INTO agg_session(session_id, input, output, cache_read, cache_write, reasoning, total, calls, max_seq, last_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAggSessionDailyBulk = this.db.prepare(
      `INSERT INTO agg_session_daily(session_id, day, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const getCheckpoint = this.db.prepare('SELECT value FROM agg_checkpoint WHERE key = ?');
    const upsertCheckpoint = this.db.prepare(
      `INSERT INTO agg_checkpoint(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const allEventsSince = this.db.prepare(
      'SELECT t, session_id, seq, provider, model, input, output, cache_read, cache_write, reasoning FROM events WHERE t >= ?',
    );
    this.stmts = {
      hasEvent, hasEventByPK, insertEvent, allEvents, upsertMeta, allMeta,
      hasAgg, getAggTotal, allAggDaily, allAggModel, allAggModelDaily, allAggSession, allAggSessionDaily,
      incAggTotal, incAggDaily, incAggModel, incAggModelDaily, incAggSession, incAggSessionDaily,
      insertAggTotalBulk, insertAggDailyBulk, insertAggModelBulk, insertAggModelDailyBulk, insertAggSessionBulk, insertAggSessionDailyBulk,
      getCheckpoint, upsertCheckpoint, allEventsSince,
    };
    for (const row of allMeta.all() as Record<string, unknown>[]) {
      const id = String(row.session_id);
      this.metaCache.set(id, {
        title: String(row.title ?? ''),
        cwd: String(row.cwd ?? ''),
        createdAt: Number(row.created_at) || 0,
        lastActive: Number(row.last_active) || 0,
        parentSession: String(row.parent_session ?? ''),
        origin: String(row.origin ?? ''),
        delegationDepth: Number(row.delegation_depth) || 0,
      });
    }
  }

  /** 事件流是否已有内容，决定首启扫描或直接重建。 */
  hasEvents(): boolean {
    this.assertOpen();
    return this.stmts.hasEvent.get() !== undefined;
  }

  /** 指定主键的事件是否已存在，用于 seq=-1 等无法通过水位去重的幂等校验。
   *  键与 append 同样经 NUL 清洗，保证读写对称命中。 */
  hasEventAt(t: number, sessionId: string, seq: number): boolean {
    this.assertOpen();
    return this.stmts.hasEventByPK.get(t, sanitizeSqlText(sessionId), seq) !== undefined;
  }

  /** 追加一条事件，幂等，同 t+session+seq 收敛为 upsert，返回是否为新插入。 */
  append(ev: LedgerEvent): boolean {
    this.assertOpen();
    const existed = this.hasEventAt(ev.t, ev.sessionId, ev.seq);
    this.stmts.insertEvent.run(
      ev.t, ev.sessionId, ev.seq,
      ev.provider, ev.model,
      ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning,
    );
    return !existed;
  }

  /** 更新会话元数据，增量合并，内存缓存与同步写回，全部字符串经 NUL 清洗后入列。 */
  setMeta(id: string, patch: Partial<SessionMeta>): void {
    this.assertOpen();
    const key = sanitizeSqlText(id);
    const current = this.metaCache.get(key) ?? emptySessionMeta();
    const next: SessionMeta = {
      title: typeof patch.title === 'string' ? sanitizeSqlText(patch.title) : current.title,
      cwd: typeof patch.cwd === 'string' ? sanitizeSqlText(patch.cwd) : current.cwd,
      createdAt: typeof patch.createdAt === 'number' && Number.isFinite(patch.createdAt) && patch.createdAt > 0 ? patch.createdAt : current.createdAt,
      // lastActive 取最大值，保证事件时间单调递增且不被旧值覆盖
      lastActive: typeof patch.lastActive === 'number' && Number.isFinite(patch.lastActive) && patch.lastActive > 0
        ? Math.max(current.lastActive, patch.lastActive)
        : current.lastActive,
      parentSession: typeof patch.parentSession === 'string' ? sanitizeSqlText(patch.parentSession) : current.parentSession,
      origin: typeof patch.origin === 'string' ? sanitizeSqlText(patch.origin) : current.origin,
      delegationDepth: typeof patch.delegationDepth === 'number' && Number.isFinite(patch.delegationDepth) && patch.delegationDepth >= 0 ? patch.delegationDepth : current.delegationDepth,
    };
    this.metaCache.set(key, next);
    this.stmts.upsertMeta.run(key, next.title, next.cwd, next.createdAt, next.lastActive, next.parentSession, next.origin, next.delegationDepth);
  }

  /** 取会话元数据，无则返回 null，键与 setMeta 同样清洗，保证读写对称命中。 */
  getMeta(id: string): SessionMeta | null {
    this.assertOpen();
    return this.metaCache.get(sanitizeSqlText(id)) ?? null;
  }

  /** 全部账本事件，冷启动或重建时逐条折叠进聚合缓存。 */
  allEvents(): LedgerEvent[] {
    this.assertOpen();
    const rows = this.stmts.allEvents.all() as Record<string, unknown>[];
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
    }));
  }

  /** 查询指定时间戳之后的事件，增量加载，预统计加速。 */
  allEventsSince(since: number): LedgerEvent[] {
    this.assertOpen();
    const rows = this.stmts.allEventsSince.all(since) as Record<string, unknown>[];
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
    }));
  }

  /** 清空事件流与元数据，重建账本用，保留表结构。 */
  clear(): void {
    this.assertOpen();
    this.db.exec('DELETE FROM events');
    this.db.exec('DELETE FROM session_meta');
    this.metaCache.clear();
    this.clearAggregates();
  }

  /** 关闭数据库连接，插件卸载时调用，幂等。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ledger is closed');
  }

  // ---- 预统计相关 ----

  /** 是否已暂停预统计增量，批量导入期间挂起，避免每行多次写。 */
  isAggSuspended(): boolean {
    return this.aggSuspended;
  }

  /** 设置预统计增量挂起，批量扫描时调用。 */
  setAggSuspended(v: boolean): void {
    this.aggSuspended = v;
  }

  /** 在事务中执行，支持嵌套，已在事务内则直接执行。 */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    if (this.inTransaction) return fn();
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }

  /** 预统计是否已有内容，即是否有物化聚合。 */
  hasAggregates(): boolean {
    this.assertOpen();
    return this.stmts.hasAgg.get() !== undefined;
  }

  /** 增量更新预统计，单条事件，对应一次用量调用。 */
  incrementAgg(ev: LedgerEvent): void {
    this.assertOpen();
    if (this.aggSuspended) return;
    if (ev.input + ev.output + ev.cacheRead + ev.cacheWrite + ev.reasoning <= 0) return;
    const day = startOfDay(ev.t);
    const total = ev.input + ev.output + ev.cacheRead + ev.cacheWrite;
    const runInTx = (): void => {
      this.stmts.incAggTotal.run(ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1, 1);
      this.stmts.incAggDaily.run(day, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1);
      this.stmts.incAggModel.run(ev.provider, ev.model, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1);
      this.stmts.incAggModelDaily.run(ev.provider, ev.model, day, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1);
      this.stmts.incAggSession.run(ev.sessionId, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1, ev.seq, ev.t);
      this.stmts.incAggSessionDaily.run(ev.sessionId, day, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1);
    };
    if (this.inTransaction) {
      runInTx();
    } else {
      this.transaction(runInTx);
    }
  }

  /** 批量物化当前内存聚合到 DB，覆盖式，全量预统计。 */
  persistAggregates(store: UsageStore): void {
    this.assertOpen();
    this.transaction(() => {
      this.db.exec('DELETE FROM agg_total');
      this.db.exec('DELETE FROM agg_daily');
      this.db.exec('DELETE FROM agg_model');
      this.db.exec('DELETE FROM agg_model_daily');
      this.db.exec('DELETE FROM agg_session');
      this.db.exec('DELETE FROM agg_session_daily');
      // 全量
      const a = store.allAgg;
      this.stmts.insertAggTotalBulk.run(a.input, a.output, a.cacheRead, a.cacheWrite, a.reasoning, a.total, a.calls, store.foldedEvents);
      // 按日
      for (const [day, agg] of store.allDaily) {
        this.stmts.insertAggDailyBulk.run(day, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.reasoning, agg.total, agg.calls);
      }
      // 按模型
      for (const [key, agg] of store.models) {
        const { provider, model } = splitModelKey(key);
        this.stmts.insertAggModelBulk.run(provider, model, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.reasoning, agg.total, agg.calls);
      }
      // 按模型×日
      for (const [key, dailyMap] of store.modelDaily) {
        const { provider, model } = splitModelKey(key);
        for (const [day, agg] of dailyMap) {
          this.stmts.insertAggModelDailyBulk.run(provider, model, day, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.reasoning, agg.total, agg.calls);
        }
      }
      // 按会话
      for (const [sid, info] of store.sessions) {
        const ag = info.allAgg;
        this.stmts.insertAggSessionBulk.run(sid, ag.input, ag.output, ag.cacheRead, ag.cacheWrite, ag.reasoning, ag.total, ag.calls, info.maxSeq, info.lastActive);
        for (const [day, dAgg] of info.daily) {
          this.stmts.insertAggSessionDailyBulk.run(sid, day, dAgg.input, dAgg.output, dAgg.cacheRead, dAgg.cacheWrite, dAgg.reasoning, dAgg.total, dAgg.calls);
        }
      }
    });
  }

  /** 从预统计加载内存聚合，快速启动路径，无需重放全量事件，返回是否命中。 */
  loadAggregates(store: UsageStore): boolean {
    this.assertOpen();
    const totalRow = this.stmts.getAggTotal.get() as Record<string, unknown> | undefined;
    if (totalRow === undefined) return false;
    // 清空现有
    store.allAgg.input = Number(totalRow.input) || 0;
    store.allAgg.output = Number(totalRow.output) || 0;
    store.allAgg.cacheRead = Number(totalRow.cache_read) || 0;
    store.allAgg.cacheWrite = Number(totalRow.cache_write) || 0;
    store.allAgg.reasoning = Number(totalRow.reasoning) || 0;
    store.allAgg.total = Number(totalRow.total) || 0;
    store.allAgg.calls = Number(totalRow.calls) || 0;
    store.foldedEvents = Number(totalRow.folded_events) || store.allAgg.calls;
    store.allDaily.clear();
    store.models.clear();
    store.modelDaily.clear();
    store.sessions.clear();
    for (const r of this.stmts.allAggDaily.all() as Record<string, unknown>[]) {
      const day = Number(r.day) || 0;
      store.allDaily.set(day, {
        input: Number(r.input) || 0,
        output: Number(r.output) || 0,
        cacheRead: Number(r.cache_read) || 0,
        cacheWrite: Number(r.cache_write) || 0,
        reasoning: Number(r.reasoning) || 0,
        total: Number(r.total) || 0,
        calls: Number(r.calls) || 0,
      });
    }
    for (const r of this.stmts.allAggModel.all() as Record<string, unknown>[]) {
      const key = String(r.provider) + '\u0000' + String(r.model);
      store.models.set(key, {
        input: Number(r.input) || 0,
        output: Number(r.output) || 0,
        cacheRead: Number(r.cache_read) || 0,
        cacheWrite: Number(r.cache_write) || 0,
        reasoning: Number(r.reasoning) || 0,
        total: Number(r.total) || 0,
        calls: Number(r.calls) || 0,
      });
    }
    for (const r of this.stmts.allAggModelDaily.all() as Record<string, unknown>[]) {
      const key = String(r.provider) + '\u0000' + String(r.model);
      const day = Number(r.day) || 0;
      let daily = store.modelDaily.get(key);
      if (!daily) { daily = new Map(); store.modelDaily.set(key, daily); }
      daily.set(day, {
        input: Number(r.input) || 0,
        output: Number(r.output) || 0,
        cacheRead: Number(r.cache_read) || 0,
        cacheWrite: Number(r.cache_write) || 0,
        reasoning: Number(r.reasoning) || 0,
        total: Number(r.total) || 0,
        calls: Number(r.calls) || 0,
      });
    }
    // 兼容旧库：若 modelDaily 为空但 models 已有数据，v4 升级，从 events 重建 modelDaily
    if (store.modelDaily.size === 0 && store.models.size > 0) {
      try {
        const events = this.allEvents();
        for (const ev of events) {
          const day = startOfDay(ev.t);
          const key = ev.provider + '\u0000' + ev.model;
          let daily = store.modelDaily.get(key);
          if (!daily) { daily = new Map(); store.modelDaily.set(key, daily); }
          let agg = daily.get(day);
          if (!agg) { agg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 }; daily.set(day, agg); }
          agg.input += ev.input;
          agg.output += ev.output;
          agg.cacheRead += ev.cacheRead;
          agg.cacheWrite += ev.cacheWrite;
          agg.reasoning += ev.reasoning;
          agg.total += ev.input + ev.output + ev.cacheRead + ev.cacheWrite;
          agg.calls += 1;
        }
        if (store.modelDaily.size > 0) {
          this.transaction(() => {
            this.db.exec('DELETE FROM agg_model_daily');
            for (const [key, dailyMap] of store.modelDaily) {
              const { provider, model } = splitModelKey(key);
              for (const [day, agg] of dailyMap) {
                this.stmts.insertAggModelDailyBulk.run(provider, model, day, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.reasoning, agg.total, agg.calls);
              }
            }
          });
        }
      } catch (e) {
        console.error('[usage-stats] modelDaily 重建失败', e);
      }
    }
    for (const r of this.stmts.allAggSession.all() as Record<string, unknown>[]) {
      const sid = String(r.session_id);
      store.sessions.set(sid, {
        daily: new Map(),
        allAgg: {
          input: Number(r.input) || 0,
          output: Number(r.output) || 0,
          cacheRead: Number(r.cache_read) || 0,
          cacheWrite: Number(r.cache_write) || 0,
          reasoning: Number(r.reasoning) || 0,
          total: Number(r.total) || 0,
          calls: Number(r.calls) || 0,
        },
        maxSeq: typeof r.max_seq === 'number' ? r.max_seq : Number(r.max_seq) || -1,
        lastActive: Number(r.last_active) || 0,
      });
    }
    for (const r of this.stmts.allAggSessionDaily.all() as Record<string, unknown>[]) {
      const sid = String(r.session_id);
      const day = Number(r.day) || 0;
      let info = store.sessions.get(sid);
      if (!info) {
        info = { daily: new Map(), allAgg: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 }, maxSeq: -1, lastActive: 0 };
        store.sessions.set(sid, info);
      }
      info.daily.set(day, {
        input: Number(r.input) || 0,
        output: Number(r.output) || 0,
        cacheRead: Number(r.cache_read) || 0,
        cacheWrite: Number(r.cache_write) || 0,
        reasoning: Number(r.reasoning) || 0,
        total: Number(r.total) || 0,
        calls: Number(r.calls) || 0,
      });
    }
    return true;
  }

  /** 清空预统计，重建或清零时调用。 */
  clearAggregates(): void {
    this.assertOpen();
    this.db.exec('DELETE FROM agg_total');
    this.db.exec('DELETE FROM agg_daily');
    this.db.exec('DELETE FROM agg_model');
    this.db.exec('DELETE FROM agg_model_daily');
    this.db.exec('DELETE FROM agg_session');
    this.db.exec('DELETE FROM agg_session_daily');
    this.db.exec('DELETE FROM agg_checkpoint');
  }

  /** 读检查点。 */
  getCheckpoint(key: string): number | null {
    this.assertOpen();
    const row = this.stmts.getCheckpoint.get(key) as { value?: unknown } | undefined;
    if (!row) return null;
    const v = Number(row.value);
    return Number.isFinite(v) ? v : null;
  }

  /** 写检查点。 */
  setCheckpoint(key: string, value: number): void {
    this.assertOpen();
    this.stmts.upsertCheckpoint.run(key, value);
  }

  /** 密封指定日期之前的预统计，将历史数据物化，启动时仅加载增量。 */
  sealUntil(dayStart: number): void {
    this.assertOpen();
    this.setCheckpoint('sealed_until', dayStart);
  }

  /** 获取已密封边界，默认为 0。 */
  getSealedUntil(): number {
    return this.getCheckpoint('sealed_until') ?? 0;
  }
}
