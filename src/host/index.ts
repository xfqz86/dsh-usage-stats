/**
 * 用量统计的服务端（Host）插件入口：账本模式装配（自管理 sqlite 介质）。
 *
 * 数据流（账本为唯一事实来源，聚合为派生缓存）：
 *   - 打开自管理 sqlite 账本（ledger.ts，`$DSH_HOME/storages/
 *     dsh-usage-stats/ledger.sqlite`）→ events / session_meta / agg_* 预统计表；
 *   - 首启/重建：扫描会话日志 → 经 foldRecord 写入账本（同步落盘）并折
 *     叠聚合缓存，批量物化预统计；
 *   - 实时：session/event 监听逐条入账本 + 折叠（seq 水位去重，与扫描共享
 *     foldRecord 路径，保证账本内事件唯一），并增量更新预统计；
 *   - 预统计加速：重启时优先从 agg_* 物化表加载聚合，仅重放少量未密封事件
 *     （通常仅今日），无需全量重放，显著降低冷启动时间；
 *   - 每次写入即写即持久（sqlite 自动提交），进程崩溃后重启从介质恢复，
 *     不需要周期性对账；
 *   - 快照 API 从聚合缓存 + 账本 meta 读取。
 * 账本 schema 版本不兼容时自动清库重建（下次启动全量重扫）。
 *
 * 职责编排：utils.ts（跨端共用纯函数与协议类型）/ agg.ts（口径）/
 * store.ts（聚合折叠）/ ledger.ts（自管理 sqlite 账本 + 预统计）/ scan.ts（日志导入
 * 与重建 + 预统计物化）/ snapshot.ts（快照构建）/ goquota.ts（Go 额度）/ http.ts（HTTP
 * 辅助与回环围栏）。
 *
 * 类型全部来自 harness 包（cordis Context 已合并注入服务表面）；运行时
 * 只 import node 内置模块 + 本地模块。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// 仅类型导入：把注入服务合并进 Context、把 session/title 事件合并进
// SessionEventMap。
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { createStore, foldRecord } from './store.ts'
import { scanOnce, rebuildFromEvents, rebuildWithDelta, resetStore, sealAggregates } from './scan.ts'
import { Ledger } from './ledger.ts'
import { snapshot } from './snapshot.ts'
import { queryGoQuota } from './goquota.ts'
import { readJsonBody, writeJson, writeOk, writeError, isLoopbackHost, hasUsageStatsHeader } from './http.ts'

export const name = '@xfqz86/dsh-usage-stats'

/** 挂载前必需的服务（cordis fiber inject）。 */
export const inject = ['webServer', 'sessionQuery', 'sessionPersistence']

/** 对外类型再导出（聚合结构定义在 agg.ts）。 */
export type { Agg, SessionInfo } from './agg.ts'

/** 打开/创建账本：版本不兼容或损坏时自动清库重建（保存/连接由 Ledger 负责）。 */
function openLedger(): Ledger {
  const ledger = new Ledger()
  ledger.open()
  return ledger
}

