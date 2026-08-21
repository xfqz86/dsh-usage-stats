# 项目结构（自动生成）

> 由 `scripts/gen-tree.mjs` 生成；改动代码结构后运行 `pnpm tree` 重新生成，
> 请勿手改本文件。每行职责取自对应代码文件的头部块注释的首句；
> 非代码文件走固定备注。

```
dsh-usage-stats/
├── docs/
│   ├── API.md ← 服务端 HTTP 协议与偏好设置约定（随接口演进维护）
│   └── STRUCTURE.md ← 生成文件：由 `pnpm tree` 重新生成，勿手改
├── scripts/
│   ├── css-modules-inline.mjs ← rolldown 插件：把 *.module.css 编译成「scoped 类名映射 + 样式内联注入」的 JS 模块。
│   └── gen-tree.mjs ← 生成 docs/STRUCTURE.md：反射仓库真实结构，避免目录树手写漂移。
├── src/
│   ├── client/
│   │   ├── components/
│   │   │   ├── DatesTab.module.css ← 日期 Tab（DatesTab）：每日趋势曲线（SVG）+ 时间范围切换 chips + 悬停 tooltip。
│   │   │   ├── DatesTab.tsx ← 日期 Tab：每日趋势曲线 + 时间范围切换，悬停 tooltip 显示当日明细。
│   │   │   ├── FollowTooltip.module.css ← 鼠标跟随 Tooltip（FollowTooltip）：复刻 primitives Tooltip 的视觉 （dark plate、white text、size m 无箭头），仅定位逻辑不同——水平跟随鼠标。
│   │   │   ├── FollowTooltip.tsx ← 鼠标跟随的 Tooltip：用于三色比例条等宽条形锚点。
│   │   │   ├── HeroTile.module.css ← 英雄磁贴（HeroTile）：今日 / 总 tokens 共用的合并磁贴样式。
│   │   │   ├── HeroTile.tsx ← 英雄磁贴（HeroTile）：今日 / 总 tokens 共用的合并磁贴。
│   │   │   ├── ModelsTab.module.css ← 模型 Tab（ModelsTab）：占总比条形图（表格样式在共用基元里）。
│   │   │   ├── ModelsTab.tsx ← 模型 Tab：按模型/Provider 拆分表（含占比条）。
│   │   │   ├── OverviewTab.module.css ← 概览 Tab（OverviewTab）：Bento 磁贴网格、Go 额度磁贴（纵向三档窗口 + 标题刷新按钮）、扫描页脚。
│   │   │   ├── OverviewTab.tsx ← 概览 Tab（Bento 磁贴网格）：「今日」+「总计」英雄磁贴 （共用 HeroTile，各 2 列，等宽，均含三色比例条、命中率与调用； 总计标题右侧附会话数）+ OpenCode Go 额度磁贴（窄列，纵向堆叠三档 窗口进度，标题右侧带立即刷新按钮）+ 26 周热力磁贴（宽列）+ 扫描页脚。
│   │   │   ├── SessionsTab.module.css ← 会话 Tab（SessionsTab）：展开/收起切换链接（表格样式在共用基元里）。
│   │   │   ├── SessionsTab.tsx ← 会话 Tab：按会话表（标题/cwd/最近活跃，默认 8 条可展开）。
│   │   │   ├── SettingsSwitch.module.css ← 设置 Tab 的开关控件（SettingsSwitch，role="switch"）：off 用填充灰， on 用成功绿（token 配色）。
│   │   │   ├── SettingsSwitch.tsx ← 设置 Tab 的开关控件（role="switch"）。
│   │   │   ├── SettingsTab.module.css ← 设置 Tab（SettingsTab）：操作按钮（含重建账本状态）、偏好设置行、 抓取间隔数字输入。
│   │   │   ├── SettingsTab.tsx ← 设置 Tab：偏好设置（OpenCode Go 抓取相关三项）+ 重建账本（最底部， 危险操作，点击后需二次确认：RiskConfirmation 复选「我已了解」+ 确认）。
│   │   │   ├── UsageHeatmap.module.css ← 概览 Tab 的 26 周热力图网格（UsageHeatmap）：Codex 风格列布局、4 档强度、 月份标签、今日外框高亮。
│   │   │   ├── UsageHeatmap.tsx ← 概览 Tab 的 26 周热力图：Codex 风格网格（列 = 周，行 = 周一..周日， 4 档强度 + 月份标签 + 今日高亮）。
│   │   │   ├── UsageStatsCommon.module.css ← 用量统计模态窗内跨组件共用的样式基元：分区头、统计磁贴/单元格、空态、 表格、通用提示等。
│   │   │   ├── UsageStatsFooter.module.css ← 侧边栏底部动作层（宽列与 56px rail 两种形态），几何与 harness 的 CordisPanel 侧边栏底部动作一致；颜色全部使用设计 token。
│   │   │   ├── UsageStatsFooter.tsx ← 用量统计的侧边栏底部动作：渲染在 `sidebar.footer.action` 列表插槽 （设置按钮上方）的今日统计触发器。
│   │   │   ├── UsageStatsPanel.module.css ← 用量统计模态窗壳（UsageStatsPanel）：headless Modal 卡片内的 chrome —— 头部、Tab 栏、可滚动内容区。
│   │   │   └── UsageStatsPanel.tsx ← 用量统计的详情视图：侧边栏底部按钮打开的居中模态窗（Tab 化）。
│   │   ├── index.ts ← 用量统计的浏览器端入口：侧边栏底部动作（今日统计角标）+ 模态窗详情。
│   │   ├── locales.ts ← 用量统计界面文案字典，类型化写法与 harness 的 ui-cordis 命名空间一致。
│   │   ├── settings.ts ← 插件偏好设置（浏览器端）：当前是 OpenCode Go 抓取相关三项设置。
│   │   ├── stats.ts ← 用量统计界面的纯函数：格式化、分桶、曲线与热力图几何。
│   │   ├── useGoQuota.ts ← OpenCode Go 订阅额度轮询（浏览器端）。
│   │   ├── useGoSettings.ts ← 偏好设置的 React hook（浏览器端）。
│   │   └── useSnapshot.ts ← 用量统计浏览器端（Client）的快照轮询。
│   ├── host/
│   │   ├── agg.ts ← 聚合口径与纯函数：Agg / SessionInfo 结构、折叠原子操作（newAgg / ink）、 事件守卫（usable / modelKeyOf）。
│   │   ├── goquota.ts ← OpenCode Go 订阅额度查询：滚动 5 小时 / 本周 / 本月三档用量百分比 与重置时间（`GET https://opencode.ai/zen/go/v1/usage`）。
│   │   ├── http.ts ← JSON API 的 HTTP 辅助：请求体读取、JSON 响应写出、回环信任围栏。
│   │   ├── index.ts ← 用量统计的服务端（Host）插件入口：账本模式装配（自管理 sqlite 介质）。
│   │   ├── ledger.ts ← 原始事件流账本（Ledger）：用量事件的唯一事实来源 —— 自管理 SQLite。
│   │   ├── logs.ts ← 会话日志的目录发现与 NDJSON 解析。
│   │   ├── scan.ts ← 会话扫描编排（账本导入）：把磁盘原始日志 ∪ harness 会话清单的会话 id 全集逐会话读取，经 foldRecord 写入账本（自管理 sqlite 的 events / session_meta 表）并折叠聚合缓存。
│   │   ├── snapshot.ts ← 快照构建：把聚合缓存（UsageStore）+ 账本会话元数据整理成 /usage-stats/api/snapshot 的响应 value（纯函数，不触碰 HTTP / ctx）。
│   │   └── store.ts ← 内存聚合缓存：由账本事件流折叠而来的派生统计（按天 / 会话 / 模型 / 全量）。
│   ├── css-modules.d.ts ← CSS Modules 的类型声明（与 harness 的 ui-primitives 同款）： `import css from './X.module.css'` 得到 scoped 类名映射。
│   ├── types.ts ← 跨端共用的协议类型（host 与 client 两个 bundle 各自内联所需子集）。
│   └── utils.ts ← 跨端共用的纯函数（host 与 client 两个 bundle 各自内联所需子集）。
├── test/
│   ├── client-bundle.mjs ← 浏览器端 bundle 冒烟测试（模拟 window.__ModuleLoader__ + document）。
│   ├── session-events.jsonl
│   └── smoke.mjs ← 用量统计服务端（Host）的独立冒烟测试（账本模式，自管理 sqlite 介质）。
├── AGENTS.md ← 工程规范（注入的规则文件；仅规则变化时改，结构现状不进这里）
├── cordis.patch.yml ← 组合包 patch（dsh.bundle.patch）：插入插件条目
├── package.json ← 组合包元数据 / exports / 构建脚本
├── pnpm-lock.yaml ← 锁文件（不手改）
├── pnpm-workspace.yaml ← pnpm 工作区（含版本保鲜期白名单）
├── README.md ← 面向普通用户的功能说明
├── tsconfig.json ← TS 编译配置（严格模式）
└── tsdown.config.ts ← 双 bundle 构建配置（host ESM + client CJS）
```
