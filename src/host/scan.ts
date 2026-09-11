/**
 * 会话扫描编排，账本导入：把磁盘原始日志 ∪ harness 会话清单的会话 id
 * 全集逐会话读取，经 foldRecord 写入账本（events、session_meta 共 9 表，
 * 含 agg_* 预统计）并折叠聚合缓存。harness 读取经 sessionQuery.readSession、
 * persistence.open+read 实现；两路都被拒绝（如旧代次会话的
 * SessionFormatUnsupportedError）或返回空事件时，回退用 rawlog 自读磁盘最高
 * 代次日志兜底，使被迁移拒绝的旧会话仍纳入统计；4 路 worker 并行。
 *
 * 语义：只在账本需要初始化，首启无事件或显式重建时运行；平时数据来自
 * 实时 session/event 监听，每次写入同步落盘，无需周期性对账。
 * 预统计：批量导入期间挂起逐条物化，完成后一次 bulk 物化 agg_* 表，
 * 后续启动可直接从预统计加载，仅重放少量未密封事件，显著加速冷启动。
 * 扫描报告，rawSessions（raw 兜底命中）、harnessSessions（harness 命中）、
 * failed 记录最近一次导入结果。
 */
import { readFileSync } from 'node:fs';

import { errorMessage, startOfDay  } from '../utils.ts';

import { newAgg } from './agg.ts';
import { findSessionLogs, getSessionsRoot, parseLogLines } from './logs.ts';
import { decodeSessionLog } from './rawlog.ts';
import { foldLedgerEvent, foldRecord, inheritedCountOf, inheritedPrefixOf, liveEventsOf } from './store.ts';

import type { Ledger } from './ledger.ts';
import type { SessionLogFile } from './logs.ts';
import type { UsageStore } from './store.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';




/** 扫描并发 worker 数：IO 等待为主，4 路并行兼顾吞吐与 sqlite 写竞争。 */
const SCAN_WORKERS = 4;

/** 复位聚合缓存，重建账本前调用：清空会话/模型/全量/日桶与去重水位与计数。 */
export function resetStore(store: UsageStore): void {
  store.sessions.clear();
  store.models.clear();
  store.modelDaily.clear();
  store.allAgg = newAgg();
  store.allDaily.clear();
  store.foldedEvents = 0;
  store.dedupSkipped = 0;
  store.rawSessions = 0;
  store.harnessSessions = 0;
  store.failed = 0;
  store.lastError = null;
  store.scanError = null;
}

/** 会话 id 截断展示，取前 12 字符。 */
const shortOf = (id: string): string =>
  typeof id === 'string' && id.length > 12 ? id.slice(0, 12) + '…' : String(id);

/**
 * 尝试从预统计物化表加载聚合，属于快速启动路径。
 * 成功返回 true，已填充 store，无预统计返回 false，调用方需回退到事件重放或扫描。
 */
export function tryLoadAggregates(store: UsageStore, ledger: Ledger): boolean {
  if (!ledger.hasAggregates()) return false;
  const ok = ledger.loadAggregates(store);
  if (ok) {
    // 预统计已包含会话的 maxSeq 与 lastActive，去重水位已恢复，实时路径可直接去重
    store.dedupSkipped = 0;
  }
  return ok;
}

/**
 * 密封历史预统计：将当前内存聚合全量物化至 DB，并将密封边界推进至今日零点。
 * 供显式 seal 调用；scanOnce 仅在有扫描且有折叠事件时调用。
 */
export function sealAggregates(store: UsageStore, ledger: Ledger): void {
  try {
    ledger.persistAggregates(store);
  } catch (e) {
    console.error('[usage-stats] 物化预统计失败', e);
    return;
  }
  try {
    ledger.sealUntil(startOfDay(Date.now()));
  } catch {}
}

/** 扫描一轮全部会话并将其写入账本，初始与重建共用，防重入由 store.running 保证（force 持锁重入除外）。
 *  整轮无失败会话时清除历史错误标记，自愈，日志可读性恢复后自动消失。
 *  批量导入期间挂起逐条物化，完成后一次 bulk 物化，兼顾写入吞吐与启动加速。 */
