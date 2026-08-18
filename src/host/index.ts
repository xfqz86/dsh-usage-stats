/**
 * 用量统计的服务端（Host）插件入口：账本模式装配。
 *
 * 数据流（账本为唯一事实来源，聚合为派生缓存）：
 *   - 首启/重建：扫描会话日志 → 写入事件流账本（ledger）→ 折叠聚合缓存；
 *   - 实时：session/event 监听逐条入账本 + 折叠（seq 水位去重，与扫描共享
 *     foldRecord 路径，保证账本内事件唯一）；
 *   - 60s 对账：把账本新增行增量折叠（进程崩溃丢内存增量后自愈），
 *     取代旧版的周期性全量重扫；
 *   - 快照 API 从聚合缓存 + 账本 meta 读取。
 * 账本版本不兼容时自动清空重建（账本结构升级的安全网）。
 *
 * 职责编排：agg.ts（口径）/ store.ts（聚合折叠）/ ledger.ts（账本存储）/
 * scan.ts（日志导入与重建）/ snapshot.ts（快照构建）/ goquota.ts（Go 额度）/
 * http.ts（HTTP 辅助与回环围栏）。
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
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { createStore, foldRecord } from './store.ts'
import { scanOnce, rebuildFromEvents, reconcileNewEvents, resetStore } from './scan.ts'
import { Ledger, LEDGER_VERSION } from './ledger.ts'
import { snapshot } from './snapshot.ts'
import { queryGoQuota } from './goquota.ts'
import { readJsonBody, writeJson, writeOk, writeError, isLoopbackHost } from './http.ts'

export const name = 'dsh-usage-statistics'

/** 挂载前必需的服务（cordis fiber inject）。 */
export const inject = ['webServer', 'sessionQuery', 'sessionPersistence', 'timer']

/** 对外类型再导出（聚合结构定义在 agg.ts）。 */
export type { Agg, SessionInfo } from './agg.ts'

/** 实时监听与扫描共享的折叠入口：把会话事件记入账本并折叠聚合。 */
function handleLiveEvent(store: ReturnType<typeof createStore>, ledger: Ledger, session: Session, event: SessionEvent): void {
  const id = session && typeof session.id === 'string' ? session.id : undefined
  if (!id) return
  foldRecord(store, ledger, id, event)
}

/** 打开/创建账本：版本不兼容或损坏时自动重建（清空 + 重新导入）。 */
function openLedger(): Ledger {
  const ledger = new Ledger()
  const version = ledger.open()
  if (version !== 0 && version !== LEDGER_VERSION) {
    console.warn(`[usage-statistics] 账本版本 ${String(version)} 不受支持，自动重建`)
    ledger.clear()
    ledger.open()
  }
  return ledger
}

export function apply(ctx: Context): void {
  const store = createStore()
  const ledger = openLedger()

  // ---- 先挂实时监听（初始扫描期间不漏事件）----
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    handleLiveEvent(store, ledger, session, event)
  })

  // ---- 初始化：账本无事件 → 扫描历史会话日志导入；有事件 → 直接重建聚合 ----
  const bootstrap = async () => {
    if (ledger.hasEvents()) {
      // 重启场景：账本已存在，从事件流重建聚合缓存（无需重扫日志）。
      rebuildFromEvents(store, ledger)
      store.scans += 1
      store.lastScanAt = Date.now()
      return
    }
    // 首启场景：全量扫描日志写入账本并折叠聚合。
    await scanOnce(ctx, store, ledger, { initial: true })
  }
  bootstrap().catch((e) => console.error('[usage-statistics] 初始化失败', e))

  // ---- 周期性对账（60s）：把账本新增行增量折叠，替代旧版全量重扫 ----
  const timer = ctx.timer
  if (timer && typeof timer.interval === 'function') {
    timer.interval(() => {
      try {
        reconcileNewEvents(store, ledger)
      } catch (e) {
        console.error('[usage-statistics] 对账失败', e)
      }
    }, 60000)
  }

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
            writeOk(res, snapshot(store, ledger, sessionId))
            return
          }
          if (method === 'rebuild') {
            // 重建账本：清空事件流与 meta → 复位聚合缓存与水位 → 重新扫描日志导入。
            ledger.clear()
            resetStore(store)
            await scanOnce(ctx, store, ledger, { initial: true })
            writeOk(res, { rebuilt: true, foldedEvents: store.foldedEvents })
            return
          }
          if (method === 'go-quota') {
            writeOk(res, await queryGoQuota())
            return
          }
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `未知的 usage-stats API 方法 "${method}"` } })
        } catch (error) {
          writeError(res, error)
        }
      },
    }), 'dsh-usage-statistics: /usage-stats/api 路由')
  }
}