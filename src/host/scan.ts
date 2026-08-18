/**
 * 会话扫描编排（账本导入）：把磁盘原始日志 ∪ harness 会话清单的会话 id
 * 全集逐会话读取，经 foldRecord 写入账本并折叠聚合缓存。RAW 优先
 * （persistence.readRaw 直接返回后端解码后的原始 JSONL 文本 —— 纯 JS zstd
 * 解码，无 CLI 依赖），后端不支持原始工件时走 harness 兜底
 * （sessionQuery.readSession / persistence.readFrom）；4 路 worker 并行。
 *
 * 语义：只在账本需要初始化（首启无事件）或显式重建时运行；平时数据来自
 * 实时 session/event 监听 + 60s 对账（账本增量折叠），不再周期性全量重扫。
 * 扫描报告（rawSessions / harnessSessions / failed）记录最近一次导入结果。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { SESSIONS_ROOT, findSessionLogs, parseLogLines } from './logs.ts'
import type { UsageStore } from './store.ts'
import { foldLedgerEvent, foldRecord } from './store.ts'
import type { Ledger } from './ledger.ts'
import { newAgg } from './agg.ts'

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

/** 错误对象转消息字符串。 */
const msgOf = (e: unknown): string =>
  (e && typeof e === 'object' && (e as { message?: unknown }).message) ? String((e as { message: unknown }).message) : String(e)

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
  if (initial) store.scanning = true
  // 防重入：扫描永不重叠。
  if (store.running) return
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

    // 1) 会话 id 全集 = 磁盘原始日志 ∪ harness 会话清单。
    const logPaths = new Map<string, string>()
    findSessionLogs(SESSIONS_ROOT, 0, logPaths)
    const ids = new Set<string>(logPaths.keys())

    if (query) {
      try {
        const listed = await query.listSessions()
        if (Array.isArray(listed)) {
          for (const rec of listed) {
            if (rec.header && typeof rec.header.id === 'string') ids.add(rec.header.id)
          }
        }
      } catch (e) {
        store.scanError = 'listSessions: ' + msgOf(e)
      }
    }
    if (persist) {
      try {
        const headers = await persist.list()
        if (Array.isArray(headers)) {
          for (const header of headers) {
            if (header && typeof header.id === 'string') ids.add(header.id)
          }
          if (headers.length > 0) store.scanError = null
        }
      } catch (e) {
        store.scanError = 'persistence.list: ' + msgOf(e)
      }
    }
    const idList: string[] = [...ids]

    // 2) 逐会话：RAW 优先（完整、不受解释器限制），失败则 harness 兜底。
    let i = 0
    async function worker(): Promise<void> {
      while (i < idList.length) {
        const id = idList[i]; i += 1
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
              store.lastError = 'raw ' + shortOf(id) + ': ' + msgOf(e)
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
              store.lastError = 'readSession ' + shortOf(id) + ': ' + msgOf(e)
              events = null
            }
          }
          if (events === null && persist) {
            try {
              const r = await persist.readFrom(id as SessionId, 0)
              events = r && Array.isArray(r.events) ? r.events : []
            } catch (e) {
              store.lastError = 'readFrom ' + shortOf(id) + ': ' + msgOf(e)
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
          store.lastError = 'session ' + shortOf(id) + ': ' + msgOf(e)
          store.failed += 1
        }
      }
    }

    const n = Math.max(1, Math.min(4, idList.length || 1))
    const workers: Promise<void>[] = []
    for (let k = 0; k < n; k += 1) workers.push(worker())
    await Promise.all(workers.map((w) => w.catch((e) => { store.lastError = 'worker: ' + msgOf(e); store.failed += 1 })))
  } finally {
    // 整轮无失败会话则清除历史错误标记（自愈：日志可读性恢复后自动消失）。
    if (store.failed === 0) { store.lastError = null; store.scanError = null }
    if (initial) store.scanning = false
    store.running = false
  }
}

/** 从账本事件流重建聚合缓存（启动加载账本已有事件时用；元数据已在 ledger）。
   *  清空现有聚合后按事件流全量重折，水位随 readAll 建立。 */
export function rebuildFromEvents(store: UsageStore, ledger: Ledger): void {
  store.sessions.clear()
  store.models.clear()
  store.allAgg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 }
  store.allDaily.clear()
  store.foldedEvents = 0
  store.dedupSkipped = 0
  for (const ev of ledger.readAll()) foldLedgerEvent(store, ev)
}

/** 增量对账：把账本新增行折叠进现有聚合（60s 定时用；不重建、不清空）。
   *  返回新折叠事件数。崩溃丢内存增量后重启走 rebuildFromEvents 全量重建。 */
export function reconcileNewEvents(store: UsageStore, ledger: Ledger): number {
  let folded = 0
  for (const name of ledger.shards()) {
    for (const ev of ledger.readShardSince(name)) {
      if (foldLedgerEvent(store, ev)) folded += 1
    }
  }
  return folded
}