/**
 * 会话扫描编排（账本导入）：把磁盘原始日志 ∪ harness 会话清单的会话 id
 * 全集逐会话读取，经 foldRecord 写入账本（自管理 sqlite 的 events /
 * session_meta 表）并折叠聚合缓存。RAW 优先
 * （persistence.readRaw 直接返回后端解码后的原始 JSONL 文本 —— 纯 JS zstd
 * 解码，无 CLI 依赖），后端不支持原始工件时走 harness 兜底
 * （sessionQuery.readSession / persistence.readFrom）；4 路 worker 并行。
 *
 * 语义：只在账本需要初始化（首启无事件）或显式重建时运行；平时数据来自
 * 实时 session/event 监听（每次写入同步落盘，无需周期性对账）。
 * 扫描报告（rawSessions / harnessSessions / failed）记录最近一次导入结果。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { findSessionLogs, getSessionsRoot, parseLogLines } from './logs.ts'
import type { UsageStore } from './store.ts'
import { foldLedgerEvent, foldRecord } from './store.ts'
import type { Ledger } from './ledger.ts'
import { newAgg } from './agg.ts'
import { errorMessage } from '../utils.ts'

/** 复位聚合缓存（重建账本前调用）：清空会话/模型/全量/日桶与去重水位与计数。 */
export function resetStore(store: UsageStore): void {
  store.sessions.clear()
  store.models.clear()
  store.allAgg = newAgg()
  store.allDaily.clear()
  store.foldedEvents = 0
  store.dedupSkipped = 0
  store.rawSessions = 0
  store.harnessSessions = 0
  store.failed = 0
  store.lastError = null
  store.scanError = null
}

/** 会话 id 截断展示（前 12 字符）。 */
const shortOf = (id: string): string =>
  typeof id === 'string' && id.length > 12 ? id.slice(0, 12) + '…' : String(id)

/** 扫描一轮全部会话并将其写入账本（初始 / 重建共用；防重入由 store.running 保证）。
 *  整轮无失败会话时清除历史错误标记（自愈：日志可读性恢复后自动消失）。 */
