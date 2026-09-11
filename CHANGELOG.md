# 更新日志（CHANGELOG）

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循语义化版本。

维护约定：每次发版（`package.json version` 变更）必须同步追加该版本条目，把本次的功能更新与 Bug 修复记到这里；内部重构与文档整理可简记一行。详见 `docs/PUBLISH.md` 发布步骤。

## [Unreleased]

## [0.3.0] - 2026-09-11

### 新增

- **偏好设置改存 DSH 配置文件**：设置不再放浏览器 localStorage，而是注册进 harness 的用户设置体系——服务端 `ctx.settings.register('usage-stats', schema)`（`src/host/settings.ts`，schemastery schema 带默认值），浏览器端 `ctx.settingsScope.bind({ namespace: 'usage-stats' })`（`src/client/settings.ts` + `useUsageSettings`），落 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）的 `usage-stats` 段，换浏览器、换设备共用同一份偏好；文档只写显式改过的字段，其余字段跟随 schema 默认值。设置页顶部新增一行说明当前设置存放位置，服务端设置缺席或只读时明确提示“修改不会保存”。服务端注册失败（命名空间被占用、schema 被拒）只降级偏好并打一条警告，不让统计主链路（账本与实时折叠）随注册失败一起挂掉。旧版本 localStorage（key `dsh-usage-stats.settings`）由 `migrateLegacySettings` 一次性迁移进配置文件后删除旧键（先在作用域落定后判断，服务端设置缺席或只读时保留旧键）
- 后端接口迁入 `usageStats` 命名空间 7 个一元 `@Remote` 方法（`snapshot/rebuild/clear/seal/goQuota/deepseekBalance/zaiQuota`），调用经客户端 Connection 的 RPC（`POST /api/usageStats/<方法>`），信任与认证由网关载体统一处理

### 变更

