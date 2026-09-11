/**
 * 用量统计的服务端 Host 服务：账本模式装配，自管理 sqlite 介质，对外暴露
 * usageStats 命名空间的 7 个一元 Remote 方法。
 *
 * 数据流（账本为唯一事实来源、聚合为派生缓存）与原 apply 函数版一致：
 * 注册偏好设置命名空间 → openLedger → 先挂 session/event 实时监听 →
 * bootstrap（预统计快加载、事件重放、首启全量扫描三档回退）。信任与认证由
 * 网关载体统一处理，本服务只做业务：快照、重建、清零、密封、三路额度。
 *
 * 方法签名遵守严格 Remote 约定：公开非静态实例方法、非泛型、
 * 参数为具名必填简单标识符（无 lookup、无 signal），请求与结果均为
 * Client-safe 纯 JSON 类型（见 src/types.ts）。
 */

import { Service } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import { queryDeepSeekBalance } from './deepseekBalance.ts';
import { queryGoQuota } from './goquota.ts';
import { Ledger } from './ledger.ts';
import { scanOnce, rebuildFromEvents, rebuildWithDelta, resetStore, sealAggregates } from './scan.ts';
import { registerUsageSettings } from './settings.ts';
import { snapshot } from './snapshot.ts';
import { createStore, foldRecord, inheritedCountOf } from './store.ts';
import { queryZaiQuota } from './zaiQuota.ts';

// 仅类型导入：把注入服务合并进 Context、把 session/title 事件合并进
// SessionEventMap；协议类型集中 src/types.ts。
import type {
  ClearResult,
  DeepSeekBalance,
  GoQuota,
  QuotaRequest,
  RebuildResult,
  SealResult,
  SnapshotRequest,
  UsageSnapshot,
  ZaiQuota,
} from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-credentials';
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-session-title';

declare module '@deepseek-ai/cordis' {
  interface Context {
    usageStats: UsageStatsService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 写操作被并发的扫描/重建占用。 */
    'usageStats/busy': { readonly operation: string }
  }
}

/**
 * 取可选的凭据中心：不进 inject，直接 ctx.get 判空（官方可选服务写法）。
 * @param ctx - 服务所在上下文。
 * @returns 可用的凭据服务，缺席时为 undefined。
 */
function credentialsOf(ctx: Context): Context['credentials'] | undefined {
  const credentials = ctx.get('credentials');
  return typeof credentials?.resolve === 'function' ? credentials : undefined;
}

/** 打开/创建账本：版本不兼容或损坏时自动清库重建，保存与连接由 Ledger 负责。 */
function openLedger(): Ledger {
  const ledger = new Ledger();
  ledger.open();
  return ledger;
}

/** usageStats 命名空间的所有者：账本唯一持有者，冷操作不构造 Session。 */
export default class UsageStatsService extends TypertRemoteService {
  /**
   * 挂载前必需的服务（数组即全必需）。credentials 为可选：
   * 不进 inject，调用处经 ctx.get 判空，缺席时额度查询直接返回 no-key，
   * 仅走 DSH 凭据中心，不读 env 与文件。
   */
  static inject = ['sessionQuery', 'sessionPersistence'];

  private readonly store = createStore();
  private readonly ledger = openLedger();

  constructor(ctx: Context) {
    super(ctx, 'usageStats', { namespace: 'usageStats' });
  }

