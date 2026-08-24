# dsh-usage-stats 开发规范（AGENTS.md）

本文件约束本仓库（`dsh-usage-stats` 插件，独立工作区）的全部开发工作。任何 agent / 协作者在本仓库工作时必须遵守。本文件本身是交付物的一部分，不得删除。面向普通用户的功能说明见 `README.md`；本文件是开发者 / agent 的工程规范与架构备忘录。**本机目录相关与强时效性的说明不在这里**，集中在 `AGENTS.local.md`（不入库，`.gitignore` 排除；dsh 会自动注入）。

## 0. 红线：类型必须复用 deepseek-harness，禁止手写镜像类型

**这是红线。** deepseek-harness 源码（本机 checkout，目录见 `AGENTS.local.md`）的每个包均导出了完整、精确、可合并的类型（cordis `Context`、`ClientContext`、`SessionEvent` / `SessionHeader` / `SessionId`、`TokenUsage`、`PropsRuntime` / `PropsLocale` / `InjectFace`、`Modal` / `Tooltip` / 图标、各服务接口等）。

**禁止**：为 ctx、slots、locale、session 事件、primitives 组件、注入服务等手写结构类型、最小接口、ambient 声明或镜像接口。

**必须**：直接 `import type` / `import` harness 包的导出，用法与 harness 仓库内其他插件完全一致（参照 `packages/extensions/ui-cordis`、`packages/extensions/tool-cordis`）。

### 类型如何可用（工程机制）

`@deepseek-ai/*` 包已发布至 npm（当前对齐版本、dist-tag 与升级同步流程见 `AGENTS.local.md`）。本项目在 `devDependencies` 中直接安装 npm 包，版本对齐 shell 冻结模块表；`tsconfig` 不做任何 paths 映射，TypeScript 从 `node_modules` 直接解析 .d.ts 闭包（各包的 peer 依赖由 pnpm 自动安装）。构建不受影响：`import type` 在打包时被剥离；运行时值导入（react、primitives）走 tsdown `external`，从 shell 冻结模块表解析。本项目运行时不依赖任何 runtime 依赖（`package.json` 中仅有 `devDependencies`）—— 服务端仅 import Node 内置模块与本地模块，浏览器端仅 require 冻结模块表中已有的 shell 模块。

### 标准写法（照抄这些范式）

服务端（Node cordis 插件）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
// 服务 / 事件类型通过包的 declare module 合并进 Context / SessionEventMap：
import type {} from '@deepseek-ai/dsh-host-webserver'        // ctx.webServer
import type {} from '@deepseek-ai/dsh-session-query'         // ctx.sessionQuery
import type {} from '@deepseek-ai/dsh-session-persistence'   // ctx.sessionPersistence
import type {} from '@deepseek-ai/dsh-session-title'         // SessionEventMap['session/title']