- 偏好作用域解绑带身份：浏览器端热重载会先挂新作用域、旧 fiber 的清理后跑，旧清理不再把新作用域抹掉（`detachUsageSettings(scope)`）
- 偏好写入在作用域落定为不可用或只读时直接跳过（此前会发一次注定被拒的 `settings/mutate`，界面上表现为开关弹回并留一条控制台警告）；仍在加载中照发，服务端可能接受
- 偏好设置的默认值、`clamp*` 夹取与字段级归一化由 `src/client/settings.ts` 上移到 `src/utils.ts`（`UsageSettings` 类型上移到 `src/types.ts`），服务端 schema 与浏览器端归一化共用同一份数值，避免默认值分叉；新增 devDependencies `@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`（服务端 schema 的值导入）、`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-api-remotes` 与测试用 `@deepseek-ai/dsh-settings-file`，`dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-settings` 保证 `settingsScope` 服务先于本插件加载
- 设置 Tab 偏好设置的分组顺序改为 DeepSeek 余额 → OpenCode Go 额度 → Z.ai 额度，与概览底行磁贴排列一致（此前 OpenCode Go 在最前）
- **BREAKING**：删除自建 `POST /usage-stats/api` 前缀路由与回环围栏、`x-dsh-usage-stats` 自定义头（`src/host/http.ts` 删除），服务端改类表单 `UsageStatsService`（Loader 实例化），客户端自挂载手写严格贡献后经 `ctx.get('remote.usageStats')` 取命名空间服务调用；升级后需重启 dsh 服务端
- 构建：TypeScript 升至 6（标准装饰器原生类输出），tsdown 新增装饰器降级插件；客户端 bundle 内联 `zod` 编解码
- 可选服务不再进 inject：`credentials` 改调用处 `ctx.get` 判空（cordis 对象写法的值为拦截配置，无“可选”语义）
- harness 版本对齐到 `0.1.5-rc.2`（npm `next` 标签，当前基座发布线）：`@deepseek-ai/*` devDependencies 与 `pnpm-workspace.yaml` 白名单同步，逐包核对类型/实现与基座一致（`session`/`persistence`/`session-query`/`typert-protocol`/`credentials`/`ui-slots`/`ui-renderer`/`locale`/`sidebar`/`api-gateway` 无差异，客户端冻结模块表仍是九项）
- 提示气泡拆两路：纯文字提示改用基座 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`；需要多行排版或鼠标跟随时才用本仓 `components/Tooltip.tsx`，其 `label` 兼容分支删除、只保留富内容插槽（基座 Tooltip 当前只接受纯文本，未支持富内容）
- 发布：GitHub Release 正文不再用自动生成的提交/PR 清单，改为该版本的 `docs/releases/v<版本>.md`（面向用户的人话版更新说明）；`release.yml` 在 tag 校验阶段强制该文件存在，缺失则中止发布（见 `docs/PUBLISH.md`）

### 修复

- **扫描期间账本操作可点却静默失败**：首启扫描或重建扫描进行中（模态窗顶部显示「扫描中…」），设置 Tab 的清零与重建按钮仍可点，走完二次确认后服务端以 `usageStats/busy` 拒绝、客户端把错误吞掉，界面没有任何反馈；同时这段窗口里清零会与在飞扫描交错写同一账本与聚合。现扫描期间两按钮置灰并给出原因，已打开的确认框随扫描开始自动关闭
- **悬浮卡片内容改为 CSS Modules**：额度明细、热力图单元格与比例条三处提示气泡的静态排版此前写在内联 `style` 里（近百处），现集中为 `UsageStatsCommon.module.css` 的 `tip*` 类共用，只有进度条宽度、档位色与圆点色等随数据的值留在行内；视觉不变，深浅主题仍走同一套白色透明度叠加（详见 `docs/STYLE.md §8`）
- **弹窗关闭按钮补无障碍名**：用量统计模态窗右上角关闭按钮只有图标，读屏抓不到名称，现补 `aria-label`（`panel.close`，中英双语已在字典中）
- 注释按当前实现校正：账本预统计表与 events 表是「同库、各自提交」而非同一事务；网关调用写明走客户端 Connection 的 RPC（`POST /api/usageStats/<方法>` + `client-request` 信封）；文档区分「一元（unary，区别于流式）」与「无请求参数」（`rebuild`/`clear`/`seal`）

- **深色模式白色色块**：设置 Tab 的分组头部、计数徽标、图标底与开关滑块引用了 harness 主题根本没有的 token（`--dsw-alias-bg-subtle`/`bg-fill`/`brand-bg`/`state-success-bg`），声明在计算值阶段失效后落到写死的浅色兜底（`#f6f7f9` 等），于是浅色模式正常、深色模式变成白条。现改用真实存在的 token（`interactive-bg-hover`/`border-l3`/`label-primary-foreground` 与 `color-mix` 品牌、成功色底），并新增 `test/styles.mjs` 对照主题包校验全部样式变量，写死兜底不再允许（详见 `docs/STYLE.md §8`）
- **深色模式黑带**：卡片底色由 harness 的 Modal 用 `bg-layer-2` 铺设，而窗内头部、Tab 栏、吸顶表头、分页条、磁贴卡片、图表卡与输入框都用 `bg-base`（浅色下同为白色、深色下比卡片暗一档），深色模式里于是出现几条比卡片更黑的横带；现统一为 `bg-layer-2`
- **无效 token 的死兜底清理**：额度进度条与设置开关的占位底色引用了不存在的 `bg-fill-2`，声明整条失效后落到兜底值上；现改为直接引用 `interactive-bg-hover`，行为不变、少一层误导
- **Tab 文字深色模式偏灰、选中下划线过硬**：未选中 Tab 用了 `label-caption`（说明性小标签的颜色，深色下 12px 文字对比度约 3.8:1），现改用 `label-tertiary`（约 8.5:1）；选中态由整条 `brand-primary` 描边改为 `label-primary` 文字 + 2px 圆头短线（与 dsh 设置页 tab 同一形态），并补 `:focus-visible` 焦点环
- **压缩上下文的调用不再漏统计**：dsh 压缩会话会发起一次独立 summarize 调用，用量落在 `compaction/summary` 事件的 `data.usage`（模型身份在 `data.provider`/`data.model`，不经 agent loop、不与 `assistant/message` 重复），此前只认 `assistant/message` 导致整条调用丢失。现两类计量事件统一入账，`assistant/attempt` 仍不收（流式中间态，与同 turn 的 message 重复）；账本 `LEDGER_VERSION` 5→6，旧库自动清空重扫。本机实测补回 7 次调用 / 129.99 万 token
- **fork 子会话重复计数**：被 fork 的子会话日志物理包含父会话的历史事件，此前整份折叠导致父的用量在子会话名下再算一遍。现按 harness 的 `inheritedEventCount`（原始日志路径按 `session/end-seed` 的 `inherited` 标记）只折自有事件，实时监听同口径；本机实测排除 2,972 条重复 / 4.45 亿 token。账本 `LEDGER_VERSION` 4→5，旧库自动清空重扫
- **旧格式会话不再漏统计**：新版 dsh 对 v0/v2 会话的格式迁移 fail-closed（`SessionFormatUnsupportedError`），本机实测 66 个旧会话的用量完全读不到。新增 `src/host/rawlog.ts`（多帧 zstd 解码 + 代次命名解析），扫描在 harness 两路读取失败或为空时自读磁盘原始日志兜底，命中计入 `rawSessions`；`findSessionLogs` 由只认 `session.jsonl.zstd` 改为按代次择优（v0/vN/未压缩），补回仅存 v2/v3 的目录
- harness 0.1.5 对齐：`@deepseek-ai/*` 升至 `0.1.5-alpha.2`，移除已下线的 `dsh-client-runtime`，`ClientContext` 改 `Context as ClientContext`（`@deepseek-ai/cordis`），slots 类型取自 `dsh-client-ui-renderer/client`；会话读取改 `persistence.open+read`（`supportsRawArtifacts/readRaw/readFrom` 已删）；客户端 external 复刻基座 `PLATFORM_MODULES` 九项
- 浏览器端取命名空间服务改走 `ctx.get('remote.usageStats')` 实时解析：暂存 `ctx.remote` 再读 `.usageStats` 会在子 scope 下报 `without inject`，导致快照与三路额度全部不可用（`src/client/remote.ts`；`pure` 新增句柄回归单测）
- 注释文档与实现对齐：额度缺凭据直接返回 `no-key`（不读 env 与文件）、九表与去重与截断口径按实现修正，`README` 凭据别名与 `CHANGELOG` 链接同步

