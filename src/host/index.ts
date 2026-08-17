/**
 * 用量统计的服务端（Host）插件入口：装配 store → 实时监听 → 扫描 → 快照 API。
 *
 * 职责编排（拆分说明：本文件只做装配，逻辑在各模块）：
 *   - agg.ts      —— 聚合口径与纯函数（Agg / ink / usable / modelKeyOf）
 *   - logs.ts     —— 会话日志的目录发现与 NDJSON 解析
 *   - store.ts    —— UsageStore 结构与折叠助手
 *   - scan.ts     —— 扫描编排（persistence.readRaw 优先 + harness 兜底 +
 *                    并行 worker；zstd 解码走后端纯 JS 实现，无 CLI 依赖）
 *   - snapshot.ts —— 快照 value 构建
 *   - goquota.ts  —— OpenCode Go 订阅额度查询（滚动5h/周/月 + 缓存）
 *   - http.ts     —— JSON API 的 HTTP 辅助与回环围栏
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

import { usable, modelKeyOf, ink } from './agg.ts'
import { createStore, ensureSession, ensureModel, foldMeta, foldUsage } from './store.ts'
import { scanOnce } from './scan.ts'
import { snapshot } from './snapshot.ts'
import { queryGoQuota } from './goquota.ts'
import { readJsonBody, writeJson, writeOk, writeError, isLoopbackHost } from './http.ts'

export const name = 'dsh-usage-statistics'

/** 挂载前必需的服务（cordis fiber inject）。 */
export const inject = ['webServer', 'sessionQuery', 'sessionPersistence', 'timer']

/** 对外类型再导出（聚合结构定义在 agg.ts）。 */
export type { Agg, SessionInfo } from './agg.ts'

export function apply(ctx: Context): void {
  const store = createStore()

  // ---- 先挂实时监听（初始扫描期间不漏事件）----
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const id = session && typeof session.id === 'string' ? session.id : undefined
    if (!id) return
    foldMeta(store, id, event)
    if (!usable(event)) return
    const info = ensureSession(store, id)
    if (typeof event.seq === 'number' && event.seq <= info.maxSeq) { store.dedupSkipped += 1; return }
    foldUsage(store, info, event.time, event.data.usage)
    ink(ensureModel(store, modelKeyOf(event)), event.data.usage)
    store.foldedEvents += 1
    if (typeof event.seq === 'number') info.maxSeq = Math.max(info.maxSeq, event.seq)
  })

  scanOnce(ctx, store, { initial: true }).catch((e) => console.error('[usage-statistics] 初始扫描失败', e))

  // ---- 周期性自愈重扫（60s）----
  const timer = ctx.timer
  if (timer && typeof timer.interval === 'function') {
    timer.interval(() => {
      scanOnce(ctx, store, { initial: false }).catch((e) => console.error('[usage-statistics] 重扫失败', e))
    }, 60000)
  }

  // ---- JSON API 路由：POST /usage-stats/api/snapshot ----
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
            writeOk(res, snapshot(store, sessionId))
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