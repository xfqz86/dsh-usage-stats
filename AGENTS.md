# dsh-usage-stats 开发规范（AGENTS.md）

本文件约束本仓库全部开发，任何 agent/协作者必须遵守；不可删除。用户侧说明见 `README.md`；本机私有与强时效内容见 `AGENTS.local.md`（不入库，`.gitignore` 排除，dsh 自动注入）。

**本文件只写规则与不变量**，机制事实、协议细节、统计口径各有权威文档（见 §10 归属表），在此不复述；新增信息先查归属表、只写权威文件。

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
- `link:` 指向本仓库；`pnpm build` 后浏览器刷新即生效（服务端需重启 dsh）。`cordis.patch.yml` 仅一条 `usage-stats` 插入，不挂 `storage` 后端、不覆 `storage-domain`（账本自管理，见 `docs/ARCHITECTURE.md`）。

## 3. 代码规范
- **不使用 `any`**；`ctx` 用 harness 类型，业务数据用明确接口；类型仅定义 harness 未提供的（如 `UsageSnapshot`）。
- **风格与检查**：遵循 **Google TypeScript Style Guide**；`eslint.config.mjs`（flat config，`eslint 9 + typescript-eslint 8 + eslint-plugin-import-x + @stylistic`，分 `host/client/scripts` 三类 overrides）为唯一事实来源；新增代码须 `npx eslint .` 零 `errors`。
- 纯逻辑置于无 React 模块（`src/utils.ts`/`src/host/agg.ts`/`src/client/stats.ts`）便于测试。
- **tsx 一组件一文件**（如 `OverviewTab/DatesTab/SessionsTab` 各独立）；**协议类型集中 `src/types.ts`**（零运行时，host/client 各自 re-export），`src/utils.ts` 仅纯函数与共享常量。
- **样式用 CSS Modules**（`*.module.css` + `import css`），与 `ui-sidebar/primitives` 一致；界面静态样式颜色一律 `var(--dsw-alias-*)`，图表数据驱动调色板（`MODEL_PALETTE`/`DATE_TOKEN_META`/`HIT_RATE_COLOR`，集中定义于 `src/client/stats.ts`，`fill` 属性不解析 `var()`）为唯一豁免；禁止字符串 CSS（编译内联机制见 `docs/ARCHITECTURE.md` §6）。
- **组件归属**：可复用通用组件归 `src/client/components`，`src/client/views` 含 Tab 级视图及其专属子视图与入口壳（HeroTile/UsageHeatmap 为概览子视图，UsageStatsFooter/UsageStatsPanel 为入口壳）。
- **注释中文**，标识符/类型/错误消息英文；文档中文。

## 4. 项目结构
目录与职责见 `docs/STRUCTURE.md`（`pnpm tree` 生成，勿手改）。入口：`src/host/index.ts`（Host）、`src/client/index.ts`（Client）；共用 `src/types.ts`（类型）、`src/utils.ts`（纯函数与共享常量）。各文件职责以头部注释为准。

## 5. 架构与数据流
- 不变量：**账本（Ledger）唯一事实来源，聚合（UsageStore）只读派生**。
- 账本九表、数据流、折叠与去重、fork 继承前缀、清零墓碑的唯一权威是 `docs/ARCHITECTURE.md`——改 `ledger/store/agg/scan/rawlog` 相关代码前必读；本文件不复述。

## 6. 统计口径
- 精确口径唯一权威是 `docs/ARCHITECTURE.md` §5（用户语言版在 `README.md`）；统计口径变化必须递增账本 `user_version`（见该文件 §2），本文件不复述。

## 7. 构建
- 产物形态与 CSS 内联机制见 `docs/ARCHITECTURE.md` §6；构建命令见 §9。