## [0.2.1] - 2026-09-06

### 新增

- 日期趋势叠加缓存命中率折线：柱仍为输入/输出/缓存三段堆叠，线上叠加命中率（空值断开，颜色避开模型色板），口径与表格一致（`cacheRead/(cacheRead+input)`）
- 概览与侧边栏新增 `ZaiNoPlan` 空态：未开通 GLM Coding Plan 时展示缩短后的未开通文案，未开通态头部同样支持手动强制刷新
- `test/pure.mjs` 纯函数单测直引源码（`node --experimental-strip-types`，62 断言、14 套件）：工具/聚合/日志解析/围栏/格式化/分组/时间范围/图表几何/快照截断/三额度 fixture，无外网、不碰 sqlite

### 变更

- 日期与模型默认时间范围由全部改为 1 年
- 额度余额卡片展示优化：折叠栏回退芯片标签缩短为 `Z.ai`，更新于钉到卡片底部（未开通态也展示）
- 内部收敛（行为不变）：三额度查询共享 `host/quota.ts` 工厂（UA、key 回退、TTL 单飞），浏览器端 hooks 收成 `useQuota` 工厂，表格排序分页走 `useSortTable/stableSort`，缺省常量收敛至 `utils`（`SERIES_MAX_DAYS`/`QUOTA` 上下限/TTL 公式）

### 修复

- 零用量事件直接丢弃不入账本，避免库膨胀；用量归一化向下取整，与 integer 列对齐
- 快照 `series`/`models[].series` 截断至最近 366 天，避免长历史下全量序列化开销
- 会话表嵌套三元清理（抽取 `formatLastActive` 复用主子行格式化），`npx eslint .` 零问题

## [0.2.0] - 2026-09-03

### 新增

- DeepSeek 余额监控：多币种余额（`total/granted/toppedUp` 字符串金额，避免浮点丢失）与可用态，凭据走 DSH 凭据中心 `DEEPSEEK_API_KEY`，服务端新增 `deepseekBalance` 模块与路由，客户端新增轮询 hook、设置项与本地化文案，概览/侧边栏/设置接入并受开关控制
- Z.ai 额度监控：滚动 5 小时、周百分比与每月 Web 搜索次数，凭据支持 `ZAI_API_KEY` 或 `ZAI_CODING_CN_API_KEY`，服务端新增 `zaiQuota` 模块与路由，客户端同上接入
- 发布固定别名 tarball：`release.yml` 随 GitHub Release 附带 `xfqz86-dsh-usage-stats.tgz` 固定地址，供 README 的 latest 下载链接永不变动

