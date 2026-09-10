/**
 * 会话原始日志的物理代次识别与多帧 zstd 解码：扫描拼接 zstd 帧边界后逐帧解压为
 * NDJSON 文本，供扫描链路在 harness 读取失败时兜底读取旧代次会话。
 *
 * 背景：harness 的 JSONL 会话日志是 append-only 的多帧 zstd 拼接（首帧独立承载会话头），
 * Node 的 zstdDecompressSync/createZstdDecompress 只解第一帧，因此必须自行扫描帧边界；
 * 帧结构（magic 0xFD2FB528、frame header descriptor、window descriptor、dict id、
 * frame content size、3 字节 block header 循环至 last block、可选 4 字节 checksum）在本模块
 * 自实现，不 import harness 内部包（@deepseek-ai/dsh-session-persistence-jsonl）。
 *
 * 本模块是纯函数模块：只接收内存字节、不做文件 I/O，单测不读取 ~/.dsh。
 */
import { constants, zstdDecompressSync } from 'node:zlib';

import { errorMessage } from '../utils.ts';

/** zstd 帧魔数：小端 0xFD2FB528。 */
const ZSTD_MAGIC = 0xFD2FB528;

/** 规范会话日志文件名：`session.jsonl`（v0）、`session.vN.jsonl`（N ≥ 1），可选 `.zstd` 压缩后缀。 */
const SESSION_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/** 会话日志的物理编码：`zstd` 压缩或 `none` 明文。
 *  与 harness 的内部类型 JsonlCompression 同形，但该类型只由内部包
 *  @deepseek-ai/dsh-session-persistence-jsonl 导出（本仓库不得 import），故就地声明。 */
export type SessionLogCompression = 'zstd' | 'none';

/** 会话日志文件名的解析结果：物理代次与物理编码。 */
export interface SessionLogName {
  generation: number
  compression: SessionLogCompression
}

/** 一帧在文件中的字节区间：start 含、end 不含。 */
export interface ZstdFrameRange {
  start: number
  end: number
}

/** 拼接 zstd 流的结构扫描结果：完整帧序列，以及 EOF 打断末帧时的起点 tornStart。 */
export interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  tornStart?: number
}

/**
 * 解析会话日志文件名，返回物理代次与物理编码，非规范名返回 null。
 * 规范与 harness 一致：v0 沿用 `session.jsonl`，vN（N ≥ 1）为 `session.vN.jsonl`；
 * 大写、前导零、`.v0`、临时后缀等非规范名一律不识别（含 `session.lock`）。
 */
export function parseSessionLogName(name: string): SessionLogName | null {
  const match = SESSION_LOG_NAME.exec(name);
  if (!match) return null;
  const generation = match[1] === undefined ? 0 : Number(match[1]);
  if (!Number.isSafeInteger(generation)) return null;
  return { generation, compression: match[2] === undefined ? 'none' : 'zstd' };
}

/**
 * 解析会话日志文件的物理代次号：`session.jsonl[.zstd]` 为 0、`session.vN.jsonl[.zstd]` 为 N；
 * 非会话日志文件返回 -1。
 */
export function parseGenerationName(name: string): number {
  const parsed = parseSessionLogName(name);
  return parsed ? parsed.generation : -1;
}

/**
 * 结构扫描拼接 zstd 流，只定位帧边界、不解压 block：
 * EOF 落在末帧内部时返回其起点 tornStart；结构非法（坏 magic、保留 header 位、保留 block 类型）抛错。
 * @param buffer - 会话日志文件的完整字节。
 * @param maxFrames - 可选的完整帧数上限，仅供只看元数据的读取方提前返回。
 * @returns 完整帧区间序列与可选的不完整尾帧起点。
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    let contentSizeBytes = 0;
    if (contentSizeFlag === 0) contentSizeBytes = singleSegment ? 1 : 0;
    else contentSizeBytes = 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }

  return { frames };
}

/**
 * 解码一个会话日志为 NDJSON 文本：
 * - `none`：按 UTF-8 原样返回；
 * - `zstd`：逐帧解压后拼接；不完整尾帧按 harness 语义恢复可用前缀并截断到最后一个换行，
 *   无法恢复（坏帧、无完整行）则丢弃该尾帧。
 * 结构非法与完整帧校验失败抛出错误，由调用方计入失败会话；空文件返回空串。
 */
export function decodeSessionLog(buffer: Buffer, compression: SessionLogCompression): string {
  if (compression === 'none') return buffer.toString('utf8');
  const { frames, tornStart } = scanZstdFrames(buffer);
  const parts: string[] = [];
  for (const { start, end } of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
    } catch (e) {
      throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation: ${errorMessage(e)}`);
    }
  }
  if (tornStart !== undefined) {
    const recovered = recoverTornFrame(buffer.subarray(tornStart));
    if (recovered) parts.push(recovered);
  }
  return parts.join('');
}

/**
 * 恢复不完整尾帧的可用明文：以 ZSTD_e_flush 抑制帧结束标记与校验，只保留最后一个换行
 * 之前的完整记录（与 harness 迁移读取一致）；无法恢复返回空串。
 */
function recoverTornFrame(bytes: Buffer): string {
  let recovered: Buffer;
  try {
    recovered = zstdDecompressSync(bytes, { finishFlush: constants.ZSTD_e_flush });
  } catch {
    return '';
  }
  const text = recovered.toString('utf8');
  const newline = text.lastIndexOf('\n');
  return newline === -1 ? '' : text.slice(0, newline + 1);
}
