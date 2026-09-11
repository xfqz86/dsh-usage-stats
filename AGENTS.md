# dsh-usage-stats 开发规范（AGENTS.md）

本文件约束本仓库全部开发，任何 agent/协作者必须遵守；不可删除。用户侧说明见 `README.md`；本机私有与强时效内容见 `AGENTS.local.md`（不入库，`.gitignore` 排除，dsh 自动注入）。

## 0. 红线：类型必须复用 deepseek-harness，禁止手写镜像

harness 每个包已导出完整精确的类型（`Context`/`ClientContext`/`SessionEvent`/`TokenUsage`/`PropsRuntime`/`InjectFace`/`Modal` 等），**禁止**为 `ctx/slots/locale/session/primitives/注入服务` 手写结构、最小接口或 ambient 镜像；**必须** `import type` harness 导出，用法与 `packages/extensions/ui-cordis` 等一致。

实现：`@deepseek-ai/*` 已发布至 npm（版本对齐见 `AGENTS.local.md`），`devDependencies` 直接安装，无 `paths` 映射；`import type` 打包剥离，运行时值（`react/primitives`）走 `tsdown external` 冻结表。`package.json` 仅 `devDependencies`，服务端只引 Node 内置+本地，浏览器端只 `require` 冻结表模块。例外（值导入，`tsdown` host 侧 `neverBundle` 不打包、运行时由本包 `node_modules` 解析）：服务端额度/余额查询的 `credentialRef`（`@deepseek-ai/dsh-credentials`）；Remote 体系的 `TypertRemoteService/Remote/RemoteError`（`@deepseek-ai/dsh-typert-protocol`）与 `Service` 符号（`@deepseek-ai/cordis`，仅 `[Service.init]` 键）；Client 贡献 `src/remote/contribution.ts` 内联的 `zod`（随浏览器 bundle 打包）。

服务端范式（类表单服务，Loader 实例化）：
```ts
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'         // ctx.sessionQuery
export default class UsageStatsService extends TypertRemoteService {
  static inject = ['sessionQuery', 'sessionPersistence']     // 全必需；可选服务不进 inject，调用处 ctx.get 判空
  @Remote('snapshot') snapshot(request: SnapshotRequest): UsageSnapshot { /* ... */ }
}
```
浏览器端范式：
```ts
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'  // ctx.slots（PropsRuntime/PropsLocale/InjectFace）
import type {} from '@deepseek-ai/dsh-api-gateway/client'         // ctx.remote
import { Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
export type Props = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'dsh-usage-stats'>
export const inject = ['slots', 'locale', 'remote']
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeMount = await mountUsageStatsRemote(ctx)
  ctx.effect(() => disposeMount, 'dsh-usage-stats: remote 挂载')
  ctx.locale.register(NS, { zh, en })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({...}, props => <Comp {...props} />))
}
```
取命名空间服务必须经挂载上下文 `get('remote.usageStats')`（本仓库由 `usageStatsRemote()` 封装，每次调用实时解析），禁止暂存 `ctx.remote` 再读 `.usageStats`。
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
- **tsx 一组件一文件**（如 `OverviewTab/DatesTab/SessionsTab` 各独立）；**协议类型集中 `src/types.ts`**（零运行时，host/client 各自 re-export），`src/utils.ts` 仅纯函数与共享常量。
- **样式用 CSS Modules**（`*.module.css` + `import css`），与 `ui-sidebar/primitives` 一致；界面静态样式颜色一律 `var(--dsw-alias-*)`，图表数据驱动调色板（`MODEL_PALETTE`/`DATE_TOKEN_META`/`HIT_RATE_COLOR`，集中定义于 `src/client/stats.ts`，`fill` 属性不解析 `var()`）为唯一豁免；禁止字符串 CSS。独立 bundle 由 `scripts/css-modules-inline.mjs`（lightningcss）编译内联为 `<style data-plugin-css>`。
- **组件归属**：可复用通用组件归 `src/client/components`，`src/client/views` 含 Tab 级视图及其专属子视图与入口壳（HeroTile/UsageHeatmap 为概览子视图，UsageStatsFooter/UsageStatsPanel 为入口壳）。
- **注释中文**，标识符/类型/错误消息英文；文档中文。

## 4. 项目结构
目录与职责见 `docs/STRUCTURE.md`（`pnpm tree` 生成，勿手改）。入口：`src/host/index.ts`（Host）、`src/client/index.ts`（Client）；共用 `src/types.ts`（类型）、`src/utils.ts`（纯函数与共享常量）。各文件职责以头部注释为准。

## 5. 架构：自管理 SQLite 账本 + 派生聚合缓存

**原则：账本（Ledger）唯一事实来源，聚合（UsageStore）只读派生。**

