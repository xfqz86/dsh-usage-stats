/**
 * 会话日志的目录发现与 NDJSON 解析。物理编码解码（zstd）不在这层做：
 * 由 harness 的 persistence 服务 `readRaw` 返回已解码的原始文本
 * （见 scan.ts），本模块只负责定位会话目录、解析文本行。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** DSH 数据主目录；SESSIONS_ROOT 是其下的会话目录。 */
export const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
export const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

/** 持久化的会话种子记录：会话头（SessionHeader）序列化后带
 *  `type: 'session'` 标记，作为日志第一行。 */
export type SessionSeedRecord = SessionHeader & { type: 'session' }

/** 解析一行 NDJSON：会话事件、会话种子记录，或空行/坏行返回 null。 */
export function parseLine(line: string): SessionEvent | SessionSeedRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as SessionEvent | SessionSeedRecord
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') return parsed
    return null
  } catch {
    return null
  }
}

/** 解析 NDJSON 日志体为记录数组（跳过坏行）。 */
export function parseLogLines(text: string): Array<SessionEvent | SessionSeedRecord> {
  const records: Array<SessionEvent | SessionSeedRecord> = []
  for (const line of text.split('\n')) {
    const record = parseLine(line)
    if (record) records.push(record)
  }
  return records
}

/** 递归发现会话根目录下的全部会话日志（深度 ≤3）：sessionId -> 日志路径。
 *  同时覆盖裸 id 目录与编码工作区目录。 */
export function findSessionLogs(root: string, depth: number, out: Map<string, string>): void {
  if (depth > 3) return
  let entries: string[]
  try { entries = readdirSync(root) } catch { return }
  for (const entry of entries) {
    const p = join(root, entry)
    let st: unknown
    try { st = statSync(p) } catch { continue }
    if ((st as { isDirectory(): boolean }).isDirectory()) {
      findSessionLogs(p, depth + 1, out)
    } else if (entry === 'session.jsonl.zstd') {
      const id = root.split('/').pop() || ''
      if (id) out.set(id, p)
    }
  }
}