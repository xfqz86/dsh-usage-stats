# 项目结构（自动生成）

> 由 `scripts/gen-tree.mjs` 生成；改动代码结构后运行 `pnpm tree` 重新生成，
> 请勿手改本文件。每行职责取自对应代码文件的头部块注释的首句；
> 非代码文件走固定备注。

```
dsh-usage-stats/
├── .github/
│   ├── actions/
│   │   ├── gate/
│   │   │   ├── action.yml ← Gate 复合动作（gate-ci）：校验指定 SHA 的 CI job 是否已成功（release 发布前强制验证）
│   │   │   └── gate.mjs ← Gate — 校验指定 SHA 的 CI job 是否已成功（仅供 GitHub Action 使用） 通过 REST API 查询 check-runs，匹配 job 名（支持 "verify" 与 "CI / verify"）。
│   │   ├── prune-package/
│   │   │   ├── action.yml ← 剪枝复合动作：把 package.json 剪到发布所需最小字段白名单
│   │   │   └── prune.mjs ← 剪枝 package.json 至发布所需最小字段集合
│   │   ├── setup/
│   │   │   └── action.yml ← 统一 JS 环境复合动作：pnpm + Node（缓存 pnpm）+ 依赖安装
│   │   └── verify-pack/
│   │       ├── action.yml ← 校验复合动作：交付物仅含白名单文件且 package.json 已剪枝
│   │       └── verify.mjs ← 校验交付物仅含 7 文件且 package.json 已剪枝（仅供 GitHub Action 使用） 支持 tarball (.tgz) 与 payload 目录两种形态，path/allow 均由 action.yml 传入。
│   └── workflows/
│       ├── ci.yml ← CI：类型检查 / 构建 / 冒烟测试（每次 PR 与推送 dev/main 执行）
│       ├── release-branch.yml ← 同步 release 分支：仅含预构建交付物的最小形态（GitHub 安装路径）
│       └── release.yml ← 发布到 npm 与交付 tarball（GitHub Release 附件 + workflow artifact）
├── docs/
│   ├── releases/
│   │   └── v0.3.0.md
│   ├── screenshot/
│   │   ├── 01-overview.png
│   │   ├── 02-dates.png
│   │   ├── 03-sessions.png
│   │   ├── 04-models.png
│   │   ├── 05-settings.png
│   │   └── footer.png
│   ├── API.md ← 服务端 HTTP 协议与偏好设置约定（随接口演进维护）
│   ├── PUBLISH.md ← 发布流程（GitHub Actions 交付三种形态：release / npm / tarball）
│   ├── STRUCTURE.md ← 生成文件：由 `pnpm tree` 重新生成，勿手改
│   └── STYLE.md ← 风格经验沉淀（lint 之外的统一约定，新会话先读）
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
│   │   │   ├── SettingsSwitch.module.css ← 设置 Tab 的开关控件（SettingsSwitch，role="switch"）：off 用描边色填充， on 用成功绿，滑块用前景色（token 配色，深色模式随之翻转）。
│   │   │   ├── SettingsSwitch.tsx ← 设置 Tab 的开关控件（role="switch"）。
│   │   │   ├── StackedBar.module.css ← 统一堆叠柱状图（StackedBar）：合并 DateStackedBar / ModelStackedBar 及原 StackedBarCommon 的公共壳样式。
│   │   │   ├── StackedBar.tsx ← 统一堆叠柱状图 StackedBar，合并 DateStackedBar 与 ModelStackedBar 为单一组件。
│   │   │   ├── ThSortable.module.css ← 可排序表头按钮（ThSortable）：整列可点击，右对齐数值列，首列左对齐。
│   │   │   ├── ThSortable.tsx ← 通用可排序表头（ThSortable）：点击切换排序方向的 <th> 单元格。
│   │   │   ├── Tooltip.module.css ← 自实现 Tooltip：视觉完全复刻 dsh 自带的 Tooltip.module.css（size m、无箭头）。
│   │   │   ├── Tooltip.tsx ← 富内容 Tooltip：基座 `@deepseek-ai/dsh-client-ui-primitives` 的 Tooltip 当前只接受纯文本（`label: string | (() => string)`，0.1.5-rc.2 仍未变）， 而本插件的额度明细、热力图单元格与比例条需要多行排版，故在此保留一个 只做富内容的扩展版：定位、视口自适应、hover/focus 双触发、delay、disabled、 maxWidth、ref 转发与视觉 token 全部复刻基座实现，仅新增—— - `content` 插槽接受任意 React 节点或惰性求值函数，气泡容器由 span 改为 div 以支持块级排版，内容为富组件时包一层 `.rich` 重置 white-space； - `follow` 让气泡水平跟随鼠标，用于比例条这类横向细长锚点。
│   │   │   ├── UsageStatsCommon.module.css ← 用量统计模态窗内跨组件共用的样式基元：分区头、统计磁贴/单元格、空态、 表格、通用提示等。
│   │   │   ├── ZaiNoPlan.module.css ← Z.ai 未开通空态：图标徽标 + 短文案，磁贴浅底与 tooltip 深底共用同一版式。
│   │   │   └── ZaiNoPlan.tsx ← Z.ai 未开通空态：品牌色图标徽标配短文案，概览磁贴与侧边栏 tooltip 共用。
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
│   │   │   ├── SettingsTab.tsx ← 设置 Tab：偏好设置，含 DeepSeek 余额、OpenCode Go 额度与 Z.ai 额度监控各三项，账本操作折叠内含清零与重建，底部页脚含事件数与更新时间。
│   │   │   ├── UsageHeatmap.module.css ← 概览 Tab 的 26 周热力图网格（UsageHeatmap）：Codex 风格列布局、4 档强度、 月份标签、今日外框高亮。
│   │   │   ├── UsageHeatmap.tsx ← 概览 Tab 的 26 周热力图：Codex 风格网格，列为周、行为周一至周日， 含 4 档强度、月份标签与今日高亮。
│   │   │   ├── UsageStatsFooter.module.css ← 侧边栏底部动作层，支持宽列与 56px rail 两种形态，几何与 harness 的 CordisPanel 侧边栏底部动作一致；颜色全部使用设计 token。
│   │   │   ├── UsageStatsFooter.tsx ← 用量统计的侧边栏底部动作：渲染在 `sidebar.footer.action` 列表插槽设置按钮上方的今日统计触发器。
│   │   │   ├── UsageStatsPanel.module.css ← 用量统计模态窗壳 UsageStatsPanel：headless Modal 卡片内的 chrome —— 头部、Tab 栏、可滚动内容区。
│   │   │   └── UsageStatsPanel.tsx ← 用量统计的详情视图：侧边栏底部按钮打开的居中模态窗，采用 Tab 化布局。
│   │   ├── api.ts ← usageStats 命名空间的浏览器端调用约定。
│   │   ├── index.ts ← 用量统计的浏览器端入口：侧边栏底部动作，包含今日统计角标与模态窗详情。
│   │   ├── locales.ts ← 用量统计界面文案字典，类型化写法与 harness 的 ui-cordis 命名空间一致。
│   │   ├── remote.ts ← usageStats 命名空间的浏览器端挂载与调用入口。
│   │   ├── settings.ts ← 浏览器端插件偏好存储：绑定服务端注册的 `usage-stats` 设置命名空间。
│   │   ├── stats.ts ← 用量统计界面的纯函数：格式化、分桶、曲线与热力图几何。
│   │   ├── useConfirmOp.ts ← 二次确认操作 hook（浏览器端）。
│   │   ├── useIntervalText.ts ← 抓取间隔输入 hook（浏览器端）。
│   │   ├── useQuota.ts ← 额度轮询 hooks（浏览器端）：共享轮询骨架 useQuota + Go/DeepSeek/Z.ai 三路薄包装。
│   │   ├── useSnapshot.ts ← 用量统计浏览器端（Client）的快照轮询。
│   │   ├── useSortTable.ts ← 表格排序分页三件套（浏览器端）。
│   │   └── useUsageSettings.ts ← 偏好设置的 React hook（浏览器端）。
│   ├── host/
│   │   ├── agg.ts ← 聚合口径与纯函数：Agg、SessionInfo 结构，折叠原子操作 newAgg、ink， 事件守卫 usable、modelKeyOf。
│   │   ├── deepseekBalance.ts ← DeepSeek 余额查询：通过 `GET https://api.deepseek.com/user/balance` 获取当前余额。
│   │   ├── goquota.ts ← OpenCode Go 订阅额度查询：滚动 5 小时 / 本周 / 本月三档用量百分比 与重置时间，端点为 `GET https://opencode.ai/zen/go/v1/usage`。
│   │   ├── index.ts ← 用量统计的服务端 Host 插件入口：default 导出服务类，由 Loader 实例化。
│   │   ├── ledger.ts ← 原始事件流账本 Ledger：用量事件的唯一事实来源 —— 自管理 SQLite。
│   │   ├── logs.ts ← 会话日志的目录发现与 NDJSON 解析。
│   │   ├── quota.ts ← 额度查询共享基元（服务端）：浏览器 UA、key 回退解析、TTL 缓存单飞工厂。
│   │   ├── rawlog.ts ← 会话原始日志的物理代次识别与多帧 zstd 解码：扫描拼接 zstd 帧边界后逐帧解压为 NDJSON 文本，供扫描链路在 harness 读取失败时兜底读取旧代次会话。
│   │   ├── scan.ts ← 会话扫描编排，账本导入：把磁盘原始日志 ∪ harness 会话清单的会话 id 全集逐会话读取，经 foldRecord 写入账本（events、session_meta 共 9 表， 含 agg_* 预统计）并折叠聚合缓存。
│   │   ├── service.ts ← 用量统计的服务端 Host 服务：账本模式装配，自管理 sqlite 介质，对外暴露 usageStats 命名空间的 7 个一元 Remote 方法。
│   │   ├── settings.ts ← 服务端（Host）的插件偏好设置：把 `usage-stats` 命名空间注册进 harness 的 用户设置体系（ctx.settings，由 dsh-settings-file 落到 `$DSH_HOME/settings.yaml`）， 偏好因此属于部署而不是某一个浏览器。
│   │   ├── snapshot.ts ← 快照构建：把聚合缓存 UsageStore 与账本会话元数据整理成 usageStats/snapshot 的结果 value，不触碰传输层与 ctx。
│   │   ├── store.ts ← 内存聚合缓存：由账本事件流折叠而来的派生统计，按天、会话、模型、模型×日、全量维度组织。
│   │   └── zaiQuota.ts ← Z.ai 智谱额度查询：滚动 5 小时、每周 7 天百分比与每月 Web 搜索次数，端点为 GET https://api.z.ai/api/monitor/usage/quota/limit。
│   ├── remote/
│   │   └── contribution.ts ← usageStats 命名空间的手写严格 Remote 贡献。
│   ├── css-modules.d.ts ← CSS Modules 的类型声明（与 harness 的 ui-primitives 同款）： `import css from './X.module.css'` 得到 scoped 类名映射。
│   ├── types.ts ← 跨端共用的协议类型，host 与 client 两个 bundle 各自内联所需子集。
│   └── utils.ts ← 跨端共用的纯函数与共享常量，host 与 client 两个 bundle 各自内联所需子集。
├── test/
│   ├── client-bundle.mjs ← 浏览器端 bundle 冒烟测试（模拟 window.__ModuleLoader__ + document）。
│   ├── pure.mjs ← 纯函数与额度解析的单测（node:test + 类型剥离直引源码）。
│   ├── session-events.jsonl
│   ├── smoke.mjs ← 用量统计服务端 Remote 方法的独立冒烟测试（账本模式，自管理 sqlite 介质）。
│   └── styles.mjs ← 样式契约单测：本插件全部 *.module.css 只允许引用 dsh 主题真实声明的设计变量。
├── .gitignore ← git 忽略规则（不入库清单：产物 / 锁目录 / 本机私有）
├── AGENTS.md ← 工程规范（注入的规则文件；仅规则变化时改，结构现状不进这里）
├── CHANGELOG.md ← 更新日志（每次发版同步记录功能更新与 Bug 修复）
├── cordis.patch.yml ← 组合包 patch（dsh.bundle.patch）：插入插件条目
├── eslint.config.mjs ← @fileoverview ESLint flat config — Google TypeScript Style Guide 落地 覆盖 host（Node ESM）/ client（Browser CJS）/ scripts（Node ESM mjs）三类环境， 基于 eslint 9 + typescript-eslint 8 + eslint-plugin-import-x + @stylistic。
├── LICENSE
├── package.json ← 组合包元数据 / exports / 构建脚本
├── pnpm-lock.yaml ← 锁文件（不手改）
├── pnpm-workspace.yaml ← pnpm 工作区（含版本保鲜期白名单）
├── README.md ← 面向普通用户的功能说明
├── screenshots.json
├── tsconfig.json ← TS 编译配置（严格模式）
└── tsdown.config.ts ← 双 bundle 构建配置（host ESM + client CJS）
```