存储直接 `node:sqlite:DatabaseSync`（Node≥22 同步 API），落盘 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`（`DSH_HOME` 默认 `~/.dsh`，`logs.ts` 解析；测试注入 `DSH_HOME` 隔离）。

**九表**（同库、同步读写、独立提交，即写即持久）：
- **events**：`(t, session_id, seq, provider, model, input/output/cache_read/cache_write/reasoning)`，`PK(t,session_id,seq)` 天然幂等 `ON CONFLICT DO UPDATE`；`t` 缺失时当天确定性毫秒偏移。约束：TEXT 禁 `\0`，内存键 `provider\0model` 写时 `splitModelKey` 拆列，标题/cwd 等先 `sanitizeSqlText`（`\0→\uFFFD`）。
- **session_meta**：`(session_id PK, title, cwd, created_at, last_active, parent_session, origin, delegation_depth)`，初始化抄录、运行时由 `session/title` 与 `session/event` 头补齐，内存 `metaCache` 供快照；`user_version 3→4`增量补三列。
- **agg_***：`agg_total/agg_daily/agg_model/agg_model_daily/agg_session/agg_session_daily/agg_checkpoint` 预统计物化视图，批量扫描 `aggSuspended` 挂起、结束 `persistAggregates` 一次物化并 `sealUntil(今日零点)`。
- **版本**：`PRAGMA user_version=LEDGER_VERSION=6`；仅 `2→3/3→4` 增量保留数据，其余 `DROP` 重建（空表触发全量重扫）；统计口径变化也必须递增，否则历史事件不会被补录（见 §6 数据源）。

**数据流**：
1. **openLedger**：建目录/表、迁移、载入 meta、预编译 `LedgerStatements`。
2. **scanOnce**：会话 id 全集=磁盘 `findSessionLogs(深度≤3，按代次择优)` ∪ harness 清单；4 路 worker，优先 harness 读取（`sessionQuery.readSession` → `persistence.open+read`），失败或空时回退自读磁盘原始日志（`rawlog` 多帧 zstd 解码，覆盖 harness 迁移拒绝的旧格式）；两路都按 fork 继承前缀过滤（`store.ts` 的 `liveEventsOf`），经 `foldRecord` 共用路径，`running` 防重入（`force` 持锁重入除外）。
3. **实时增量**：`ctx.on('session/event')` → `foldRecord` → `foldLedgerEvent` + `incrementAgg`，经 seq 水位、seq=-1 主键、`append` 返回值三层去重，补齐 `parentSession/origin/depth/cwd/createdAt`。
4. **重启恢复**：`bootstrap()` 优先 `hasAggregates→rebuildWithDelta`（加载 `agg_*` + 补 `sealedUntil` 后增量），其次 `hasEvents→rebuildFromEvents`，否则全量扫描；日志删除仍可从介质恢复。
5. **重建**：`usageStats/rebuild` → `ledger.clear()`+`resetStore`+`scanOnce`；`clear` 仅清库，`seal` 手动物化。

**折叠语义**：`foldRecord` 处理种子/`title`/`usable(data.usage存在)` 事件，零用量事件直接丢弃不入账本；经三层去重后 `append`+`foldLedgerEvent` 折入日桶/总桶/模型、模型×日并更新 `maxSeq/lastActive`（`seq>=0` 才推进水位）；`foldLedgerEvent` 归一非有限/负数→0并向下取整，若传 `ledger` 则同步 `incrementAgg`（失败仅 `lastError`）。

**fork 继承前缀**：被 fork 的子会话日志物理包含父会话的历史事件，由 `session/end-seed`（`data.inherited: true`）标记分界。统计只取自有部分——harness 两路读 `inheritedEventCount`，原始日志路径用 `inheritedPrefixOf` 求标记；不做这层过滤会把父的用量在子会话名下重复计入（`store.ts` 的 `inheritedCountOf`/`inheritedPrefixOf`/`liveEventsOf`，实时监听同样按 `session.inheritedEventCount` 跳过）。

## 6. 统计口径
- 数据源：带 `data.usage` 的计量事件——对话调用 `assistant/message` 与压缩调用 `compaction/summary`（`toLedgerEvent` 非有限/负数→0并向下取整，零用量直接丢弃不入账本）。
- **跨会话不重复**：fork 继承前缀属于父会话，子会话只统计 `inheritedEventCount` 之后的自有事件（见 §5 fork 继承前缀）；同一会话按最高代次文件只折一次。
- `total=input+output+cacheRead+cacheWrite`，`reasoning` 单列。
- 按模型：`assistant/message` 取 `data.message.source.provider/model`，`compaction/summary` 取 `data.provider`/`data.model`，缺失 `unknown`；`assistant/attempt` 不收（用量是流式中间态，与同 turn 的 `assistant/message` 重复）。
- 按会话：标题/`cwd`/创建时间/最近活跃。
- 本地日划分：`startOfDay`（`utils.ts` 唯一来源，避免 UTC 漂移）。
- 展示口径：日期趋势柱仅堆叠输入/输出/缓存三段（柱高按三段求和，`total` 字段仍为全口径），缓存命中率=`cacheRead/(cacheRead+input)`；快照 `series.all`/`models[].series` 截断至最近 366 天（`series.current` 不截断）。
- **不计入项（数据源边界，非本仓可补）**：会话标题生成的辅助调用——`session/title-llm-request` 只记请求，harness 取标题文本后丢弃响应 usage，日志里没有用量可折；重试被替换的中间尝试与无 `assistant/message` 的中断流——用量只存在于 `assistant/chunk`/`assistant/attempt` 的 stream 里，与最终 `assistant/message` 同源，按 message 折叠避免双计（dsh 自身 token 投影同样不计）。

## 7. 构建（tsdown 双 bundle + CSS 内联）
- `lib/index.js`（Host, Node ESM，`@xfqz86/dsh-usage-stats`）：仅 Node 内置+本地，DSH 服务 cordis 注入。
- `lib/client.js`（Browser CJS 闭包 `window.__ModuleLoader__.load({id,factory})`）：`externals` 复刻冻结表（`react/primitives/slots` 等），其余内联；非 `production` 保留 sourcemap。
- CSS：`scripts/css-modules-inline.mjs`（lightningcss `cssModules`）将 `*.module.css` 编译为 scoped 映射+`<style data-plugin-css>` 注入（源码仍真实 CSS Modules）。

## 8. 运行时与 Remote API
- **注入**：`static inject=['sessionQuery', 'sessionPersistence']`（全必需）；`credentials` 可选不进 inject，调用处 `ctx.get` 判空，缺席时额度查询直接返回 `no-key`，不读 env 与文件；先挂实时监听再 `bootstrap`。
- **接口**：`UsageStatsService`（`usageStats` 命名空间，7 个一元 `@Remote` 方法）经网关 `POST /api/usageStats/<方法>` 调用，信任与认证由网关载体统一处理，不注册 HTTP 路由、不自建围栏。Host 侧 SRC 分发（装饰器标记+实时绑定），Client 侧自挂载 `src/remote/contribution.ts` 的手写严格贡献（独立仓库跑不了 harness 生成器管线）；只改实现体不动贡献，改签名必须同步。浏览器端取命名空间服务必须经挂载上下文 `get('remote.usageStats')`（本仓库由 `src/client/remote.ts` 的 `usageStatsRemote()` 封装，每次调用实时解析），**禁止**暂存 `ctx.remote` 再读 `.usageStats`——插件行跑在子 scope，暂存句柄在 hooks（fiber 之外）读属性报 `without inject`（命名空间服务挂在父级）。
- 协议细节（`snapshot/goQuota/deepseekBalance/zaiQuota/rebuild/clear/seal`、TTL、偏好字段）见 `docs/API.md`；快照 `series.all`/`models[].series` 截断至最近 366 天（`series.current` 不截断）。
- **偏好设置走 harness 用户设置体系，禁止 localStorage**：Host 侧 `ctx.inject(['settings'], …)` 注册 `usage-stats` 命名空间（`src/host/settings.ts`，schemastery schema 带字段默认值，默认值与 `src/utils.ts` 的 `USAGE_SETTINGS_DEFAULTS` 同源），落 `$DSH_HOME/settings.yaml`，只存显式改过的字段；Client 侧 `inject` 含 `settingsScope`，经 `src/client/settings.ts` 的 `attachUsageSettings` 绑定作用域、`updateUsageSettings` 路径写入、`useUsageSettings` 订阅渲染，作用域未就绪或服务端未注册时回退默认值。两个服务都可选：`settings` 不进 Host 的 `static inject`（缺席时不注册命名空间），Client 侧 `settingsScope` 随 `dsh.client.inject` 的 `@deepseek-ai/dsh-client-ui-settings` 保证加载序；缺席时偏好退化为仅当前页面生效，设置页顶部如实提示。旧版本 localStorage（key `dsh-usage-stats.settings`）由 `migrateLegacySettings` 一次性迁移：先等作用域落定，就绪可写且文档无该命名空间时只写与默认值不同的字段，写成功或文档已有用户段才删旧键，服务端设置缺席/只读时保留旧键。

## 9. 验证（每次改动必须）
```bash
npx tsc --noEmit
npx eslint .              # 0 errors 为门禁
pnpm build
node --experimental-strip-types test/pure.mjs
node --experimental-strip-types test/smoke.mjs
node --experimental-strip-types test/styles.mjs
node test/client-bundle.mjs
```
- `pure.mjs`：`node:test` 纯函数与额度解析单测，直引 `src/*.ts` 源码（仅可擦除语法，见 `docs/STYLE.md §7`），断言：工具/聚合/计量事件判定与模型身份（`usable` 收对话与压缩调用、拒 `assistant/attempt`；`modelKeyOf` 两处取源）/日志解析/rawlog 代次与多帧 zstd/fork 继承前缀（`inheritedCountOf`/`inheritedPrefixOf`/`liveEventsOf`）/手写严格贡献（方法表/收发合法拒非法/信封分支）/命名空间句柄（经 `get` 取、不暂存 `ctx.remote`）/偏好设置（归一化与夹取、路径写入只带显式字段、作用域视图引用稳定、解绑带作用域身份（热重载不误清新作用域）、不可用或只读时不发注定被拒的写入、旧 localStorage 迁移：等作用域落定、成功写文档才删旧键、不可用时保留；服务端命名空间注册，schema 解析值等于共享默认值、注册失败只降级偏好不抛错）/格式化/分组/时间范围/图表几何/快照截断/三额度 fixture（含无 key、无 plan、非法归一、key 回退、go 缓存单飞），无外网请求，不碰 sqlite。
- `smoke.mjs`：真实 cordis `Context` + mock `sessionQuery/sessionPersistence`（凭据中心缺席时额度查询直接返回 `no-key`），真实 `node:sqlite`（`DSH_HOME` 临时目录）+ `test/session-events.jsonl`（397 行，394 条 `assistant/message+usage`）；断言：落盘→快照394→@Remote 标记存活→实时重放20条去重→真实结果过 zod 信封→rebuild 并发 `usageStats/busy`→rebuild一致→三额度 no-key→seal→空清单仍从介质重建394→clear 归零。另有四个独立 `DSH_HOME` 用例：旧代次会话 raw 兜底（`SessionFormatUnsupportedError` → 自读最高代次，只折一次）、fork 继承前缀过滤（query 与 raw 两路都只折自有事件）、压缩调用计入（`compaction/summary` 的用量计入总量与模型拆分，缺 usage/零用量不入账，实时路径同样接纳）、偏好设置命名空间注册与落盘（挂 harness 真实文件后端 `@deepseek-ai/dsh-settings-file`：默认值齐备且未改动时不建文档、update 只把显式改过的字段写进 `$DSH_HOME/settings.yaml` 的 `usage-stats` 段、describe 下发的 schema 可 JSON 序列化）。
- `styles.mjs`：样式契约，扫描全部 `*.module.css`，断言引用的每个变量都在主题包 `@deepseek-ai/dsh-client-ui-theme`（devDependency，与 harness 运行时同包）声明过且前缀合法——未声明的变量会让声明在计算值阶段失效，深色模式下表现为写死浅色的色块（详见 `docs/STYLE.md §8`）。
- `client-bundle.mjs`：验证 `window.__ModuleLoader__.load` 注册、每 `*.module.css` 对应 `data-plugin-css` 样式含 scoped 类名。

## 10. 文档维护
- `AGENTS.md` 为注入稳定前缀，仅规则/不变量变化时改；纯代码改动不碰它，结构/协议现状记 `docs/*` 或文件头注释。
- `docs/STRUCTURE.md` 生成文件（`pnpm tree`），`docs/API.md` 随接口维护，`docs/STYLE.md` 为风格经验（lint 之外的统一约定，新会话先读）；`README` 面向用户；`AGENTS.local.md` 放本机私有与强时效事实。
- `CHANGELOG.md`（项目根目录）随发版维护：每次 `package.json version` 变更必须同步追加该版本条目，记录功能更新与 Bug 修复，`Unreleased` 草稿后移并清空。
- `docs/releases/v<版本>.md` 随发版新增：面向用户的人话版更新说明（这个版本做了什么、用户能看到什么变化，不写内部实现），即 GitHub Release 正文；`release.yml` 强制该文件存在，缺失直接失败。详见 `docs/PUBLISH.md`。
- **改动须同批更新受影响的注释、`docs/*` 与 `CHANGELOG.md` 的 `[Unreleased]`**：功能、行为变更记入对应小节（新增/变更/修复），纯重构与文档整理简记一行；`docs/STRUCTURE.md` 跑 `pnpm tree` 重生成。不留「代码已改、文档待补」的中间态，一次改动一次对齐、同批验证。

## 11. 提交（Conventional Commits）
格式 `type(scope): subject`（`type` 英文 `feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert`，`scope` 可选 `client/host/build/docs/deps`，`subject` 中文小写无句号）；`body/footer` 中文，`BREAKING CHANGE:` 置脚注首行；一次提交一件事，禁 `wip/update`；提交前须过 §9 全项。

## 12. 交付物
仅陈述最终确定的规则/架构/协议/实现，不写入过程备注与待定方案；过程内容走会话记录，不入库。