export async function scanOnce(
  ctx: Context,
  store: UsageStore,
  ledger: Ledger,
  options: { initial?: boolean; force?: boolean },
): Promise<void> {
  const initial = !!(options?.initial);
  const force = !!(options?.force);
  // 防重入：扫描永不重叠，force 允许持锁重入。
  if (store.running && !force) return;
  if (initial) store.scanning = true;
  store.running = true;
  store.scans += 1;
  store.lastScanAt = Date.now();
  // 每轮扫描独立计数；整轮成功则清除历史错误标记。
  store.failed = 0;
  store.rawSessions = 0;
  store.harnessSessions = 0;
  // 挂起逐条预统计，批量阶段仅写 events 表，最后统一物化
  const prevSuspend = ledger.isAggSuspended();
  ledger.setAggSuspended(true);
  let didScan = false;
  try {
    const query = ctx.sessionQuery;
    const persist = ctx.sessionPersistence;

    // 1) 会话 id 全集 = 磁盘原始日志 ∪ harness 会话清单；同时收集 header 的 cwd/createdAt/parentSession/origin/delegationDepth 以便在无 RAW 时仍能填充 session_meta。
    const logPaths = new Map<string, SessionLogFile>();
    findSessionLogs(getSessionsRoot(), 0, logPaths);
    const ids = new Set<string>(logPaths.keys());
    const headerMap = new Map<string, { cwd?: string; createdAt?: number; parentSession?: string; origin?: string; delegationDepth?: number }>();

    if (query) {
      try {
        const listed = await query.listSessions();
        if (Array.isArray(listed)) {
          for (const rec of listed) {
            if (rec.header && typeof rec.header.id === 'string') {
              ids.add(rec.header.id);
              const h = rec.header as { cwd?: unknown; createdAt?: unknown; parentSession?: unknown; origin?: unknown; delegationDepth?: unknown };
              if (typeof h.cwd === 'string' || typeof h.createdAt === 'number' || typeof h.parentSession === 'string' || typeof h.origin === 'string' || typeof h.delegationDepth === 'number') {
                headerMap.set(rec.header.id, {
                  cwd: typeof h.cwd === 'string' ? h.cwd : undefined,
                  createdAt: typeof h.createdAt === 'number' ? h.createdAt : undefined,
                  parentSession: typeof h.parentSession === 'string' ? h.parentSession : undefined,
                  origin: typeof h.origin === 'string' ? h.origin : undefined,
                  delegationDepth: typeof h.delegationDepth === 'number' ? h.delegationDepth : undefined,
                });
              }
            }
          }
        }
      } catch (e) {
        store.scanError = 'listSessions: ' + errorMessage(e);
      }
    }
    if (persist) {
      try {
        const snapshots = await persist.list();
        if (Array.isArray(snapshots)) {
          for (const snap of snapshots) {
            // 新基座 list 返回快照（id 嵌于 .header），兼容旧直 header 形态。
            const header = (snap as { header?: unknown }).header ?? snap;
            if (header && typeof (header as { id?: unknown }).id === 'string') {
              const hid = (header as { id: string }).id;
              ids.add(hid);
              const h = header as { cwd?: unknown; createdAt?: unknown; parentSession?: unknown; origin?: unknown; delegationDepth?: unknown };
              if (typeof h.cwd === 'string' || typeof h.createdAt === 'number' || typeof h.parentSession === 'string' || typeof h.origin === 'string' || typeof h.delegationDepth === 'number') {
                if (!headerMap.has(hid)) {
                  headerMap.set(hid, {
                    cwd: typeof h.cwd === 'string' ? h.cwd : undefined,
                    createdAt: typeof h.createdAt === 'number' ? h.createdAt : undefined,
                    parentSession: typeof h.parentSession === 'string' ? h.parentSession : undefined,
                    origin: typeof h.origin === 'string' ? h.origin : undefined,
                    delegationDepth: typeof h.delegationDepth === 'number' ? h.delegationDepth : undefined,
                  });
                }
              }
            }
          }
          if (snapshots.length > 0) store.scanError = null;
        }
      } catch (e) {
        store.scanError = 'persistence.list: ' + errorMessage(e);
      }
    }
    const idList: string[] = [...ids];

    // 2) 逐会话：harness 读取经 sessionQuery.readSession / persistence.open+read 实现，
    //    两路失败或空事件时回退 rawlog 自读磁盘最高代次日志兜底（旧代次会话）。
    //    对于无原文可读的会话，用 headerMap 的 cwd/createdAt 预填充 session_meta，避免 cwd/created_at/last_active 为空。
    //    worker 取号 `idList[i]; i+=1` 在同步段内完成，await 之前无交错，单线程下无竞态，可安全 4 路并行。
    let i = 0;
    async function worker(): Promise<void> {
      while (i < idList.length) {
        const id = idList[i]; i += 1;
        // 预填充 header 元数据，若有则填充，保证即使无 seed 记录时也不为空
        const hdr = headerMap.get(id);
        if (hdr && (hdr.cwd !== undefined || hdr.createdAt !== undefined || hdr.parentSession !== undefined
          || hdr.origin !== undefined || hdr.delegationDepth !== undefined)) {
          ledger.setMeta(id, {
            cwd: hdr.cwd,
            createdAt: hdr.createdAt,
            lastActive: hdr.createdAt,
            parentSession: hdr.parentSession,
            origin: hdr.origin,
            delegationDepth: hdr.delegationDepth,
          });
        }
        try {
          // harness 读取：sessionQuery.readSession / persistence.open+read（读句柄用后关闭）。
          // 两路都按 inheritedEventCount 丢掉 fork 继承前缀：子会话日志物理包含父会话历史，
          // 重复折入会把父的用量在子会话下再算一遍。
          let events: readonly SessionEvent[] | null = null;
          if (query) {
            try {
              const snap = await query.readSession(id as SessionId);
              if (snap && Array.isArray(snap.events)) {
                events = liveEventsOf(snap.events, inheritedCountOf(snap.inheritedEventCount));
              }
            } catch (e) {
              store.lastError = 'readSession ' + shortOf(id) + ': ' + errorMessage(e);
              events = null;
            }
          }
          if (events === null && persist) {
            let handle: SessionHandle | null = null;
            try {
              handle = await persist.open(id as SessionId, 'read');
              const r = await handle.read(0);
              events = r && Array.isArray(r.events)
                ? liveEventsOf(r.events, inheritedCountOf(handle.inheritedEventCount))
                : [];
            } catch (e) {
              store.lastError = 'persistence.read ' + shortOf(id) + ': ' + errorMessage(e);
              events = null;
            } finally {
              if (handle) {
                try { await handle.close(); } catch {}
              }
            }
          }
          let folded = false;
          if (events && events.length) {
            for (const event of events) {
              try { foldRecord(store, ledger, id, event); } catch (e) {
                store.lastError = 'record ' + shortOf(id) + ': ' + errorMessage(e);
              }
            }
            store.harnessSessions += 1;
            didScan = true;
            folded = true;
          }
          // raw 兜底：harness 两路都拒绝（旧代次会话的 SessionFormatUnsupportedError）
          // 或返回空事件时，自读磁盘最高代次日志（多帧 zstd 由 rawlog 逐帧解码）逐记录折叠。
          // 仅在上方未折入任何事件时执行，两路互斥；同 seq 另有账本主键与水位幂等兜底。
          if (!folded) {
            const log = logPaths.get(id);
            if (log) {
              try {
                const records = parseLogLines(decodeSessionLog(readFileSync(log.path), log.compression));
                // 原始日志无 harness 元数据，按 session/end-seed 的 inherited 标记求继承前缀。
                const live = liveEventsOf(records, inheritedPrefixOf(records));
                if (live.length > 0) {
                  for (const record of live) {
                    try { foldRecord(store, ledger, id, record); } catch (e) {
                      store.lastError = 'record ' + shortOf(id) + ': ' + errorMessage(e);
                    }
                  }
                  store.rawSessions += 1;
                  didScan = true;
                  folded = true;
                }
              } catch (e) {
                store.lastError = 'raw ' + shortOf(id) + ': ' + errorMessage(e);
              }
            }
          }
          // 只有两路 harness 读取都报错且 raw 兜底也拿不到记录才算失败；空会话，events 为空数组时不算。
          if (!folded && events === null) {
            store.failed += 1;
          }
        } catch (e) {
          store.lastError = 'session ' + shortOf(id) + ': ' + errorMessage(e);
          store.failed += 1;
        }
      }
    }

    const n = Math.max(1, Math.min(SCAN_WORKERS, idList.length || 1));
    const workers: Promise<void>[] = [];
    for (let k = 0; k < n; k += 1) workers.push(worker());
    await Promise.all(workers.map((w) => w.catch((e) => { store.lastError = 'worker: ' + errorMessage(e); store.failed += 1; })));
    didScan = didScan || idList.length > 0;
  } finally {
    // 批量物化时保持挂起，避免与实时增量竞争；物化完成后再恢复
    if (didScan && store.foldedEvents > 0) {
      try {
        sealAggregates(store, ledger);
      } catch {}
    }
    ledger.setAggSuspended(prevSuspend);
    // 整轮无失败会话则清除历史错误标记，自愈，日志可读性恢复后自动消失。
    if (store.failed === 0) { store.lastError = null; store.scanError = null; }
    if (initial) store.scanning = false;
    store.running = false;
  }
}

