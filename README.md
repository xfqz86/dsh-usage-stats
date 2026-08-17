# dsh-usage-statistics — DSH 用量统计插件

DSH (DeepSeek Harness) 的 Web 持久化插件：把 **token 用量** 按 **模型/Provider**、
**会话**、**日期** 三个维度统计出来，挂在**侧边栏底部**（设置按钮旁）——
底部显示**今日统计**（宽列与 56px 折叠 rail 两种形态），点击弹出**模态窗**
查看详情（汇总、模型拆分、会话列表、每日趋势曲线与热力图）。不做费用换算 ——
只统计 token 与调用次数。

```
dsh-usage-statistics/
├── src/host/                    ← 服务端（Host，Node ESM）
│   ├── index.ts                 ← 入口：装配 store/监听/扫描/路由
│   ├── agg.ts                   ← 聚合口径与纯函数（Agg / ink / usable / modelKeyOf）
│   ├── logs.ts                  ← 会话日志的目录发现与 NDJSON 解析（解码走 persistence）
│   ├── store.ts                 ← UsageStore 内存聚合与折叠助手
│   ├── scan.ts                  ← 扫描编排（persistence.readRaw 优先 + harness 兜底 + 并行 worker）
│   ├── snapshot.ts              ← 快照 value 构建（汇总/模型/会话/按日序列）
│   ├── goquota.ts               ← OpenCode Go 额度查询（滚动5h/周/月 + TTL 缓存）
│   └── http.ts                  ← JSON API 的 HTTP 辅助与回环围栏
├── src/client/                  ← 浏览器端（Client）bundle
│   ├── index.ts                 ← 入口：注册 sidebar.footer.action
│   ├── UsageStatsFooter.tsx     ← 侧边栏底部今日统计按钮 + Go 额度芯片行（wide / rail 双模式）
│   ├── UsageStatsPanel.tsx      ← 模态窗详情，Tab 化：概览/日期/会话/模型/设置
│   ├── *.module.css             ← CSS Modules（与 harness 的 ui-sidebar 同款写法）
│   ├── useSnapshot.ts           ← 4s 轮询 /usage-stats/api/snapshot（含手动刷新）
│   ├── useGoQuota.ts            ← 60s 轮询 /usage-stats/api/go-quota（含手动刷新）
│   ├── stats.ts                 ← 纯函数：格式化/分桶/曲线/热力图几何
│   ├── locales.ts               ← zh/en 文案（LocaleNamespaceMap 类型安全）
│   └── css-modules.d.ts         ← *.module.css 的类型声明（harness 同款）
├── scripts/
│   └── css-modules-inline.mjs   ← 构建期把 .module.css 编译并内联进 bundle
├── lib/                         ← tsdown 构建产物（index.js / client.js）
├── cordis.patch.yml             ← 组合包 patch（dsh.bundle.patch）：插入插件条目
└── test/smoke.mjs               ← 服务端冒烟测试（mock cordis + 真实会话日志）
```

## 类型来源（npm @deepseek-ai 包，不手写镜像）

本插件的所有 harness 相关类型（`Context` / `ClientContext` / `SessionEvent` /
`TokenUsage` / `PropsRuntime` / `PropsLocale` / `Modal` / `Tooltip` / 服务接口）
**全部直接 import 自 npm 上的 `@deepseek-ai/*` 包**（`devDependencies`，版本
对齐 shell 冻结模块表的 `0.1.0-rc.7` / `4.0.1`），不写任何镜像类型。`tsconfig`
不设 paths 映射，TypeScript 直接从 `node_modules` 解析整张 .d.ts 闭包（peer
依赖由 pnpm 自动装齐）；打包时 `import type` 被剥离、运行时值导入走冻结模块表。
范式详见工作区根 `AGENTS.md`（红线条款）。

## 样式（CSS Modules）

样式与 harness 仓库一致：`*.module.css` + `import css from './X.module.css'`
（参考 `packages/client/ui-sidebar/` 的写法），颜色用设计 token
（`--dsw-alias-*` / `--dsw-shadow-*`）。独立插件 bundle 只能携带一个 JS 文件，
由 `scripts/css-modules-inline.mjs`（lightningcss）在构建时把 .module.css 编译
成 scoped 类名并**内联注入** `<style>`（按文件幂等），产物仍是单文件
`lib/client.js`。

## 统计口径

- **数据源**：`assistant/message` 事件，其 `data.usage.inputTokens` 为数字即计入。
- **total = input + output + cacheRead + cacheWrite**（reasoning 单列，不计入 total）。
- **按模型**：`data.message.source.provider` + `.model`（缺失记 `unknown`）。
- **按会话**：会话标题（`session/title` 事件）、cwd（`session` 事件顶层字段）、
  创建时间、最近活跃时间。

## 服务端（lib/index.js，Node cordis 插件）

1. 挂载后异步扫描全部会话日志，折叠用量：**按会话 + 按本地日 + 按模型/provider**。
2. **RAW 优先**：后端声明 `supportsRawArtifacts` 时，用
   `ctx.sessionPersistence.readRaw(id)` 直接拿解码后的原始 JSONL 文本折叠
   `assistant/message` 的 usage —— 解码是 harness 后端内的纯 JS zstd
   （`node:zlib`），**无 CLI 依赖**（曾用 `zstd` CLI，环境里可能没有安装，
   且 spawn 开销大）。会话 id 全集 = 磁盘目录遍历（`logs.ts`）∪ harness 清单。