export function apply(ctx: Context): void { /* ctx.webServer / ctx.sessionQuery 等直接属性访问，自动有类型（不用 ctx.get） */ }
```

浏览器端（cordis client 插件）：

```ts
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'              // PropsLocale/PropsRuntime + ctx.slots
import type {} from '@deepseek-ai/dsh-client-locale/client'          // ctx.locale
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'      // SlotMap 扩充（sidebar.footer.action 等）
import { Modal, Tooltip, IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

// 组件 props = 插槽组合类型：
export type Props = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'dsh-usage-stats'>

export function apply(ctx: ClientContext): void {
  ctx.locale.register(NS, { zh, en })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({...}, (props) => <Comp {...props} />))
}
```

文案字典遵循 `ui-cordis/src/client/locales.ts` 范式：`NS` + `zh satisfies Record<string, string>` + `export type UsageStatsKey = keyof typeof zh` + `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { ... } }` + `en satisfies Record<UsageStatsKey, string>`，之后 `t('key')` 具备全量类型校验。

## 1. 术语规范

- 使用 **服务端（Host）** / **浏览器端（Client）**，对应 harness 包命名（`dsh-host-*`、`dsh-client-*`）。禁止使用“宿主半 / 客户端半”等非标准表述。
- Host 指运行于 Node 侧的 cordis 插件（`lib/index.js`）；Client 指浏览器侧 bundle（`lib/client.js`，经 `dsh.client` 声明注入）。

## 2. 项目形态与部署（cordis.patch 标准模式）

- 插件为标准 cordis 组合包：`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [...], "platform": "web" } }`，以及 `exports` 的 `./client`。
- 不提供 `install.sh` / `uninstall.sh`，不引入注册表通道（`dsh.plugin.json` / `client-registry.js`）等旁路机制。安装与卸载遵循标准方式：`dsh plugin --profile web add "link:<路径>"`（或 profile package.json link 依赖 + `dsh.profile.bundles` 对账），`dsh plugin --profile web remove <name>`。
- profile 依赖以 `link:` 指向本仓库目录，改动后重新 `pnpm build`，浏览器刷新页面即可（服务端改动需重启 dsh）。`cordis.patch.yml` 仅含一条 `usage-stats` 插入条目，不挂载任何 storage 后端行，也不覆写 web profile 的 `storage-domain` 路由（账本自管理，见 §5）。

## 3. 代码规范

- **不使用 `any`**：ctx 一律使用 harness 导出的类型；业务数据使用明确接口。
- 类型仅定义 harness 未提供的部分（如本插件的 API 快照协议 `UsageSnapshot`）。
- 纯逻辑置于无 React 的模块（如 `src/utils.ts`、`src/host/agg.ts`、`src/client/stats.ts`），便于测试。
- **tsx 一个组件一个文件**：不将多个组件置于同一 tsx（如模态窗各 Tab 独立为 `OverviewTab.tsx` / `DatesTab.tsx` / `SessionsTab.tsx` / `ModelsTab.tsx` / `SettingsTab.tsx`，统计格与热力图亦各占一个文件）。
- **协议类型集中于 `src/types.ts`**（仅类型声明、零运行时，host / client 各自 re-export）；`src/utils.ts` 仅包含纯函数。类型与逻辑分离，避免单一文件混杂。
- **样式使用 CSS Modules**（`*.module.css`，`import css from './X.module.css'`），写法与 harness 的 ui-sidebar / ui-primitives 一致；颜色一律使用设计 token（`--dsw-alias-*` / `--dsw-shadow-*`）。禁止将 CSS 写为字符串常量。独立插件 bundle 无法直接携带 .css 资产，由 `scripts/css-modules-inline.mjs` 在构建时将 .module.css 编译并内联为 JS 注入的 `<style>`（源码仍为真实 CSS Modules，仅构建产物单文件化）。
- **注释使用中文**（代码注释、文件头注释、CSS 注释、测试注释、构建脚本注释）；标识符、类型名、错误消息使用英文。文档（README / AGENTS）使用中文。

## 4. 项目结构与模块职责

目录树与各文件职责见 `docs/STRUCTURE.md`（由 `scripts/gen-tree.mjs` 自动生成，改动代码结构后运行 `pnpm tree` 重新生成，请勿手改）。两个 bundle 的源码入口分别为 `src/host/index.ts`（服务端 Host）与 `src/client/index.ts`（浏览器端 Client）；跨端共用的协议类型位于 `src/types.ts`，纯函数位于 `src/utils.ts`。各文件的模块职责以其头部注释为准，AGENTS.md 不重复维护目录树现状。

## 5. 架构：自管理 SQLite 账本 + 派生聚合缓存

**核心原则：账本（Ledger）为唯一事实来源，聚合（UsageStore）为只读派生缓存。**

存储不依赖 harness 的 storage 家族，直接使用 Node ≥22 内置的 `node:sqlite` 的 `DatabaseSync`（同步 API，运行时仅打印一条 experimental 警告）。数据落盘于 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`（`DSH_HOME` 默认为 `~/.dsh`，由 `logs.ts` 解析，测试通过注入 `DSH_HOME` 隔离介质）。

### events / session_meta / agg_* 七表

- **events 表**：一行一条用量事件，结构为 `(t INTEGER, session_id TEXT, seq INTEGER, provider TEXT, model TEXT, input/output/cache_read/cache_write/reasoning INTEGER)`，主键为 `PRIMARY KEY (t, session_id, seq)`。结构化列主键具备天然幂等性，重复写入经 `INSERT ... ON CONFLICT DO UPDATE` 收敛；重建账本时每行仅折叠一次。
  - 约束：`node:sqlite` 的 TEXT 不允许包含 U+0000。模型键在内存中以 `provider\0model` 形式存在，写入时经 `splitModelKey` 拆分为两列，不将含 `\0` 的整串写入 SQLite。
- **session_meta 表**：`(session_id TEXT PRIMARY KEY, title, cwd, created_at, last_active)`，记录会话标题、工作目录、创建与最近活跃时间；初始化扫描时抄录，运行时由 `session/title` 事件更新；内存中保留一份 `Ledger.metaCache` 供快照读取。
- **agg_* 预统计表**：`agg_total`（全量单行）、`agg_daily`（按日）、`agg_model`（按模型）、`agg_session`（按会话）、`agg_session_daily`（按会话×日）、`agg_checkpoint`（密封边界），与 events 同库事务，用于冷启动时直接加载聚合而无需重放全量事件。
- **版本**：`PRAGMA user_version` 等于 `LEDGER_VERSION`（当前为 3）；`version 2→3` 增量保留历史事件，其余不兼容时 `open()` 自动 DROP 全量表重建（事件表为空时下次启动触发全量重扫）。所有读写为同步操作，`append` / `setMeta` 即写即持久（SQLite 自动提交），崩溃后重启可从介质恢复，无需周期性对账。