/** 从账本事件流重建聚合缓存，启动加载账本已有事件时用，元数据已在 ledger。
 *  清空现有聚合后按事件流全量重折；seq>=0 的 maxSeq 水位在 foldLedgerEvent 内重建，seq=-1 靠主键与 lastActive，
 *  实时路径随后可对历史事件去重。
 *  批量重建期间挂起逐条预统计，结束后统一物化以加速后续启动。 */
export function rebuildFromEvents(store: UsageStore, ledger: Ledger): void {
  const prev = ledger.isAggSuspended();
  ledger.setAggSuspended(true);
  try {
    store.sessions.clear();
    store.models.clear();
    store.modelDaily.clear();
    store.allAgg = newAgg();
    store.allDaily.clear();
    store.foldedEvents = 0;
    store.dedupSkipped = 0;
    for (const ev of ledger.allEvents()) foldLedgerEvent(store, ev);
    // 重建后物化预统计，供下次快速启动，保持挂起期间完成 bulk
    if (store.foldedEvents > 0) {
      try { sealAggregates(store, ledger); } catch {}
    }
  } finally {
    ledger.setAggSuspended(prev);
  }
}

/**
 * 增量重建：优先从预统计加载聚合，sealedUntil>0 时对边界之后的账本事件按
 * 会话水位比对补齐（调用方过滤，fold 本身不去重），补齐后推进密封边界。
 *
 * 对账必须无条件执行，不设跨日前置条件：实时路径 ledger.append 与
 * incrementAgg 是两个独立提交，中间崩溃会在 events 表留下「已入账但聚合
 * 缺失」的事件。启动时始终
 * 重放 sealedUntil 之后的窗口，即上次密封以来的增量，量级约为当日事件数，
 * 水位之下的事件一律跳过 —— 重复调用不翻倍，rebuildFromEvents 路径不受影响。
 * 不变量与已知限制：密封边界之前维持「events 存在 ⇒ 聚合已收」；若进程恰在
 * 同会话 append 与 incrementAgg 两条同步语句之间崩溃、且该会话水位已被后续
 * 事件推进，水位补齐无法覆盖该事件，需 rebuild 全量重折修复，窗口极窄，
 * 实际可忽略。
 */