export function apply(ctx: Context): void {
  const store = createStore()
  const ledger = openLedger()

  // ---- 先挂实时监听（初始扫描期间不漏事件）----
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const id = session && typeof session.id === 'string' ? session.id : undefined
    if (!id) return
    try {
      foldRecord(store, ledger, id, event)
    } catch (e) {
      // 写账本失败记日志，不打断事件循环；账本/内存保持上次成功点。
      console.error('[usage-stats] 实时事件入账失败', e)
    }
  })

  // ---- 初始化：优先从预统计加载（快速），回退到事件重放或全量扫描 ----
  const bootstrap = async () => {
    // 1) 预统计快速路径：已物化 agg_* → 直接加载 + 少量增量重放（通常仅今日）
    if (ledger.hasAggregates()) {
      const ok = rebuildWithDelta(store, ledger)
      if (ok) {
        store.scans += 1
        store.lastScanAt = Date.now()
        return
      }
    }
    // 2) 兼容旧库：有 events 但无预统计 → 全量重放并物化（一次迁移）
    if (ledger.hasEvents()) {
      rebuildFromEvents(store, ledger)
      store.scans += 1
      store.lastScanAt = Date.now()
      return
    }
    // 3) 首启：无数据 → 全量扫描日志并物化
    await scanOnce(ctx, store, ledger, { initial: true })
  }
  void bootstrap().catch((e) => console.error('[usage-stats] 初始化失败', e))

  // ---- JSON API 路由：POST /usage-stats/api/* ----
  const webServer = ctx.webServer
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/usage-stats/api',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // 信任围栏：仅回环 Host 可调用（防 DNS 重绑定）。
        if (!isLoopbackHost(req.headers.host)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        // CSRF 围栏：回环之外再要求插件自定义头（浏览器跨站请求无法携带，
        // 缺失或不匹配拒绝，响应与非回环 403 同形）。
        if (!hasUsageStatsHeader(req.headers)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith('/usage-stats/api/')
          ? pathname.slice('/usage-stats/api/'.length)
          : undefined
        if (method === undefined || method.includes('/')) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知的 usage-stats API 方法' } })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: '方法不允许' } })
          return
        }
        try {
          const payload = await readJsonBody(req) as Record<string, unknown>
          if (method === 'snapshot') {
            const raw = payload.sessionId
            const sessionId = (typeof raw === 'string' && raw.length > 0) ? raw : null
            const rawLimit = (payload as { limit?: unknown; sessionsLimit?: unknown }).limit ?? (payload as { sessionsLimit?: unknown }).sessionsLimit
            const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : undefined
            writeOk(res, snapshot(store, ledger, sessionId, limit !== undefined ? { limit } : undefined))
            return
          }
          if (method === 'rebuild') {
            // 重建账本：清空 sqlite 事件与 meta（含预统计）→ 复位聚合缓存 → 重新扫描日志导入。
            // 并发保护：已有扫描/重建正在进行时返回 409，避免交错清库与扫描
            if (store.running) {
              writeJson(res, 409, { ok: false, error: { code: 'busy', message: 'rebuild already in progress' } })
              return
            }
            store.running = true
            try {
              ledger.clear()
              resetStore(store)
              // 持锁调用 scanOnce
              await scanOnce(ctx, store, ledger, { initial: true, force: true })
            } finally {
              store.running = false
              store.scanning = false
            }
            writeOk(res, { rebuilt: true, foldedEvents: store.foldedEvents })
            return
          }
          if (method === 'clear') {
            // 清零账本：清空 sqlite 事件与 meta（含预统计）→ 复位聚合缓存，不重扫（与重建的区别）。
            if (store.running) {
              writeJson(res, 409, { ok: false, error: { code: 'busy', message: 'clear already in progress' } })
              return
            }
            store.running = true
            try {
              ledger.clear()
              resetStore(store)
            } finally {
              store.running = false
            }
            writeOk(res, { cleared: true, foldedEvents: store.foldedEvents })
            return
          }
          if (method === 'seal') {
            // 手动密封：物化当前聚合至预统计（针对不会再变动的历史数据）。
            // 并发保护：与 rebuild/clear 一致，已有扫描/重建进行中返回 409
            if (store.running) {
              writeJson(res, 409, { ok: false, error: { code: 'busy', message: 'seal already in progress' } })
              return
            }
            sealAggregates(store, ledger)
            writeOk(res, { sealed: true, sealedUntil: ledger.getSealedUntil(), foldedEvents: store.foldedEvents })
            return
          }
          if (method === 'go-quota') {
            const raw = payload.intervalMinutes
            const intervalMinutes = (typeof raw === 'number' && Number.isFinite(raw)) ? raw : undefined
            // force=true（概览 Go 磁贴"立即刷新"）绕过 TTL 缓存强制重新抓取；
            // 默认 false 保持轮询语义（有效 TTL 内返回缓存）。
            const force = payload.force === true
            writeOk(res, await queryGoQuota(intervalMinutes, force))
            return
          }
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `未知的 usage-stats API 方法 "${method}"` } })
        } catch (error) {
          writeError(res, error)
        }
      },
    }), 'dsh-usage-stats: /usage-stats/api 路由')
  }
}
