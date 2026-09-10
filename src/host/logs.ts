/**
 * 会话日志的目录发现与 NDJSON 解析。会话事件读取优先走 harness 服务
 * （sessionQuery.readSession / persistence.open+read，见 scan.ts），读取失败或
 * 返回空事件时由扫描链路用本模块定位到的原始文件经 rawlog 兜底解码；
 * 本模块只负责定位每个会话目录下的最高代次日志、解析文本行。
 */
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseSessionLogName } from './rawlog.ts';

import type { SessionLogCompression } from './rawlog.ts';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';

/** 读取当前 DSH 数据主目录（每次调用重新读取环境变量，避免模块加载时环境未就绪导致路径陈旧）。 */
export function getDshHome(): string {
  return process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
}
/** 动态获取会话根目录（基于 getDshHome，不固化模块级路径）。 */
export function getSessionsRoot(): string {
  return join(getDshHome(), 'sessions');
}

/** 持久化的会话种子记录：会话头（SessionHeader）序列化后带
 *  `type: 'session'` 标记。 */
export type SessionSeedRecord = SessionHeader & { type: 'session' };

/** 解析一行 NDJSON：会话事件、会话种子记录，或空行/坏行返回 null。 */
export function parseLine(line: string): SessionEvent | SessionSeedRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as SessionEvent | SessionSeedRecord;
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/** 解析 NDJSON 日志体为记录数组（跳过坏行）。 */
export function parseLogLines(text: string): (SessionEvent | SessionSeedRecord)[] {
  const records: (SessionEvent | SessionSeedRecord)[] = [];
  for (const line of text.split('\n')) {
    const record = parseLine(line);
    if (record) records.push(record);
  }
  return records;
}

/** 会话目录中选定的日志文件：最高物理代次、物理编码与磁盘路径。
 *  代次与编码由 rawlog 的规范文件名解析得出。 */
export interface SessionLogFile {
  path: string
  generation: number
  compression: SessionLogCompression
}

/** 递归发现会话根目录下的全部会话日志（深度 ≤3）：sessionId -> 最高代次日志。
 *  sessionId 取会话目录名（实测与 harness header.id 一致，含旧目录名 session-<uuid>）；
 *  同一目录覆盖 v0（session.jsonl[.zstd]）、vN（session.vN.jsonl[.zstd]）与未压缩明文，
 *  只保留物理代次最高的文件——低代次是高代次的迁移前缀，重复折叠会重复计数；
 *  同代次（v0 的压缩/明文两种写法）优先 zstd。非规范名（含 session.lock）一律忽略。 */
export function findSessionLogs(root: string, depth: number, out: Map<string, SessionLogFile>): void {
  if (depth > 3) return;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return; }
  const id = basename(root) || '';
  for (const entry of entries) {
    const p = join(root, entry);
    let st: unknown;
    try { st = statSync(p); } catch { continue; }
    if ((st as { isDirectory(): boolean }).isDirectory()) {
      findSessionLogs(p, depth + 1, out);
      continue;
    }
    const parsed = parseSessionLogName(entry);
    if (!parsed || !id) continue;
    const prev = out.get(id);
    // 择优：代次高者胜；同代次保留已选中的 zstd，不被后出现的明文覆盖。
    if (prev && (prev.generation > parsed.generation
      || (prev.generation === parsed.generation && prev.compression === 'zstd'))) continue;
    out.set(id, { path: p, generation: parsed.generation, compression: parsed.compression });
  }
}