export function rebuildWithDelta(store: UsageStore, ledger: Ledger): boolean {
  // 优先尝试预统计快速路径：直接从物化表加载，跳过全量事件重放
  if (tryLoadAggregates(store, ledger)) {
    // 无条件对账密封边界外的增量事件并按水位补齐
    const sealedUntil = ledger.getSealedUntil();
    if (sealedUntil > 0) {
      const delta = ledger.allEventsSince(sealedUntil);
      if (delta.length > 0) {
        // 按会话水位对比，增量补齐缺失事件，含实时写入的崩溃窗口
        const missing: typeof delta = [];
        for (const ev of delta) {
          const info = store.sessions.get(ev.sessionId);
          if (!info) {
            missing.push(ev);
            continue;
          }
          if (ev.seq >= 0) {
            if (ev.seq > info.maxSeq) missing.push(ev);
          } else {
            // seq=-1 无法靠水位，用 lastActive 判定
            if (ev.t > info.lastActive) missing.push(ev);
          }
        }
        for (const ev of missing) foldLedgerEvent(store, ev, ledger);
      }
      // 补齐后推进密封边界至今日零点；单调推进，不回退已核对边界。
      try { ledger.sealUntil(Math.max(sealedUntil, startOfDay(Date.now()))); } catch {}
    }
    return true;
  }
  return false;
}
