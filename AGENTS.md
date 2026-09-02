# dsh-usage-stats 开发规范（AGENTS.md）

本文件约束本仓库全部开发，任何 agent/协作者必须遵守；不可删除。用户侧说明见 `README.md`；本机私有与强时效内容见 `AGENTS.local.md`（不入库，`.gitignore` 排除，dsh 自动注入）。

## 0. 红线：类型必须复用 deepseek-harness，禁止手写镜像

harness 每个包已导出完整精确的类型（`Context`/`ClientContext`/`SessionEvent`/`TokenUsage`/`PropsRuntime`/`InjectFace`/`Modal` 等），**禁止**为 `ctx/slots/locale/session/primitives/注入服务` 手写结构、最小接口或 ambient 镜像；**必须** `import type` harness 导出，用法与 `packages/extensions/ui-cordis` 等一致。

实现：`@deepseek-ai/*` 已发布至 npm（版本对齐见 `AGENTS.local.md`），`devDependencies` 直接安装，无 `paths` 映射；`import type` 打包剥离，运行时值（`react/primitives`）走 `tsdown external` 冻结表。`package.json` 仅 `devDependencies`，服务端只引 Node 内置+本地，浏览器端只 `require` 冻结表模块。

服务端范式：
```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'        // ctx.webServer
import type {} from '@deepseek-ai/dsh-session-query'         // ctx.sessionQuery
export function apply(ctx: Context): void { /* 直接 ctx.webServer，无 ctx.get */ }
```
浏览器端范式：
```ts
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'       // PropsLocale/PropsRuntime + ctx.slots
import { Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
export type Props = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'dsh-usage-stats'>
export function apply(ctx: ClientContext): void {
  ctx.locale.register(NS, { zh, en })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({...}, props => <Comp {...props} />))
}
```
文案字典按 `ui-cordis` 范式：`NS + zh satisfies Record<string,string> + UsageStatsKey=keyof typeof zh + declare module LocaleNamespaceMap + en satisfies Record<UsageStatsKey,string>`，`t('key')` 全量校验。

## 1. 术语
- 统一 **服务端（Host）/浏览器端（Client）**，对应 `dsh-host-*`/`dsh-client-*`，禁用“宿主半/客户端半”。
- Host=`lib/index.js`（Node cordis 插件）；Client=`lib/client.js`（经 `dsh.client` 注入的浏览器 bundle）。

## 2. 项目形态与部署
- 标准 cordis 组合包：`package.json` 声明 `dsh.bundle.patch=./cordis.patch.yml` 与 `dsh.client.inject/platform + exports./client`。
- 无 `install.sh`/`dsh.plugin.json` 旁路；安装 `dsh plugin --profile web add "link:<路径>"`，卸载 `dsh plugin --profile web remove <name>`。
- `link:` 指向本仓库；`pnpm build` 后浏览器刷新即生效（服务端需重启 dsh）。`cordis.patch.yml` 仅一条 `usage-stats` 插入，不挂 `storage` 后端、不覆 `storage-domain`（账本自管理，见 §5）。

## 3. 代码规范
- **不使用 `any`**；`ctx` 用 harness 类型，业务数据用明确接口；类型仅定义 harness 未提供的（如 `UsageSnapshot`）。
- **风格与检查**：遵循 **Google TypeScript Style Guide**；`eslint.config.mjs`（flat config，`eslint 9 + typescript-eslint 8 + eslint-plugin-import-x + @stylistic`，分 `host/client/scripts` 三类 overrides）为唯一事实来源；新增代码须 `npx eslint .` 零 `errors`。
- 纯逻辑置于无 React 模块（`src/utils.ts`/`src/host/agg.ts`/`src/client/stats.ts`）便于测试。
- **tsx 一组件一文件**（如 `OverviewTab/DatesTab/SessionsTab` 各独立）；**协议类型集中 `src/types.ts`**（零运行时，host/client 各自 re-export），`src/utils.ts` 仅纯函数。
- **样式用 CSS Modules**（`*.module.css` + `import css`），与 `ui-sidebar/primitives` 一致；颜色一律 `var(--dsw-alias-*)`；禁止字符串 CSS。独立 bundle 由 `scripts/css-modules-inline.mjs`（lightningcss）编译内联为 `<style data-plugin-css>`。
- **组件归属**：可复用通用组件归 `src/client/components`，`src/client/views` 仅 Tab 级视图。
- **注释中文**，标识符/类型/错误消息英文；文档中文。

## 4. 项目结构
目录与职责见 `docs/STRUCTURE.md`（`pnpm tree` 生成，勿手改）。入口：`src/host/index.ts`（Host）、`src/client/index.ts`（Client）；共用 `src/types.ts`（类型）、`src/utils.ts`（纯函数）。各文件职责以头部注释为准。

## 5. 架构：自管理 SQLite 账本 + 派生聚合缓存

**原则：账本（Ledger）唯一事实来源，聚合（UsageStore）只读派生。**

