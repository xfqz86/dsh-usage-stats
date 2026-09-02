# 项目结构（自动生成）

> 由 `scripts/gen-tree.mjs` 生成；改动代码结构后运行 `pnpm tree` 重新生成，
> 请勿手改本文件。每行职责取自对应代码文件的头部块注释的首句；
> 非代码文件走固定备注。

```
dsh-usage-stats/
├── docs/
│   ├── screenshot/
│   │   ├── 01-overview.png
│   │   ├── 02-dates.png
│   │   ├── 03-sessions.png
│   │   ├── 04-models.png
│   │   ├── 05-settings.png
│   │   └── footer.png
│   ├── API.md ← 服务端 HTTP 协议与偏好设置约定（随接口演进维护）
│   ├── PUBLISH.md ← 发布流程（GitHub Actions 交付三种形态：release / npm / tarball）
│   └── STRUCTURE.md ← 生成文件：由 `pnpm tree` 重新生成，勿手改
├── scripts/
│   ├── css-modules-inline.mjs ← rolldown 插件：把 *.module.css 编译成「scoped 类名映射 + 样式内联注入」的 JS 模块。
│   └── gen-tree.mjs ← 生成 docs/STRUCTURE.md：反射仓库真实结构，避免目录树手写漂移。
├── src/
│   ├── client/
│   │   ├── components/
│   │   │   ├── ModelPieChart.module.css ← 模型饼图（ModelPieChart）：占比饼图 + 图例，纯 SVG，无外部依赖。
│   │   │   ├── ModelPieChart.tsx ← 模型饼图 ModelPieChart：按模型占比的饼图，纯 SVG。
│   │   │   ├── Pagination.module.css ← 通用分页（Pagination）：居中分页条
│   │   │   ├── Pagination.tsx ← 通用分页（Pagination）：上一页 / 页码信息 / 下一页。
│   │   │   ├── SettingsSwitch.module.css ← 设置 Tab 的开关控件（SettingsSwitch，role="switch"）：off 用填充灰， on 用成功绿（token 配色）。
│   │   │   ├── SettingsSwitch.tsx ← 设置 Tab 的开关控件（role="switch"）。
│   │   │   ├── StackedBar.module.css ← 统一堆叠柱状图（StackedBar）：合并 DateStackedBar / ModelStackedBar 及原 StackedBarCommon 的公共壳样式。
│   │   │   ├── StackedBar.tsx ← 统一堆叠柱状图 StackedBar，合并 DateStackedBar 与 ModelStackedBar 为单一组件。
│   │   │   ├── ThSortable.module.css ← 可排序表头按钮（ThSortable）：整列可点击，右对齐数值列，首列左对齐。
│   │   │   ├── ThSortable.tsx ← 通用可排序表头（ThSortable）：点击切换排序方向的 <th> 单元格。
│   │   │   ├── Tooltip.module.css ← 自实现 Tooltip：视觉完全复刻 dsh 自带的 Tooltip.module.css（size m、无箭头）。
│   │   │   ├── Tooltip.tsx ← 自实现的 Tooltip：基于 dsh 自带 `@deepseek-ai/dsh-client-ui-primitives/Tooltip` 的轻量修改版， 并已合并原 `FollowTooltip` 的鼠标跟随能力，通过 `follow` 参数控制。
│   │   │   └── UsageStatsCommon.module.css ← 用量统计模态窗内跨组件共用的样式基元：分区头、统计磁贴/单元格、空态、 表格、通用提示等。
│   │   ├── views/
│   │   │   ├── DatesTab.module.css ← 日期 Tab DatesTab：堆叠柱状图 + 范围 chips + 数据表格，与模型 Tab 对齐。
│   │   │   ├── DatesTab.tsx ← 日期 Tab：堆叠柱状图、范围切换与数据表格，与模型、会话 Tab 对齐。
│   │   │   ├── HeroTile.module.css ← 英雄磁贴 HeroTile：今日与总 tokens 共用的合并磁贴样式。
│   │   │   ├── HeroTile.tsx ← 英雄磁贴 HeroTile，今日与总 tokens 共用的合并磁贴。
│   │   │   ├── ModelsTab.module.css ← 模型 Tab（ModelsTab）：与会话 Tab 对齐的表格容器（表格样式在共用基元里）。
│   │   │   ├── ModelsTab.tsx ← 模型 Tab：按模型/Provider 拆分表，含占比条，布局与会话 Tab 对齐。
│   │   │   ├── OverviewTab.module.css ← 概览 Tab OverviewTab：Bento 磁贴网格 — 布局见布局图：今日/总计左列，热力图右大区，底行 DeepSeek/Go。
│   │   │   ├── OverviewTab.tsx ← 概览 Tab，Bento 磁贴网格，包含「今日」与「总计」英雄磁贴，左列上下两格， 右大区为「热力图」占 3 列 2 行，底行含「DeepSeek 余额」、「OpenCode Go 额度」与「Z.ai 额度」， 各卡片受监控开关控制，未启用时隐藏，布局严格按布局图分区，使用 grid-template-areas，独立成文件。
│   │   │   ├── SessionsTab.module.css ← 会话 Tab SessionsTab：主会话折叠按钮、子行与徽标、横向滚动容器，表格样式在共用基元里。
│   │   │   ├── SessionsTab.tsx ← 会话 Tab：按会话表分页展示，每页 20 条，子代理折叠到主会话，带加号展开，数据完整展示。
│   │   │   ├── SettingsTab.module.css ← 设置 Tab SettingsTab：操作按钮含重建账本状态、偏好设置行、 抓取间隔数字输入、可折叠账本操作与底部页脚。
│   │   │   ├── SettingsTab.tsx ← 设置 Tab：偏好设置，含 OpenCode Go 额度、DeepSeek 余额与 Z.ai 额度监控各三项，账本操作折叠内含清零与重建，底部页脚含事件数与更新时间。
│   │   │   ├── UsageHeatmap.module.css ← 概览 Tab 的 26 周热力图网格（UsageHeatmap）：Codex 风格列布局、4 档强度、 月份标签、今日外框高亮。
│   │   │   ├── UsageHeatmap.tsx ← 概览 Tab 的 26 周热力图：Codex 风格网格，列为周、行为周一至周日， 含 4 档强度、月份标签与今日高亮。
│   │   │   ├── UsageStatsFooter.module.css ← 侧边栏底部动作层，支持宽列与 56px rail 两种形态，几何与 harness 的 CordisPanel 侧边栏底部动作一致；颜色全部使用设计 token。
│   │   │   ├── UsageStatsFooter.tsx ← 用量统计的侧边栏底部动作：渲染在 `sidebar.footer.action` 列表插槽设置按钮上方的今日统计触发器。
│   │   │   ├── UsageStatsPanel.module.css ← 用量统计模态窗壳 UsageStatsPanel：headless Modal 卡片内的 chrome —— 头部、Tab 栏、可滚动内容区。
│   │   │   └── UsageStatsPanel.tsx ← 用量统计的详情视图：侧边栏底部按钮打开的居中模态窗，采用 Tab 化布局。
│   │   ├── api.ts ← /usage-stats/api/* 的浏览器端调用约定：全部 POST 必须携带的请求头。
│   │   ├── index.ts ← 用量统计的浏览器端入口：侧边栏底部动作，包含今日统计角标与模态窗详情。
│   │   ├── locales.ts ← 用量统计界面文案字典，类型化写法与 harness 的 ui-cordis 命名空间一致。
│   │   ├── settings.ts ← 浏览器端插件偏好设置：OpenCode Go 额度与 DeepSeek 余额监控的偏好设置。
│   │   ├── stats.ts ← 用量统计界面的纯函数：格式化、分桶、曲线与热力图几何。
│   │   ├── useDeepSeekBalance.ts ← DeepSeek 余额轮询，浏览器端。
│   │   ├── useGoQuota.ts ← OpenCode Go 订阅额度轮询，浏览器端实现。
│   │   ├── useGoSettings.ts ← 偏好设置的 React hook（浏览器端）。
│   │   ├── useSnapshot.ts ← 用量统计浏览器端（Client）的快照轮询。
│   │   └── useZaiQuota.ts ← Z.ai 额度轮询，浏览器端实现。
│   ├── host/
│   │   ├── agg.ts ← 聚合口径与纯函数：Agg、SessionInfo 结构，折叠原子操作 newAgg、ink， 事件守卫 usable、modelKeyOf。
│   │   ├── deepseekBalance.ts ← DeepSeek 余额查询：通过 `GET https://api.deepseek.com/user/balance` 获取当前余额。
│   │   ├── goquota.ts ← OpenCode Go 订阅额度查询：滚动 5 小时 / 本周 / 本月三档用量百分比 与重置时间，端点为 `GET https://opencode.ai/zen/go/v1/usage`。
│   │   ├── http.ts ← JSON API 的 HTTP 辅助：请求体读取、JSON 响应写出、回环信任围栏与 CSRF 自定义头围栏。
│   │   ├── index.ts ← 用量统计的服务端 Host 插件入口：账本模式装配，自管理 sqlite 介质。
│   │   ├── ledger.ts ← 原始事件流账本 Ledger：用量事件的唯一事实来源 —— 自管理 SQLite。
│   │   ├── logs.ts ← 会话日志的目录发现与 NDJSON 解析。
│   │   ├── scan.ts ← 会话扫描编排，账本导入：把磁盘原始日志 ∪ harness 会话清单的会话 id 全集逐会话读取，经 foldRecord 写入账本，自管理 sqlite 的 events、 session_meta 表并折叠聚合缓存。
│   │   ├── snapshot.ts ← 快照构建：把聚合缓存 UsageStore 与账本会话元数据整理成 /usage-stats/api/snapshot 的响应 value，纯函数，不触碰 HTTP、ctx。
│   │   ├── store.ts ← 内存聚合缓存：由账本事件流折叠而来的派生统计，按天、会话、模型、全量维度组织。
│   │   └── zaiQuota.ts ← Z.ai 智谱额度查询：滚动 5 小时、每周 7 天百分比与每月 Web 搜索次数，端点为 GET https://api.z.ai/api/monitor/usage/quota/limit。
│   ├── css-modules.d.ts ← CSS Modules 的类型声明（与 harness 的 ui-primitives 同款）： `import css from './X.module.css'` 得到 scoped 类名映射。
│   ├── types.ts ← 跨端共用的协议类型，host 与 client 两个 bundle 各自内联所需子集。
│   └── utils.ts ← 跨端共用的纯函数，host 与 client 两个 bundle 各自内联所需子集。
├── test/
│   ├── client-bundle.mjs ← 浏览器端 bundle 冒烟测试（模拟 window.__ModuleLoader__ + document）。
│   ├── session-events.jsonl
│   └── smoke.mjs ← 用量统计服务端（Host）的独立冒烟测试（账本模式，自管理 sqlite 介质）。
├── AGENTS.md ← 工程规范（注入的规则文件；仅规则变化时改，结构现状不进这里）
├── cordis.patch.yml ← 组合包 patch（dsh.bundle.patch）：插入插件条目
├── eslint.config.mjs ← @fileoverview ESLint flat config — Google TypeScript Style Guide 落地 覆盖 host（Node ESM）/ client（Browser CJS）/ scripts（Node ESM mjs）三类环境， 基于 eslint 9 + typescript-eslint 8 + eslint-plugin-import-x + @stylistic。
├── LICENSE
├── package.json ← 组合包元数据 / exports / 构建脚本
├── pnpm-lock.yaml ← 锁文件（不手改）
├── pnpm-workspace.yaml ← pnpm 工作区（含版本保鲜期白名单）
├── README.md ← 面向普通用户的功能说明
├── tsconfig.json ← TS 编译配置（严格模式）
└── tsdown.config.ts ← 双 bundle 构建配置（host ESM + client CJS）
```