### 数据流

1. **打开账本**（`openLedger` → `Ledger.open`）：创建目录与表、执行迁移、载入 meta 缓存；预编译语句集 `LedgerStatements`（hasEvent / insertEvent / allEvents / upsertMeta / allMeta）。
2. **首启 / 重建**（`scan.ts`）：`scanOnce` 以会话 id 全集（磁盘原始日志 `findSessionLogs` 深度 ≤3 与 harness 会话清单的并集）逐会话导入，优先使用 RAW 路径（`persistence.readRaw`，后端纯 JS zstd 解码，无 CLI 依赖），失败时回退至 harness 兜底路径（`sessionQuery.readSession` / `persistence.readFrom`）；4 路 worker 并行，`store.running` 防止重入。初始化与重建均经 `foldRecord`，与实时路径共用。
3. **实时增量**（`ctx.on('session/event')`）：逐条经 `foldRecord` 写入账本并折叠至聚合；与扫描共用路径，按会话 `maxSeq` 水位去重。
4. **重启恢复**：`bootstrap()` 中若 `ledger.hasEvents()` 为真，则经 `rebuildFromEvents` 从 events 表全量重折聚合缓存（`maxSeq` 水位随折叠重建，后续实时路径仍可对历史事件去重）；为假则全量扫描日志。有账本时不重扫，日志删除或不可读时仍可恢复统计。
5. **重建账本**：`POST /usage-stats/api/rebuild` → `ledger.clear()`（清空两表）+ `resetStore`（复位聚合）+ `scanOnce` 重扫。设置页提供入口。

### 折叠语义（store.ts）

- `foldRecord(store, ledger, id, record)`：session 种子记录写入 cwd / createdAt 至账本 meta；`session/title` 写入标题；`usable` 事件（`data.usage` 存在）按 seq 水位去重后经 `ledger.append` 与 `foldLedgerEvent` 折入会话日桶、会话总桶、全量日桶、全量总桶及模型桶，并推进该会话 `maxSeq`。全部为同步操作。
- `foldLedgerEvent(store, ev)`：账本事件至聚合的折叠。参数归一化：非有限或负数 token 按 0 处理。

## 6. 统计口径

- **数据源**：`assistant/message` 事件，且 `data.usage` 存在时计入（`usable` 守卫；`toLedgerEvent` 中非有限或负数按 0 归一）。
- **total = input + output + cacheRead + cacheWrite**，`reasoning` 单列，不计入 total。
- **按模型**：取 `data.message.source.provider` 与 `model`，缺失记为 `unknown`。
- **按会话**：会话标题（`session/title` 事件）、cwd（`session` 事件顶层字段）、创建时间、最近活跃时间。
- **本地日划分**：`startOfDay`（`utils.ts` 单一事实来源，host 折叠与 client 图表共用，避免 UTC 漂移）。

## 7. 构建机制（tsdown 双 bundle + CSS Modules 内联）

`tsdown.config.ts` 产出两个 bundle：

- **lib/index.js** —— 服务端（Host，Node ESM）：包名 `@xfqz86/dsh-usage-stats`（`package.json:name`），运行时仅 import Node 内置模块（含 `node:sqlite`）与本地代码；DSH 服务由 cordis 注入，不直接 import。
- **lib/client.js** —— 浏览器端 bundle（CJS 闭包工厂）：以包名 `@xfqz86/dsh-usage-stats` 通过 `window.__ModuleLoader__.load({ id, factory })` 注册；externals 复刻 shell 冻结模块表（react / react/jsx-runtime / react-dom / cordis / `@deepseek-ai/dsh-client-*` 等），bundle 运行时仅 require 这些已有模块，其余全部内联。

CSS Modules 内联：`scripts/css-modules-inline.mjs`（rolldown 插件，使用 lightningcss 的 `cssModules` 模式）在构建时将 `*.module.css` 编译为 scoped 类名映射与 `<style data-plugin-css="dsh-usage-stats/<File>">` 注入（按文件名幂等，`data-plugin` 标记）。源码仍为真实 CSS Modules。

## 8. 运行时入口与 JSON API

- **Host 注入**：`inject = ['webServer', 'sessionQuery', 'sessionPersistence']`。挂载顺序为先挂载实时监听（初始扫描期间不遗漏事件），再执行 bootstrap 初始化。
- **路由**：`ctx.webServer.register({ kind: 'prefix', path: '/usage-stats/api', handler })`，仅支持 POST，每次调用先经过回环围栏校验（仅回环 Host 可访问，防御 DNS 重绑定与跨站探测）。
- `snapshot` / `go-quota` / `rebuild` / `clear` / `seal` 的请求与响应结构、Go 额度 key 解析与 TTL 规则、偏好设置字段等协议细节见 `docs/API.md`（随接口演进维护，本文件不重复）。

