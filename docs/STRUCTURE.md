# 项目结构（自动生成）

> 由 `scripts/gen-tree.mjs` 生成；改动代码结构后运行 `pnpm tree` 重新生成，
> 请勿手改本文件。每行职责取自对应代码文件的头部块注释的首句；
> 非代码文件走固定备注。

```
dsh-usage-stats/
├── .agents/
│   └── skills/
│       └── release/
│           ├── scripts/
│           │   ├── release-preflight.mjs ← 发版前置检查：只读校验发版三处（package.json 版本、CHANGELOG 条目、更新说明文件）是否已同批就位。
│           │   └── verify-release.mjs ← 发布形态验证：生产构建 → 打真 tarball → 校验包内容与 Remote 方法签名 → 还原开发态构建。
│           └── SKILL.md ← 发版技能：发布与交付的唯一权威（交付形态 / 发版步骤 / 门禁 / npm 认证）
├── .github/
│   ├── actions/
│   │   ├── gate/
│   │   │   ├── action.yml ← Gate 复合动作（gate-ci）：校验指定 SHA 的 CI job 是否已成功（release 发布前强制验证）
│   │   │   └── gate.mjs ← Gate — 校验指定 SHA 的 CI job 是否已成功（仅供 GitHub Action 使用） 通过 REST API 查询 check-runs，匹配 job 名（支持 "verify" 与 "CI / verify"）。
│   │   ├── prune-package/
│   │   │   ├── action.yml ← 剪枝复合动作：把 package.json 剪到发布所需最小字段白名单
│   │   │   └── prune.mjs ← 剪枝 package.json 至发布所需最小字段集合。
│   │   ├── setup/
│   │   │   └── action.yml ← 统一 JS 环境复合动作：pnpm + Node（缓存 pnpm）+ 依赖安装
│   │   └── verify-pack/
│   │       ├── action.yml ← 校验复合动作：交付物仅含白名单文件且 package.json 已剪枝
│   │       └── verify.mjs ← 校验交付物仅含 7 文件且 package.json 已剪枝（仅供 GitHub Action 使用） 支持 tarball (.tgz) 与 payload 目录两种形态，path/allow 均由 action.yml 传入。
│   └── workflows/
│       ├── ci.yml ← CI：类型检查 / 生产态构建 / 样式与冒烟测试 / 打包校验（每次 PR、推送 dev/main 与手动触发执行）
│       ├── release-branch.yml ← 同步 release 分支：仅含预构建交付物的最小形态（GitHub 安装路径）
│       └── release.yml ← 发布到 npm 与交付 tarball（GitHub Release 附件只附固定别名；版本化产物走 workflow artifact）
├── docs/
│   ├── releases/
│   │   ├── v0.1.0.md
│   │   ├── v0.1.1.md
│   │   ├── v0.2.0.md
│   │   ├── v0.2.1.md
│   │   ├── v0.3.0.md
│   │   ├── v0.4.0.md
│   │   ├── v0.4.1.md
│   │   ├── v0.4.2.md
│   │   ├── v0.4.3.md
│   │   ├── v0.4.4.md
│   │   ├── v0.4.5.md
│   │   ├── v0.4.6.md
│   │   ├── v0.4.7.md
│   │   └── v0.5.0.md
│   ├── screenshot/
│   │   ├── 01-overview.png
│   │   ├── 02-dates.png
│   │   ├── 03-sessions.png
│   │   ├── 04-models.png
│   │   ├── 05-settings.png
│   │   ├── footer.png
│   │   └── install-help.png
│   ├── API.md ← Remote 协议与偏好设置约定（随接口演进维护）
│   ├── ARCHITECTURE.md ← 架构与统计口径唯一权威（账本/数据流/折叠/墓碑/口径；AGENTS.md 只留规则与指针）
│   ├── STRUCTURE.md ← 生成文件：由 `pnpm tree` 重新生成，勿手改
│   └── STYLE.md ← 风格经验沉淀（lint 之外的统一约定，新会话先读）
├── scripts/
│   ├── css-modules-inline.mjs ← rolldown 插件：把 *.module.css 编译成「scoped 类名映射 + 样式内联注入」的 JS 模块。
│   └── gen-tree.mjs ← 生成 docs/STRUCTURE.md：反射仓库真实结构，避免目录树手写漂移。
├── src/
│   ├── client/
│   │   ├── components/
│   │   │   ├── HintCard.module.css ← 状态提示卡：图标徽标 + 状态标题 + 说明 / 凭据名 / 操作，磁贴浅底与 tooltip 深底共用同一版式。
│   │   │   ├── HintCard.tsx ← 状态提示卡：图标徽标 + 状态标题 + 可选说明、凭据名与操作，概览磁贴、侧边栏 tooltip 与各报错区共用，所有非正常态走同一版式，不再各处手写纯文本提示。
│   │   │   ├── ModelPieChart.module.css ← 模型饼图（ModelPieChart）：占比饼图 + 图例，纯 SVG，无外部依赖。
│   │   │   ├── ModelPieChart.tsx ← 模型饼图 ModelPieChart：按模型占比的饼图，纯 SVG。
│   │   │   ├── Pagination.module.css ← 通用分页（Pagination）：居中分页条
│   │   │   ├── Pagination.tsx ← 通用分页（Pagination）：上一页 / 页码信息 / 下一页。
│   │   │   ├── SessionIdBadge.module.css ← 会话 ID 徽标（SessionIdBadge）：会话标题右侧工具区的等宽徽标与悬停复制按钮。
│   │   │   ├── SessionIdBadge.tsx ← 会话 ID 徽标：会话标题右侧工具区的等宽 sessionId 展示与悬停复制。
│   │   │   ├── SettingsSwitch.module.css ← 设置 Tab 的开关控件（SettingsSwitch，role="switch"）：off 用描边色填充， on 用成功绿，滑块用前景色（token 配色，深色模式随之翻转）。
│   │   │   ├── SettingsSwitch.tsx ← 设置 Tab 的开关控件（role="switch"）。
│   │   │   ├── StackedBar.module.css ← 堆叠柱状图（StackedBar）：两种模式共用外壳样式，图例最大宽度按模式用变体类区分（date 70% / model 60%）。
│   │   │   ├── StackedBar.tsx ← 堆叠柱状图 StackedBar：date 模式按 token 类型（输入/输出/缓存）堆叠并叠加缓存命中率折线， model 模式按模型堆叠；每日一柱，横向滚动。
│   │   │   ├── ThSortable.module.css ← 可排序表头按钮（ThSortable）：整列可点击，右对齐数值列，首列左对齐；颜色全部使用设计 token。
│   │   │   ├── ThSortable.tsx ← 通用可排序表头（ThSortable）：点击切换排序方向的 <th> 单元格。
│   │   │   ├── Tooltip.module.css ← 自实现 Tooltip：视觉完全复刻 dsh 自带的 Tooltip.module.css（size m、无箭头）。
│   │   │   ├── Tooltip.tsx ← 富内容 Tooltip：为需要多行排版或跟随鼠标的气泡提供 `content` 插槽与 `follow` 定位。
│   │   │   └── UsageStatsCommon.module.css ← 用量统计模态窗内跨组件共用的样式基元：分区头、统计磁贴/单元格、空态、 表格、Tab 栏、通用提示等。
│   │   ├── views/
│   │   │   ├── ConfigTransfer.module.css ← 配置迁移区 ConfigTransfer：导出与导入两个子块的标题、说明、文本域、 操作按钮、差异预览与内联反馈。
│   │   │   ├── ConfigTransfer.tsx ← 配置迁移区（ConfigTransfer）：设置 Tab 的专属子视图，一个组件一个文件。
│   │   │   ├── DateDetail.module.css ← 日期明细弹窗（DateDetail 与两个子视图）：日期页每行末尾的「明细」链接打开的二级弹窗。
│   │   │   ├── DateDetail.tsx ← 日期明细弹窗（DateDetail）：日期页每行末尾的「明细」链接打开的二级弹窗， 含标题（日期 + 当天合计）、按会话 / 按模型两个子标签、加载 / 失败 / 空态与关闭按钮。
│   │   │   ├── DateDetailModels.tsx ← 日期明细弹窗的「按模型」子视图：这一天有用量的模型表，列与模型页对齐—— 模型 / Provider | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 占比， 默认按「总计」降序、可排序、每页 15 条；占比以当天这张表的总和为分母， 用 stats.largestRemainderPcts 配分（与模型页同一口径，1 位小数总和恰为 100）。
│   │   │   ├── DateDetailSessions.tsx ← 日期明细弹窗的「按会话」子视图：这一天有用量的会话表，与面板会话 Tab 同一套展示—— 列（会话 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用）、子代理折叠到主会话 并带 + 展开、默认按「总计」降序、可排序、每页 15 条；分组与排序比较走 stats.ts 的 共用实现（groupSessions / compareSessionGroup），与面板会话 Tab 同一份。
│   │   │   ├── DatesTab.module.css ← 日期 Tab DatesTab：堆叠柱状图 + 范围 chips + 数据表格，与模型 Tab 对齐。
│   │   │   ├── DatesTab.tsx ← 日期 Tab：堆叠柱状图、范围切换与数据表格，与模型、会话 Tab 对齐。
│   │   │   ├── HeroTile.module.css ← 英雄磁贴 HeroTile：今日与总 tokens 共用的合并磁贴样式。
│   │   │   ├── HeroTile.tsx ← 英雄磁贴 HeroTile，今日与总 tokens 共用的合并磁贴。
│   │   │   ├── ModelDetail.module.css ← 模型明细（ModelDetail 与两个子视图）：模型页每行末尾的「明细」链接打开的二级弹窗。
│   │   │   ├── ModelDetail.tsx ← 模型明细弹窗（ModelDetail）：模型页每行末尾的「明细」链接打开的二级弹窗， 含标题、按日期 / 按会话两个子标签、加载 / 失败 / 空态与关闭按钮。
│   │   │   ├── ModelDetailDates.tsx ← 模型明细弹窗的「按日期」子视图：该模型在范围内的每日用量——顶部每日趋势图、 下方用量表，构成与日期 Tab 一致（图由 StackedBar 补齐范围内每一天，表格只列 真正有量的日子）；列与日期 Tab 对齐（日期 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用）， 可排序、每页 15 条。
│   │   │   ├── ModelDetailSessions.tsx ← 模型明细弹窗的「按会话」子视图：范围内用过该模型的会话表，表与会话 Tab 完全同款—— 列（会话 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 最近活跃）、 子代理折叠到主会话并带 + 展开、默认按「最近活跃」降序、可排序、每页 15 条； 分组与排序比较走 stats.ts 的共用实现（groupSessions / compareSessionGroup）。
│   │   │   ├── ModelRedirectEditor.module.css ← 模型统计重定向规则编辑器 ModelRedirectEditor：规则行（来源 → 目标）、 删除按钮、添加按钮与提示文字。
│   │   │   ├── ModelRedirectEditor.tsx ← 模型统计重定向规则编辑器：设置 Tab 的专属子视图。
│   │   │   ├── ModelsTab.module.css ← 模型 Tab（ModelsTab）：与会话 Tab 对齐的表格容器（表格样式在共用基元里）。
│   │   │   ├── ModelsTab.tsx ← 模型 Tab：模型/Provider 拆分表 + 顶部饼图与堆叠柱 + 靠右的时间范围筛选（默认 1 年）。
│   │   │   ├── OverviewTab.module.css ← 概览 Tab：Bento 磁贴网格（今日/总计左列、热力图右大区、额度卡片底行），颜色全部使用设计 token。
│   │   │   ├── OverviewTab.tsx ← 概览 Tab：Bento 磁贴网格（今日/总计左列、热力图右大区、额度卡片底行）， 布局用 grid-template-areas 分区；三张额度卡片受监控开关控制，未启用时隐藏且底行自动补位。
│   │   │   ├── QuotaMonitorTable.module.css ← 额度监控表格 QuotaMonitorTable：设置 Tab 的专属子视图样式， 一张四列表格承载三个额度来源的启用 / 侧边栏展示 / 抓取间隔。
│   │   │   ├── QuotaMonitorTable.tsx ← 额度监控表格：设置 Tab 的专属子视图，把 DeepSeek 余额、OpenCode Go 额度与 Z.ai 额度压成 一张四列表格（监控项 / 启用监控 / 在侧边栏展示 / 抓取间隔），一行一个额度来源。
│   │   │   ├── SessionDetail.module.css ← 会话明细弹窗（SessionDetail 与两个子视图）：会话页主会话行末尾的「明细」链接打开的 二级弹窗。
│   │   │   ├── SessionDetail.tsx ← 会话明细弹窗（SessionDetail）：会话页主会话行末尾的「明细」链接打开的二级弹窗， 含标题（会话标题 + 合计）、按日期 / 按模型两个子标签、加载 / 失败 / 空态与关闭按钮。
│   │   │   ├── SessionDetailDates.tsx ← 会话明细弹窗的「按日期」子视图：该会话集合的每日用量——顶部每日趋势图、下方用量表， 与日期 Tab 同一套展示（图由 StackedBar 补齐每一天，表格只列真正有量的日子）； 列与日期 Tab / 模型明细的按日期表对齐（日期 | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用）， 可排序、每页 15 条。
│   │   │   ├── SessionDetailModels.tsx ← 会话明细弹窗的「按模型」子视图：该会话集合有用量的模型表，列与模型页对齐—— 模型 / Provider | 缓存 | 输入 | 输出 | 总计 | 命中率 | 调用 | 每次调用 | 占比， 默认按「总计」降序、可排序、每页 15 条；占比以集合这张表的总和为分母， 用 stats.largestRemainderPcts 配分（与模型页同一口径，1 位小数总和恰为 100）。
│   │   │   ├── SessionsTab.module.css ← 会话 Tab SessionsTab：仅保留首列最小宽度。
│   │   │   ├── SessionsTab.tsx ← 会话 Tab：按会话表分页展示，每页 20 条，子代理折叠到主会话，带加号展开； 展示快照下发的会话（最多 SNAPSHOT_LIMIT 条，默认按最近活跃倒序）。
│   │   │   ├── SettingsTab.module.css ← 设置 Tab SettingsTab：操作按钮含重建账本状态、偏好设置行、可折叠分区（账本操作、配置迁移） 与底部页脚。
│   │   │   ├── SettingsTab.tsx ← 设置 Tab：偏好设置、配置迁移折叠区、账本操作折叠区与底部页脚。
│   │   │   ├── UsageHeatmap.module.css ← 概览 Tab 的 26 周热力图网格（UsageHeatmap）：Codex 风格列布局、4 档强度、 月份标签、今日外框高亮。
│   │   │   ├── UsageHeatmap.tsx ← 概览 Tab 的 26 周热力图：Codex 风格网格，列为周、行为周一至周日， 含 4 档强度、月份标签与今日高亮。
│   │   │   ├── UsageStatsFooter.module.css ← 侧边栏底部动作层，支持宽列与 56px rail 两种形态，几何与 harness 的 CordisPanel 侧边栏底部动作一致；颜色全部使用设计 token。
│   │   │   ├── UsageStatsFooter.tsx ← 用量统计的侧边栏底部动作：注册在 `sidebar.footer.action` 插槽的今日统计触发器。
│   │   │   ├── UsageStatsPanel.module.css ← 用量统计模态窗壳 UsageStatsPanel：headless Modal 卡片内的 chrome —— 头部、Tab 栏、可滚动内容区。
│   │   │   └── UsageStatsPanel.tsx ← 用量统计的详情视图：侧边栏底部按钮打开的居中模态窗，头部 + Tab 栏 + 内容区。
│   │   ├── api.ts ← usageStats 命名空间的浏览器端调用约定：调用前经 usageStatsRemote() 取命名空间服务。
│   │   ├── configTransfer.ts ← 配置串编解码：把整份偏好打包成可复制粘贴的 Base64 文本，并反向解析。
│   │   ├── index.ts ← 用量统计的浏览器端入口：侧边栏底部动作（今日统计角标 + 模态窗详情）与会话标题旁的 session-id 徽标。
│   │   ├── locales.ts ← 用量统计界面文案字典，类型化写法与 harness 的 ui-cordis 命名空间一致。
│   │   ├── remote.ts ← usageStats 命名空间的浏览器端挂载与调用入口：apply 内挂载手写贡献，hooks 经 usageStatsRemote() 取服务。
│   │   ├── settings.ts ← 浏览器端插件偏好存储：绑定服务端 `usage-stats` 插件条目（profile 配置文档里的 Loader 条目）的设置表单。
│   │   ├── stats.ts ← 用量统计界面的纯函数：格式化、分桶、曲线与热力图几何、模型统计重定向归并。
│   │   ├── useConfirmOp.ts ← 二次确认操作 hook（浏览器端）。
│   │   ├── useDateDetail.ts ← 单日明细的浏览器端取数：日期页点某行的「明细」链接时，按该行的本地日零点查一次 usageStats/dateDetail；没有打开的日期时不发请求。
│   │   ├── useIntervalText.ts ← 抓取间隔输入 hook（浏览器端）。
│   │   ├── useModelDetail.ts ← 模型明细的浏览器端取数：点某行的「明细」链接时按「目标 + 归并来源」各查一次 usageStats/modelDetail，用 mergeModelDetails 合成一行；没有打开的行时不发请求。
│   │   ├── useQuota.ts ← 额度轮询 hooks（浏览器端）：共享轮询骨架 useQuota + Go/DeepSeek/Z.ai 三路薄包装。
│   │   ├── useSessionDetail.ts ← 会话明细的浏览器端取数：会话页点主会话行的「明细」链接时，按该行的折叠会话集合 （主会话 + 展平的全部子代理）查一次 usageStats/sessionDetail；没有打开的行时不发请求。
│   │   ├── useSnapshot.ts ← 用量统计浏览器端（Client）的快照轮询。
│   │   ├── useSortTable.ts ← 表格排序分页三件套（浏览器端）。
│   │   └── useUsageSettings.ts ← 偏好设置的 React hook（浏览器端）。
│   ├── host/
│   │   ├── agg.ts ← 聚合口径与纯函数：Agg、SessionInfo 结构，折叠原子操作 newAgg、ink，事件守卫 usable、 modelKeyOf。
│   │   ├── deepseekBalance.ts ← DeepSeek 余额查询：通过 `GET https://api.deepseek.com/user/balance` 获取当前余额。
│   │   ├── detail.ts ← 明细构建：把 usageStats/modelDetail、usageStats/dateDetail 与 usageStats/sessionDetail 的结果 value 从聚合缓存与账本整理出来，不触碰传输层与 ctx。
│   │   ├── goquota.ts ← OpenCode Go 订阅额度查询：滚动 5 小时 / 本周 / 本月三档用量百分比 与重置时间，端点为 `GET https://opencode.ai/zen/go/v1/usage`。
│   │   ├── index.ts ← 用量统计的服务端 Host 插件入口：default 导出服务类，由 Loader 实例化。
│   │   ├── ledger.ts ← 原始事件流账本 Ledger：用量事件的唯一事实来源 —— 自管理 SQLite。
│   │   ├── logs.ts ← 会话日志的目录发现与 NDJSON 解析。
│   │   ├── quota.ts ← 额度查询共享基元（服务端）：浏览器 UA、key 回退解析、TTL 缓存单飞工厂。
│   │   ├── rawlog.ts ← 会话原始日志的物理代次识别与多帧 zstd 解码：扫描拼接 zstd 帧边界后逐帧解压为 NDJSON 文本，供扫描链路在 harness 读取失败时兜底读取旧代次会话。
│   │   ├── scan.ts ← 会话扫描编排，账本导入：把磁盘原始日志 ∪ harness 会话清单的会话 id 全集逐会话读取， 经 foldRecord 写入账本（events、session_meta 共 9 表，含 agg_* 预统计）并折叠聚合缓存； harness 两路读取被拒或返回空事件时回退 rawlog 自读原始日志。
│   │   ├── service.ts ← 用量统计的服务端 Host 服务：账本模式装配，自管理 sqlite 介质，对外暴露 usageStats 命名空间的 10 个一元 Remote 方法。
│   │   ├── settings.ts ← 服务端（Host）的插件偏好设置 schema：`usage-stats` 插件条目（cordis.patch.yml 插入的 Loader 条目，id 即 USAGE_SETTINGS_NAMESPACE）的 Config，被 harness 设置 服务（ctx.settings）投影成设置表单，偏好因此落在 profile 配置文档里、属于部署而不是某一个浏览器。
│   │   ├── snapshot.ts ← 快照构建：把聚合缓存 UsageStore 与账本会话元数据整理成 usageStats/snapshot 的结果 value，不触碰传输层与 ctx。
│   │   ├── store.ts ← 内存聚合缓存：由账本事件流折叠而来的派生统计，按天、会话、模型、模型×日、全量维度组织。
│   │   └── zaiQuota.ts ← Z.ai 智谱额度查询：滚动 5 小时、每周 7 天百分比与每月 Web 搜索次数，端点为 `GET https://api.z.ai/api/monitor/usage/quota/limit`。
│   ├── remote/
│   │   └── contribution.ts ← usageStats 命名空间的手写严格 Remote 贡献。
│   ├── css-modules.d.ts ← CSS Modules 的类型声明（与 harness 的 ui-primitives 同款）： `import css from './X.module.css'` 得到 scoped 类名映射。
│   ├── types.ts ← 跨端共用的协议类型，host 与 client 两个 bundle 各自内联所需子集。
│   └── utils.ts ← 跨端共用的纯函数与共享常量，host 与 client 两个 bundle 各自内联所需子集。
├── test/
│   ├── client-bundle.mjs ← 浏览器端 bundle 冒烟测试（模拟 window.__ModuleLoader__ + document）。
│   ├── pure.mjs ← 纯逻辑、账本折叠与协议/偏好逻辑的单测（node:test + 类型剥离直引源码）。
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
├── screenshots.json ← 插件市场展示用的截图清单
├── tsconfig.json ← TS 编译配置（严格模式）
└── tsdown.config.ts ← 双 bundle 构建配置（host ESM + client CJS）
```