存储直接 `node:sqlite:DatabaseSync`（Node≥22 同步 API），落盘 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`（`DSH_HOME` 默认 `~/.dsh`，`logs.ts` 解析；测试注入 `DSH_HOME` 隔离）。

**九表**（同库事务，同步读写，即写即持久）：
- **events**：`(t, session_id, seq, provider, model, input/output/cache_read/cache_write/reasoning)`，`PK(t,session_id,seq)` 天然幂等 `ON CONFLICT DO UPDATE`；`t` 缺失时当天确定性毫秒偏移。约束：TEXT 禁 `\0`，内存键 `provider\0model` 写时 `splitModelKey` 拆列，标题/cwd 等先 `sanitizeSqlText`（`\0→\uFFFD`）。
- **session_meta**：`(session_id PK, title, cwd, created_at, last_active, parent_session, origin, delegation_depth)`，初始化抄录、运行时由 `session/title` 与 `session/event` 头补齐，内存 `metaCache` 供快照；`user_version 3→4`增量补三列。
- **agg_***：`agg_total/agg_daily/agg_model/agg_model_daily/agg_session/agg_session_daily/agg_checkpoint` 预统计物化视图，批量扫描 `aggSuspended` 挂起、结束 `persistAggregates` 一次物化并 `sealUntil(今日零点)`。
- **版本**：`PRAGMA user_version=LEDGER_VERSION=4`；仅 `2→3/3→4` 增量保留数据，其余 `DROP` 重建（空表触发全量重扫）。

**数据流**：
1. **openLedger**：建目录/表、迁移、载入 meta、预编译 `LedgerStatements`。
2. **scanOnce**：会话 id 全集=磁盘 `findSessionLogs(深度≤3)` ∪ harness 清单；4 路 worker，优先 `persistence.readRaw`（纯 JS zstd），回退 `sessionQuery.readSession`；经 `foldRecord` 共用路径，`running` 防重入。
3. **实时增量**：`ctx.on('session/event')` → `foldRecord` → `foldLedgerEvent` + `incrementAgg`，按 `maxSeq` 去重（`seq=-1` 按 PK 存在性），补齐 `parentSession/origin/depth/cwd/createdAt`。
4. **重启恢复**：`bootstrap()` 优先 `hasAggregates→rebuildWithDelta`（加载 `agg_*` + 补 `sealedUntil` 后增量），其次 `hasEvents→rebuildFromEvents`，否则全量扫描；日志删除仍可从介质恢复。
5. **重建**：`POST /usage-stats/api/rebuild` → `ledger.clear()`+`resetStore`+`scanOnce`；`clear` 仅清库，`seal` 手动物化。

**折叠语义**：`foldRecord` 处理种子/`title`/`usable(data.usage存在)` 事件，按水位去重后 `append`+`foldLedgerEvent` 折入日桶/总桶/模型并更新 `maxSeq/lastActive`；`foldLedgerEvent` 归一非有限/负数→0，若传 `ledger` 则同步 `incrementAgg`（失败仅 `lastError`）。

## 6. 统计口径
- 数据源：`assistant/message` 且 `data.usage` 存在（`toLedgerEvent` 非有限/负数→0）。
- `total=input+output+cacheRead+cacheWrite`，`reasoning` 单列。
- 按模型：`data.message.source.provider/model`，缺失 `unknown`。
- 按会话：标题/`cwd`/创建时间/最近活跃。
- 本地日划分：`startOfDay`（`utils.ts` 唯一来源，避免 UTC 漂移）。

## 7. 构建（tsdown 双 bundle + CSS 内联）
- `lib/index.js`（Host, Node ESM，`@xfqz86/dsh-usage-stats`）：仅 Node 内置+本地，DSH 服务 cordis 注入。
- `lib/client.js`（Browser CJS 闭包 `window.__ModuleLoader__.load({id,factory})`）：`externals` 复刻冻结表（`react/primitives/slots` 等），其余内联；非 `production` 保留 sourcemap。
- CSS：`scripts/css-modules-inline.mjs`（lightningcss `cssModules`）将 `*.module.css` 编译为 scoped 映射+`<style data-plugin-css>` 注入（源码仍真实 CSS Modules）。

## 8. 运行时与 JSON API
- **注入**：`inject={webServer,sessionQuery,sessionPersistence:必需, credentials:可选}`；先挂实时监听再 `bootstrap`。
- **路由**：`ctx.webServer.register({kind:'prefix', path:'/usage-stats/api', handler})` 仅 `POST`，先回环围栏（防 DNS 重绑定）+ CSRF 自定义头围栏。
- 协议细节（`snapshot/go-quota/deepseek-balance/rebuild/clear/seal`、TTL、偏好字段）见 `docs/API.md`。

## 9. 验证（每次改动必须）
```bash
npx tsc --noEmit
npx eslint .              # 0 errors 为门禁
pnpm build
node test/smoke.mjs
node test/client-bundle.mjs
```
- `smoke.mjs`：mock `webServer/sessionQuery/sessionPersistence`，真实 `node:sqlite`（`DSH_HOME` 临时目录）+ `test/session-events.jsonl`（397 行，394 条 `assistant/message+usage`）；断言：落盘→快照394→实时重放20条去重→rebuild一致→回环围栏→go-quota/deepseek-balance 结构化→空清单仍从介质重建394。
- `client-bundle.mjs`：验证 `window.__ModuleLoader__.load` 注册、每 `*.module.css` 对应 `data-plugin-css` 样式含 scoped 类名。

## 10. 文档维护
- `AGENTS.md` 为注入稳定前缀，仅规则/不变量变化时改；纯代码改动不碰它，结构/协议现状记 `docs/*` 或文件头注释。
- `docs/STRUCTURE.md` 生成文件（`pnpm tree`），`docs/API.md` 随接口维护；`README` 面向用户；`AGENTS.local.md` 放本机私有与强时效事实。

## 11. 提交（Conventional Commits）
格式 `type(scope): subject`（`type` 英文 `feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert`，`scope` 可选 `client/host/build/docs/deps`，`subject` 中文小写无句号）；`body/footer` 中文，`BREAKING CHANGE:` 置脚注首行；一次提交一件事，禁 `wip/update`；提交前须过 §9 四项。

## 12. 交付物
仅陈述最终确定的规则/架构/协议/实现，不写入过程备注与待定方案；过程内容走会话记录，不入库。