## 9. 验证（每次改动必须）

```bash
npx tsc --noEmit        # 类型检查（TS5 + @types/node@22 + @types/react）
pnpm build              # lib/index.js + lib/client.js
node test/smoke.mjs     # 服务端冒烟（mock cordis + 真实 node:sqlite 账本 + 仓库内会话 fixture）
node test/client-bundle.mjs  # 浏览器端 bundle 冒烟（模拟 __ModuleLoader__ + document）
```

- `test/smoke.mjs`：以 mock 的 webServer / sessionQuery / sessionPersistence 挂载 `apply()`（存储不 mock：账本直接写入真实 `node:sqlite` 文件，`DSH_HOME` 指向临时目录）；fixture 使用仓库内 `test/session-events.jsonl`（共 397 行，其中 394 条为带 usage 的 `assistant/message` 事件，其余为会话与元数据记录，单会话）。断言：SQLite 文件落盘 → 快照 394 → 实时重放 20 条去重不翻倍 → rebuild 一致 → 回环围栏 → go-quota 结构化 → 重开会话清单为空时仍可从介质重建 394。
- `test/client-bundle.mjs`：加载 `lib/client.js`，验证顶层 `window.__ModuleLoader__.load` 注册（id 为 `@xfqz86/dsh-usage-stats`）、`factory(require)` 返回 inject / apply、`document` 中出现每个 `*.module.css` 对应的 `data-plugin-css` `<style>` 且样式文本含 scoped 类名。

## 10. 文档维护约定（防止注入上下文 churn）

- **AGENTS.md 是注入至模型上下文的稳定前缀**：仅在规则或不变量变化时修改；纯代码改动（新增文件、调整接口形状、修改文案）禁止顺手修改 AGENTS.md。需记录结构或协议现状时，修改 `docs/*` 或各文件头注释。
- 描述性与现状快照类内容（目录树、API 细节、数据流 walkthrough）一律置于 `docs/*` 或文件头注释；README 面向普通用户；AGENTS.local.md 仅存放本机私有与强时效的小量事实。
- `docs/STRUCTURE.md` 为生成文件，结构变化后运行 `pnpm tree` 重新生成，请勿手写；`docs/API.md` 记录接口协议现状，随接口演进维护。

## 11. 提交规范（Conventional Commits）

本仓库所有提交必须遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 规范。

- **格式**：`type(scope): subject`，`type` 必选，`scope` 可选，`subject` 使用中文简洁描述，首字母小写、句末不加句号。
  - `type` 取值：`feat`（新特性）、`fix`（修复）、`docs`（文档）、`style`（样式 / 格式）、`refactor`（重构）、`perf`（性能）、`test`（测试）、`build`（构建）、`ci`（持续集成）、`chore`（杂项）、`revert`（回滚）等，严格按 CC 列表。
  - `scope` 建议：`client` / `host` / `build` / `docs` / `deps` 等，按模块标注。
- **正文与脚注**：`body` 使用中文补充变更细节与动机；关联 issue 写于 `footer`（如 `Refs #123`）；`BREAKING CHANGE:` 必须在脚注首行声明不兼容变更。
- **原子性**：一次提交仅处理一个特定问题，禁止 `wip`、`update`、`fix bug` 等无意义信息，禁止在同一提交中混入无关变更。若一次改动涉及多个独立问题，必须拆分为多个提交，每个提交可独立验证与回滚。
- **语言**：`type/scope` 使用英文，`subject/body/footer` 使用中文。
- **验证**：提交前必须通过 `npx tsc --noEmit`、`pnpm build`、`node test/smoke.mjs`、`node test/client-bundle.mjs`（见 §9）；未通过不得提交。
- **示例**：
  - `feat(client): 今日磁贴标题上移与命中率布局`
  - `fix(client): 修复三色条 tooltip 跟随与漂移`
  - `docs: 补充 Conventional Commits 提交规范`
  - `chore(build): 调整 Go 卡片间距与磁贴悬浮样式`

## 12. 交付物形态：正式方案

本仓库所有交付物（`README.md`、`AGENTS.md`、`docs/*`、代码与注释）均以正式方案形态呈现：

- 仅陈述最终确定的规则、架构、协议与实现，不写入过程注释、临时备注、推演痕迹或待定方案；
- 不将与协作者或模型在会话沟通过程中产生的增量修改、中间结论或过程性说明写入正式文档；
- 过程性内容如需留存，通过会话记录或临时沟通渠道处理，不进入版本化文档；
- 本条为强制规则，后续对文档的任何修订均须符合正式方案标准。
