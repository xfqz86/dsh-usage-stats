/**
 * 会话扫描编排：每轮把「磁盘原始日志 ∪ harness 会话清单」的会话 id 全集
 * 逐会话折叠进 store。RAW 优先（persistence.readRaw 直接返回后端解码后的
 * 原始 JSONL 文本 —— 纯 JS zstd 解码，无 CLI 依赖），后端不支持原始工件
 * 时走 harness 兜底（sessionQuery.readSession / persistence.readFrom）；
 * 4 路 worker 并行。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SESSIONS_ROOT, findSessionLogs, parseLogLines } from './logs.ts'
import type { UsageStore } from './store.ts'
import { foldSessionEvents } from './store.ts'

/** 错误对象转消息字符串。 */
const msgOf = (e: unknown): string =>
  (e && typeof e === 'object' && (e as { message?: unknown }).message) ? String((e as { message: unknown }).message) : String(e)

/** 会话 id 截断展示（前 12 字符）。 */
const shortOf = (id: string): string =>
  typeof id === 'string' && id.length > 12 ? id.slice(0, 12) + '…' : String(id)

/** 扫描一轮全部会话（初始 / 自愈重扫共用；防重入由 store.running 保证）。
 *  整轮无失败会话时清除历史错误标记（自愈：日志可读性恢复后自动消失）。 */
export async function scanOnce(
  ctx: Context,
  store: UsageStore,
  options: { initial?: boolean },
): Promise<void> {
  const initial = !!(options && options.initial)
  if (initial) store.scanning = true
  // 防重入：扫描永不重叠（初始扫描与 60s 自愈重扫互斥）。
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
            foldSessionEvents(store, id, parseLogLines(rawContent))
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
            foldSessionEvents(store, id, events)
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