3. **harness 兜底**：后端不支持原始工件 / `readRaw` 失败（例如仍在写入的
   尾部帧）时，回退到 `sessionQuery.readSession` / `sessionPersistence.readFrom(id, 0)`。
4. **实时增量**：`ctx.on('session/event')` 边扫边收，per-session `maxSeq`
   水位去重。
5. **自愈重扫**：每 60s 一次，防重入锁保证扫描不重叠。
6. **JSON API**：`POST /usage-stats/api/snapshot`，请求 `{ sessionId? }`，
   响应 `{ ok, value }`；`POST /usage-stats/api/go-quota` 返回 OpenCode Go
   订阅额度（滚动 5 小时 / 本周 / 本月用量百分比 + 重置时间，服务端 5 分钟
   TTL 缓存，key 自动发现：环境变量 `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY`
   → opencode CLI 登录态 `auth.json`）。只读聚合，**回环 Host 围栏**
   （防 DNS 重绑定/跨站探测）。

API 响应结构见 `src/client/useSnapshot.ts` 的 `UsageSnapshot` 类型：
`all`（总量）、`series.all`（按日序列）、`models[]`（模型拆分）、
`sessionsList[]`（会话明细）、`current`（请求带 sessionId 时）。

## 浏览器端（lib/client.js）

- **`sidebar.footer.action` 插槽**（注册形态参考 harness 的 `ui-cordis CordisPanel`）：
  - **宽列**：上方一排带"Go 额度"标签的 **OpenCode Go 额度芯片**（滚动 5h /
    本周 / 本月用量百分比，≥80% 预警、≥100% 超支，hover 显示重置时间）；
    下方 `icon + 今日 + 今日 tokens + 调用数`，扫描/缺会话时给出状态角标；
  - **56px rail 折叠**：纯圆形图标按钮上方显示**滚动 5 小时额度芯片**
    （两行：短标签 + 百分比，居中；tooltip 含三档窗口完整明细 + 重置时间），
    按钮 Tooltip 只放今日数字明细，不含 Go 额度；
  - 点击打开 **`Modal` 模态窗**（harness `@deepseek-ai/dsh-client-ui-primitives` 的
    `Modal` 组件：遮罩 + 居中卡片 + Escape/遮罩点击关闭 + `aria-modal`），
    宽 ≤800px、高 ≤78vh，内容区内部滚动。内容按 **Tab 划分**（语义化
    `role="tablist"`，图标 + 文字，与插件内 chip/seg 控件风格统一）：
    - **概览**：今日 tokens / 今日调用 / 总 tokens / 会话数 汇总网格 +
      **OpenCode Go 额度区**（三档进度条 + 百分比 + 重置时间）+ 扫描页脚；
    - **日期**：每日趋势（7D / 2周 / 1月 / 全部）的**曲线与热力图**切换
      （悬停 tooltip 显示当日明细）；
    - **会话**：按会话表（标题/cwd/最近活跃，默认 8 条可展开）；
    - **模型**：按模型/Provider 拆分表（输入/输出/缓存/总计 + 占比条）；
    - **设置**：手动刷新入口（立即重拉快照与 Go 额度，不等下个轮询周期）+
      偏好设置占位（后续参数扩展点）。
  - 每 4s 轮询快照、每 60s 轮询 Go 额度（服务端 5 分钟缓存，几乎不触达
    opencode.ai 官方端点），数据在角标、芯片与模态窗间共享；每次打开默认
    落在概览，Tab 内视图状态（日期范围/曲线视图/会话展开）切换时保留。

## 安装（标准 cordis.patch 模式）

本插件是标准的 cordis **组合包**：`package.json` 声明
`dsh.bundle.patch: ./cordis.patch.yml`，patch 把 `usage-statistics` 条目插入
profile 组合树（`lib/index.js` 挂载服务端、`lib/client.js` 由 `dsh.client`
声明注入浏览器端）。

装入 web profile（link 依赖，改代码即时生效）：

```bash
dsh plugin --profile web add "link:$(pwd)/dsh-usage-statistics"
# 等价于：在 ~/.dsh/profiles/web 下 pnpm add "link:..."
# 并保证 dsh.profile.bundles 含 "dsh-usage-statistics"（dsh plugin 自动对账）
```

移除：

```bash
dsh plugin --profile web remove dsh-usage-statistics
```

装完后**重启 dsh（web profile）生效**。验证 API：

```bash
curl -s -X POST http://127.0.0.1:3080/usage-stats/api/snapshot \
  -H 'content-type: application/json' -d '{}'
```

## 开发

```bash
pnpm install            # 安装 devDependencies（@deepseek-ai/* 类型来自 npm）
pnpm build              # lib/index.js + lib/client.js
pnpm watch              # 增量构建
npx tsc --noEmit        # 类型检查（TS5 + @types/node@22 + @types/react）
node test/smoke.mjs     # 服务端冒烟测试（mock cordis 服务 + 真实会话日志）
node test/client-bundle.mjs  # 浏览器端 bundle 冒烟（模拟 __ModuleLoader__ + document，验证 CSS 内联注入）
```

## License

MIT