export async function scanOnce(
  ctx: Context,
  store: UsageStore,
  ledger: Ledger,
  options: { initial?: boolean },
): Promise<void> {
  const initial = !!(options && options.initial)
  // 防重入：扫描永不重叠（检查在 scanning 标记之前，避免早返回时 scanning 卡死）。
  if (store.running) return
  if (initial) store.scanning = true
  store.running = true
  store.scans += 1
  store.lastScanAt = Date.now()
  // 每轮扫描独立计数；整轮成功则清除历史错误标记。
  store.failed = 0
  store.rawSessions = 0
  store.harnessSessions = 0
  try {
    const query = ctx.sessionQuery
    const persist = ctx.sessionPersistence

    // 1) 会话 id 全集 = 磁盘原始日志 ∪ harness 会话清单；同时收集 header 的 cwd/createdAt 以便在无 RAW 时仍能填充 session_meta。
    const logPaths = new Map<string, string>()
    findSessionLogs(getSessionsRoot(), 0, logPaths)
    const ids = new Set<string>(logPaths.keys())
    const headerMap = new Map<string, { cwd?: string; createdAt?: number }>()

    if (query) {
      try {
        const listed = await query.listSessions()
        if (Array.isArray(listed)) {
          for (const rec of listed) {
            if (rec.header && typeof rec.header.id === 'string') {
              ids.add(rec.header.id)
              const h = rec.header as { cwd?: unknown; createdAt?: unknown }
              if (typeof h.cwd === 'string' || typeof h.createdAt === 'number') {
                headerMap.set(rec.header.id, { cwd: typeof h.cwd === 'string' ? h.cwd : undefined, createdAt: typeof h.createdAt === 'number' ? h.createdAt : undefined })
              }
            }
          }
        }
      } catch (e) {
        store.scanError = 'listSessions: ' + errorMessage(e)
      }
    }
    if (persist) {
      try {
        const headers = await persist.list()
        if (Array.isArray(headers)) {
          for (const header of headers) {
            if (header && typeof header.id === 'string') {
              ids.add(header.id)
              const h = header as { cwd?: unknown; createdAt?: unknown }
              if (typeof h.cwd === 'string' || typeof h.createdAt === 'number') {
                if (!headerMap.has(header.id)) headerMap.set(header.id, { cwd: typeof h.cwd === 'string' ? h.cwd : undefined, createdAt: typeof h.createdAt === 'number' ? h.createdAt : undefined })
              }
            }
          }
          if (headers.length > 0) store.scanError = null
        }
      } catch (e) {
        store.scanError = 'persistence.list: ' + errorMessage(e)
      }
    }
    const idList: string[] = [...ids]

    // 2) 逐会话：RAW 优先（完整、不受解释器限制），失败则 harness 兜底。
    //    对于无 RAW 的会话，用 headerMap 的 cwd/createdAt 预填充 session_meta，避免 cwd/created_at/last_active 为空。
    let i = 0
    async function worker(): Promise<void> {
      while (i < idList.length) {
        const id = idList[i]; i += 1
        // 预填充 header 元数据（若有），保证即使无 RAW/无 seed 记录时也不为空
        const hdr = headerMap.get(id)
        if (hdr && (hdr.cwd !== undefined || hdr.createdAt !== undefined)) {
          ledger.setMeta(id, { cwd: hdr.cwd, createdAt: hdr.createdAt, lastActive: hdr.createdAt })
        }
        try {
          // 2a) RAW 优先：后端原样工件（readRaw 返回解码后的完整 JSONL
          //     文本；zstd 物理编码由后端纯 JS 解码，无 CLI 依赖）。
          //     会话 id 来自磁盘发现时，可能尚未物化 → readRaw 返回 undefined。
          let rawContent: string | null = null
          if (persist && persist.supportsRawArtifacts) {
            try {
              const raw = await persist.readRaw(id as SessionId)
              if (raw && typeof raw.content === 'string') rawContent = raw.content
            } catch (e) {
              store.lastError = 'raw ' + shortOf(id) + ': ' + errorMessage(e)
            }
          }
          if (rawContent !== null) {
            for (const record of parseLogLines(rawContent)) foldRecord(store, ledger, id, record)
            store.rawSessions += 1
            continue
          }
          // 2b) harness 兜底：sessionQuery.readSession / persistence.readFrom
          let events: SessionEvent[] | null = null
          if (query) {
            try {
              const snap = await query.readSession(id as SessionId)
              events = snap && Array.isArray(snap.events) ? snap.events : null
            } catch (e) {
              store.lastError = 'readSession ' + shortOf(id) + ': ' + errorMessage(e)
              events = null
            }
          }
          if (events === null && persist) {
            try {
              const r = await persist.readFrom(id as SessionId, 0)
              events = r && Array.isArray(r.events) ? r.events : []
            } catch (e) {
              store.lastError = 'readFrom ' + shortOf(id) + ': ' + errorMessage(e)
              events = null
            }
          }
          if (events && events.length) {
            for (const event of events) foldRecord(store, ledger, id, event)
            store.harnessSessions += 1
          } else if (events === null) {
            // 只有 RAW 与 harness 都报错才算失败；空会话（events=[]）不算。
            store.failed += 1
          }
        } catch (e) {
          store.lastError = 'session ' + shortOf(id) + ': ' + errorMessage(e)
          store.failed += 1
        }
      }
    }

    const n = Math.max(1, Math.min(4, idList.length || 1))
    const workers: Promise<void>[] = []
    for (let k = 0; k < n; k += 1) workers.push(worker())
    await Promise.all(workers.map((w) => w.catch((e) => { store.lastError = 'worker: ' + errorMessage(e); store.failed += 1 })))
  } finally {
    // 整轮无失败会话则清除历史错误标记（自愈：日志可读性恢复后自动消失）。
    if (store.failed === 0) { store.lastError = null; store.scanError = null }
    if (initial) store.scanning = false
    store.running = false
  }
}

/** 从账本事件流重建聚合缓存（启动加载账本已有事件时用；元数据已在 ledger）。
 *  清空现有聚合后按事件流全量重折；maxSeq 水位在 foldLedgerEvent 内重建，
 *  实时路径随后可对历史事件去重。 */
export function rebuildFromEvents(store: UsageStore, ledger: Ledger): void {
  store.sessions.clear()
  store.models.clear()
  store.allAgg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 }
  store.allDaily.clear()
  store.foldedEvents = 0
  store.dedupSkipped = 0
  for (const ev of ledger.allEvents()) foldLedgerEvent(store, ev)
}