  protected [Service.init](): void {
    const ctx = this.ctx;
    const store = this.store;
    const ledger = this.ledger;

    // 偏好设置落 harness 用户设置文档（$DSH_HOME/settings.yaml），属部署而非某个浏览器。
    registerUsageSettings(ctx);

    // 插件卸载时关闭账本数据库连接，Ledger.close 幂等。
    ctx.effect(() => () => ledger.close(), 'dsh-usage-stats: 关闭账本数据库连接');

    // ---- 先挂实时监听，初始扫描期间不漏事件 ----
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const id = session && typeof session.id === 'string' ? session.id : undefined;
      if (!id) return;
      try {
        // 实时补齐会话 header 的 parentSession、origin、delegationDepth，子代理归属。
        // header 字段 cwd、createdAt、parentSession、origin、delegationDepth 均来自
        // harness 的 SessionHeader，AGENTS §0，直接复用，不手写字段形状。
        const hdr = (session as { header?: SessionHeader }).header;
        if (hdr) {
          const patch: Parameters<typeof ledger.setMeta>[1] = {};
          if (typeof hdr.parentSession === 'string') patch.parentSession = hdr.parentSession;
          if (hdr.origin === 'subagent') patch.origin = hdr.origin;
          if (typeof hdr.delegationDepth === 'number' && Number.isFinite(hdr.delegationDepth)) patch.delegationDepth = hdr.delegationDepth;
          if (typeof hdr.cwd === 'string') patch.cwd = hdr.cwd;
          if (typeof hdr.createdAt === 'number' && Number.isFinite(hdr.createdAt)) patch.createdAt = hdr.createdAt;
          if (Object.keys(patch).length > 0) ledger.setMeta(id, patch);
        }
        // fork 继承前缀属于父会话：seq 落在 inheritedEventCount 之前的事件不折，
        // 避免父的用量在子会话下重复计入（与扫描路径同口径）。
        if (typeof event.seq === 'number' && event.seq < inheritedCountOf((session as { inheritedEventCount?: unknown }).inheritedEventCount)) return;
        foldRecord(store, ledger, id, event);
      } catch (e) {
        // 写账本失败记日志，不打断事件循环；账本/内存保持上次成功点。
        console.error('[usage-stats] 实时事件入账失败', e);
      }
    });

    // ---- 初始化：优先从预统计加载，快速，回退到事件重放或全量扫描 ----
    const bootstrap = async (): Promise<void> => {
      // 1) 预统计快速路径：已物化 agg_* → 直接加载与少量增量重放，通常仅今日
      if (ledger.hasAggregates()) {
        const ok = rebuildWithDelta(store, ledger);
        if (ok) {
          store.scans += 1;
          store.lastScanAt = Date.now();
          return;
        }
      }
      // 2) 兼容旧库：有 events 但无预统计 → 全量重放并物化，一次迁移
      if (ledger.hasEvents()) {
        rebuildFromEvents(store, ledger);
        store.scans += 1;
        store.lastScanAt = Date.now();
        return;
      }
      // 3) 首启：无数据 → 全量扫描日志并物化
      await scanOnce(ctx, store, ledger, { initial: true });
    };
    void bootstrap().catch((e) => console.error('[usage-stats] 初始化失败', e));
  }

  /**
   * usageStats/snapshot：聚合快照，带会话过滤返回对应会话的 current。
   * @param request - 会话过滤与明细分页上限。
   * @returns 快照 value（传输信封由网关负责）。
   */
  @Remote('snapshot')
  snapshot(request: SnapshotRequest): UsageSnapshot {
    const raw = request.sessionId;
    const sessionId = typeof raw === 'string' && raw.length > 0 ? raw : null;
    const limit = typeof request.limit === 'number' && Number.isFinite(request.limit) ? request.limit : undefined;
    return snapshot(this.store, this.ledger, sessionId, limit !== undefined ? { limit } : undefined);
  }

  /**
   * usageStats/rebuild：清空账本 → 复位聚合缓存 → 全量重扫日志导入。
   * @returns 重建确认与折叠事件数；进行中返回 usageStats/busy。
   */
  @Remote('rebuild')
  async rebuild(): Promise<RebuildResult> {
    const store = this.store;
    // 并发保护：已有扫描/重建正在进行时拒绝，避免交错清库与扫描。
    if (store.running) {
      throw new RemoteError('usageStats/busy', 'rebuild already in progress', { operation: 'rebuild' });
    }
    store.running = true;
    try {
      this.ledger.clear();
      resetStore(store);
      // 持锁调用 scanOnce。
      await scanOnce(this.ctx, store, this.ledger, { initial: true, force: true });
    } finally {
      store.running = false;
      store.scanning = false;
    }
    return { rebuilt: true, foldedEvents: store.foldedEvents };
  }

  /**
   * usageStats/clear：清空账本 → 复位聚合缓存，不重扫，统计直接归零。
   * @returns 清零确认与折叠事件数；进行中返回 usageStats/busy。
   */
  @Remote('clear')
  async clear(): Promise<ClearResult> {
    const store = this.store;
    if (store.running) {
      throw new RemoteError('usageStats/busy', 'clear already in progress', { operation: 'clear' });
    }
    store.running = true;
    try {
      this.ledger.clear();
      resetStore(store);
    } finally {
      store.running = false;
    }
    return { cleared: true, foldedEvents: store.foldedEvents };
  }

  /**
   * usageStats/seal：手动物化当前聚合至预统计，密封不会再变动的历史数据。
   * @returns 密封确认、密封边界与折叠事件数；进行中返回 usageStats/busy。
   */
  @Remote('seal')
  seal(): SealResult {
    const store = this.store;
    if (store.running) {
      throw new RemoteError('usageStats/busy', 'seal already in progress', { operation: 'seal' });
    }
    sealAggregates(store, this.ledger);
    return { sealed: true, sealedUntil: this.ledger.getSealedUntil(), foldedEvents: store.foldedEvents };
  }

  /**
   * usageStats/goQuota：OpenCode Go 订阅额度，TTL 缓存 + 单飞。
   * @param request - 客户端抓取间隔与强制刷新。
   * @returns 额度 value（无 key 时为 no-key，不抛错）。
   */
  @Remote('goQuota')
  async goQuota(request: QuotaRequest): Promise<GoQuota> {
    const intervalMinutes = typeof request.intervalMinutes === 'number' && Number.isFinite(request.intervalMinutes)
      ? request.intervalMinutes
      : undefined;
    // force=true 概览 Go 磁贴"立即刷新"，绕过 TTL 缓存强制重新抓取；
    // 默认 false 保持轮询语义，有效 TTL 内返回缓存。
    const force = request.force === true;
    return queryGoQuota(intervalMinutes, force, credentialsOf(this.ctx));
  }

  /**
   * usageStats/deepseekBalance：DeepSeek 余额，TTL 缓存 + 单飞。
   * @param request - 客户端抓取间隔与强制刷新。
   * @returns 余额 value（无 key 时为 no-key，不抛错）。
   */
  @Remote('deepseekBalance')
  async deepseekBalance(request: QuotaRequest): Promise<DeepSeekBalance> {
    const intervalMinutes = typeof request.intervalMinutes === 'number' && Number.isFinite(request.intervalMinutes)
      ? request.intervalMinutes
      : undefined;
    // force=true 概览 DeepSeek 磁贴"立即刷新"，绕过 TTL 缓存强制重新抓取；
    // 默认 false 保持轮询语义，有效 TTL 内返回缓存，仍受 3 分钟强制下限保护。
    const force = request.force === true;
    // 凭据中心可选：缺席时查询侧直接返回 no-key，不读 env 与文件。
    return queryDeepSeekBalance(intervalMinutes, force, credentialsOf(this.ctx));
  }

  /**
   * usageStats/zaiQuota：Z.ai 智谱额度，TTL 缓存 + 单飞。
   * @param request - 客户端抓取间隔与强制刷新。
   * @returns 额度 value（无 key 时为 no-key，不抛错）。
   */
  @Remote('zaiQuota')
  async zaiQuota(request: QuotaRequest): Promise<ZaiQuota> {
    const intervalMinutes = typeof request.intervalMinutes === 'number' && Number.isFinite(request.intervalMinutes)
      ? request.intervalMinutes
      : undefined;
    // force=true 概览 Z.ai 磁贴"立即刷新"，绕过 TTL 缓存强制重新抓取；
    // 默认 false 保持轮询语义，有效 TTL 内返回缓存，仍受 3 分钟强制下限保护。
    const force = request.force === true;
    return queryZaiQuota(intervalMinutes, force, credentialsOf(this.ctx));
  }
}