## 8. 运行时与 Remote API
- **注入**：`static inject=['sessionQuery', 'sessionPersistence']`（全必需）；`credentials` 可选不进 inject，调用处 `ctx.get` 判空，缺席时额度查询直接返回 `no-key`，不读 env 与文件；`settings` 同为可选，缺席时不注册命名空间。先挂实时监听再 `bootstrap`。
- **接口**：`UsageStatsService`（`usageStats` 命名空间，7 个一元 `@Remote` 方法）经网关 `POST /api/usageStats/<方法>` 调用，信任与认证由网关载体统一处理，不注册 HTTP 路由、不自建围栏。协议（方法表、请求/响应、TTL、偏好字段）唯一权威是 `docs/API.md`，改签名必须同步实现体、手写贡献与该文件。
- Host 侧 SRC 分发（装饰器标记+实时绑定）；Client 侧自挂载 `src/remote/contribution.ts` 的手写严格贡献（独立仓库跑不了 harness 生成器管线）——只改实现体不动贡献。
- **偏好设置走 harness 用户设置体系，禁止 localStorage**：Host 注册 `usage-stats` 命名空间（`src/host/settings.ts`，默认值与 `USAGE_SETTINGS_DEFAULTS` 同源），Client 经 `settingsScope` 绑定读写（`src/client/settings.ts`）；字段语义与旧版迁移见 `docs/API.md` §5。

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
- 各测试的覆盖范围与断言清单以 `test/*.mjs` 头注释为准，本文件不复述；样式契约背景见 `docs/STYLE.md` §8，测试直引源码的可擦除语法要求见 `docs/STYLE.md` §7。

## 10. 文档与注释治理（一事一地）

**每类信息只有一个权威位置，其余最多一行指针，禁止复述；治理在每次会话执行，而不是靠一次性清理。**

- **先查后写**：新增任何文档/注释内容前，先查归属表并 grep 关键词，确认权威位置尚无该表述，然后只写权威位置；修改事实只改权威地，别处发现第二份完整表述即删、换指针；删除或迁移前确认权威地已含该信息（只迁移不丢失）。
- **同批与修即清**：改动任何文件时，受影响的注释与权威文档同批更新；路过发现的失效、重复文档/注释顺手清理，不留「代码已改、文档待补」的中间态。
- **注释的权威边界**：注释只对两件事是权威——文件职责（头部块注释首句，`docs/STRUCTURE.md` 的数据源）与代码自身说不出的局部约束；内容标准（只写 why、不复述代码、不复制文档、不写修复历史）见 `docs/STYLE.md` §6。
- 每份文档开头一句职责声明；用户文档（README/CHANGELOG/releases）允许用户语言概述，但不承载实现细节。
- 本文件为注入稳定前缀，仅规则/不变量变化时改；纯代码改动不碰它。
- 发版同步：`package.json version` 变更必须同批追加 `CHANGELOG.md` 条目与 `docs/releases/v<版本>.md`（面向用户的更新说明，`release.yml` 强制存在），流程见 `.agents/skills/release/SKILL.md`（发版技能）。
- 纯重构与文档整理在 CHANGELOG 简记一行；结构变化跑 `pnpm tree` 重生成 `docs/STRUCTURE.md`。

| 主题 | 权威文件 |
|---|---|
| 红线、规范、流程、验证门禁（规则） | 本文件（AGENTS.md） |
| 架构、数据流、账本/折叠/统计口径事实 | `docs/ARCHITECTURE.md` |
| Remote 线路协议、偏好设置协议 | `docs/API.md` |
| 风格与统一写法 | `docs/STYLE.md` |
| 发布与交付 | `.agents/skills/release/SKILL.md`（技能） |
| 目录结构与文件职责 | `docs/STRUCTURE.md`（生成） |
| 用户视角：功能、安装、设置 | `README.md` |
| 版本历史 | `CHANGELOG.md` + `docs/releases/` |

## 11. 提交（Conventional Commits）
格式 `type(scope): subject`（`type` 英文 `feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert`，`scope` 可选 `client/host/build/docs/deps`，`subject` 中文小写无句号）；`body/footer` 中文，`BREAKING CHANGE:` 置脚注首行；一次提交一件事，禁 `wip/update`；提交前须过 §9 全项。

## 12. 交付物
仅陈述最终确定的规则/架构/协议/实现，不写入过程备注与待定方案；过程内容走会话记录，不入库。