### 变更

- 引入 `eslint` 规约与代码风格基建（`eslint 9 + typescript-eslint 8 + eslint-plugin-import-x + @stylistic`，分 host/client/scripts 三类 overrides，Google 风格），全量代码规整至零 errors 门禁
- 同步 harness 依赖至 `@deepseek-ai/* 0.1.2-alpha.4`（个别包 `0.1.1-rc.2`/`0.1.2-alpha.3`，见 `package.json`）
- 文档重整：README 增加功能矩阵与多图预览，`docs/API.md`/`docs/STRUCTURE.md` 覆盖新增额度能力

### 修复

- 适配新 runner 将复合 Action 运行时升级至 `node24`（托管镜像已移除 `node22`）
- 修复发布流程与同步分支的执行依赖：`release` 补 `checkout` 以加载本地 Action，同步分支清理保留 `.github` 以避免 post 阶段缺失 `action.yml`

## [0.1.1] - 2026-09-01

### 修复

- 浏览器端表头重叠：补 `UsageStatsCommon` 表头 sticky 背景，合并 `DateStackedBar`/`ModelStackedBar` 为统一 `StackedBar`，清理 12 个死选择器与 4 处 TSX 兼容
- 构建与 CI 保留 `repository` 以通过 npm OIDC provenance 校验：`prune-package` 白名单与 `release.yml`/`release-branch.yml` 校验同步加入 `repository`

## [0.1.0] - 2026-08-27

首个可用版本。

### 新增

- 侧边栏底部今日用量：宽列与 56px rail 自适应，rail 折叠态圆形按钮上方竖排额度芯片，点击打开详情面板
- 详情面板五 Tab：概览（汇总网格 + 额度 + 26 周热力图 + 扫描页脚）、日期（每日趋势曲线 + 时间范围）、会话（会话表：子代理折叠、分页排序、命中率）、模型（模型/Provider 拆分表 + 占比饼图）、设置（重建/清零入口 + 偏好设置）
- 自管理 SQLite 账本（`$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`，`LEDGER_VERSION=4`）：`events` 天然幂等（`PK(t,session_id,seq)`，`ON CONFLICT DO UPDATE`）+ `session_meta`（标题/cwd/创建/活跃/子代理归属三列）+ `agg_*` 预统计物化视图；首次启动全量扫描历史会话（4 路 worker，`persistence.readRaw` 优先、harness 兜底），后续 `session/event` 实时增量，重启从账本恢复
- JSON API（`/usage-stats/api`，仅 POST，回环围栏 + `x-dsh-usage-stats` CSRF 围栏）：`snapshot/go-quota/rebuild/clear/seal`，快照含全量聚合、日序列、模型拆分与会话明细
- OpenCode Go 额度：滚动 5 小时/本周/本月三档剩余额度，`OPENCODE_GO_API_KEY` 走凭据中心，TTL 缓存 + 单飞 + 强制刷新下限，偏好设置支持总开关、侧边栏芯片开关与抓取间隔（默认 5 分钟、下限 3 分钟）
- 统计口径：`assistant/message` 且 `data.usage` 存在才入账，`total=input+output+cacheRead+cacheWrite`（`reasoning` 单列），缺失 provider/model 记 `unknown`，按本地自然日划分
- 构建与发布：`tsdown` 双 bundle（Host ESM + Client 闭包）+ CSS Modules 内联，`smoke/client-bundle` 验证，交付 npm/GitHub Release/tarball 三形态，提交遵循 Conventional Commits

[Unreleased]: https://github.com/xfqz86/dsh-usage-stats/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/xfqz86/dsh-usage-stats/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/xfqz86/dsh-usage-stats/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/xfqz86/dsh-usage-stats/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/xfqz86/dsh-usage-stats/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xfqz86/dsh-usage-stats/releases/tag/v0.1.0
