# 风格经验（STYLE.md）

`eslint.config.mjs` 是底线（0 errors 门禁）：lint 已覆盖的以 lint 为准（部分约定只在 `warn` 级，
仍需手工收敛），本文件只写 lint 表达不了的部分；与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准。

## 1. 缺省值：`||` 与 `??` 的分工

- **外部输入/脏数据归零用 `|| 0`**：`Number(r.x) || 0`、`input || 0`、`u?.total || 0`。
  `??` 会透传 `NaN`（`NaN ?? 0 === NaN`），`||` 恰能把 `0/NaN/undefined/null/''` 统一归零。
- **可选字段缺省用 `?? 0`**（类型已是 `number | null | undefined`，不经 `Number()`，不会产生 `NaN`），
  如 `pt?.input ?? 0`、`d.input ?? 0`。
- **`??` 另外用于三类**：键回退（0 是有效值时，如 `rec.currentValue ?? rec.used`）、
  哨兵缺省（`?? -1`、`?? []`、`?? {}`）、可空字符串语义保留
  （`value.lastError ?? value.scanError ?? ''`）。

## 2. 数字归一

- 外部输入先 `Number(v)`，再判 `Number.isFinite(n) && n > 0`，整数列加 `Math.floor`
  （`ledger.ts toLedgerEvent` 为范本）；DB 读回一律 `Number(r.x) || 0`；禁全局 `isNaN/isFinite`。
- 日期差换算用 `DAY_MS`（`utils.ts`），**绝不**用毫秒回推逐日推进——夏令时日不是 24h，
  推进一律 `date.setDate(date.getDate() ± n)`（原因见 `utils.ts` 的 `DAY_MS` 注释与
  `stats.ts` 的 `buildDateStack`）。
- 数值夹取用 `utils.clamp`、一位小数用 `utils.round1`；token 合计用 `utils.tokensTotal`，
  零值起点用 `utils.emptyUsage`（host 的 Agg 用 `agg.newAgg`），不手写字段字面量与 `Math.min/Math.max` 套娃。

## 3. 字符串

- 插值优先模板字面量：`` `${a} ${b}` `` 而非 `a + ' ' + b`。模型键一律用
  `joinModelKey(provider, model)` 拼、`splitModelKey` 拆，不手写分隔符（含测试）。
- 裸 `\0` 字节绝不进源码：测试写转义 `'\0'`，DB 入列前走 `sanitizeSqlText`。

## 4. 错误消息与文案

- `throw/reject` 用英文（如 `usageStats remote is not mounted yet`），注释与文档用中文；面向用户的文案一律走
  `locales.ts`。`t` 进纯函数时用别名 `t as unknown as LocaleFn`（`LocaleFn` 定义于 `locales.ts`）。

## 5. 魔法数字

| 常量 | 值 | 位置 | 用途 |
|---|---|---|---|
| `SNAPSHOT_LIMIT` / `SNAPSHOT_INTERVAL_MS` / `SERIES_MAX_DAYS` | — | `client/api.ts`、`utils.ts` | 快照与序列的取值、口径见 `docs/API.md` §2 |
| `DAY_MS` | 86_400_000 | `utils.ts` | 日期差换算（禁推进） |
| `QUOTA_MIN_FETCH_MS` / `QUOTA_CACHE_TTL_MS` / `effectiveQuotaTtl()` | — | `utils.ts` | 额度 TTL 的取值、口径见 `docs/API.md` §3 |
| `SCAN_WORKERS` | 4 | `host/scan.ts` | 扫描并发数 |
| `REQUEST_TIMEOUT_MS` / `CACHE_TTL_MS` / `UPGRADE_TIMEOUT_MS` | — | `host/update.ts`、`host/upgrade.ts` | 版本检查与升级的取值、口径见 `docs/API.md` §6/§7 |
| `PAGE_SIZE` | 20 / 15 | 各视图内 | 故意 per-file：Tab 20、明细弹窗 15 |

## 6. 注释内容

- 每个源码文件以块注释开头，**首句 = 该文件职责**（`pnpm tree` 取首句生成 `STRUCTURE.md`，到第一个
  `。！？!?` 为止）；改职责先改首句，再跑 `pnpm tree`。职责一句话说得清时可用单行头注（如 `locales.ts`）。
- 注释只写代码说不出的约束与理由（why），不复述代码、不复制文档、不写修复历史与过程叙事：
  历史归 `CHANGELOG.md`，机制/协议归 `docs/ARCHITECTURE.md`/`docs/API.md`，提及时留一行指针。

## 7. TypeScript 只写可擦除语法

- 禁参数属性（`constructor(private x)`）、禁枚举，用联合类型。配置级兜底是 `tsconfig.json` 的
  `erasableSyntaxOnly`：`npx tsc --noEmit` 对这两类语法直接报错（CI 的类型检查即覆盖）；`test/pure.mjs`
  以 `node --experimental-strip-types` 直引源码，非擦除语法同样跑不起来。
- 类型、纯函数、跨端常量与可复用 hook 的文件归属见 `AGENTS.md` §3，此处不重复。

## 8. CSS 与内联样式

- 静态样式走 `*.module.css`（`import css` + `className={css.x}`，写法与基座 `ui-sidebar/primitives`
  一致），颜色只引用主题真实声明的变量（`--dsw-*` / `--ds-*`，`test/styles.mjs` 对照
  `@deepseek-ai/dsh-client-ui-theme` 校验，`pnpm test:styles` 可单独跑）；**不要新增
  `var(--token, 写死颜色)` 兜底**——兜底会掩盖变量缺失，深色模式下出现白色色块而非报错；已有兜底
  不扩大，改到相关文件时顺手去掉。固定语义的静态色用 `--dsw-static-*`（目前只有气泡文字色
  `--dsw-static-neutral-bluish-00`），其余静态颜色走 alias——气泡底色即
  `--dsw-alias-tooltip-bg`（两套主题同为深色）。
  阴影按来源选族：卡片、磁贴与图表内的读数浮层用 `--dsw-shadow-lv1/lv2`；压在正文上的浮动卡
  （悬停读数、详情卡）用 `--dsw-elevation-*`（带描边，`prominent` 用于最上层卡片）。
  图表数据色（`MODEL_PALETTE`/`DATE_TOKEN_META`/`HIT_RATE_COLOR`，集中于 `stats.ts`）是唯一豁免，
  因 SVG `fill` 不解析 `var()`。
- 文字色按用途选：正文与可点文字用 `label-primary`/`label-secondary`/`label-tertiary`，
  `label-caption` 只给说明性小标签；深色下 caption 在 12px 文字上对比度不足（约 3.8:1），
  **Tab 这类可点文字用 `label-tertiary` 起**（对齐 harness 的 tab 写法）。
- 模态窗内表面（卡片、磁贴、图表卡、吸顶表头、分页条、输入框）一律 `bg-layer-2`：
  卡片底色由 primitives Modal 的 dialog 铺设，深色下 `bg-base` 会画成黑带。
- tsx 内联 `style` 只放动态值（现存 `OverviewTab.tsx` 余额明细圆点这类静态行内样式是历史遗留，
  应随改动收敛进 CSS，新代码不得新增）；悬浮叠加层（如命中率折线 svg）必须 `pointer-events: none`，
  几何常量与 CSS 尺寸的换算写进注释（见 `StackedBar.tsx` 的 `BAR_W/BAR_GAP`）。
- 提示气泡一律用本仓 `components/Tooltip.tsx`：同时支持纯文本与富内容，并可用 `follow` 跟随鼠标；
  基座 `Tooltip` 只收纯文本 `label`、不跟随鼠标，不满足本插件需求。气泡内卡片统一用
  `UsageStatsCommon.module.css` 的 `tip*` 类（底色深色 `--dsw-alias-tooltip-bg`，层级靠白色透明度叠加），
  额度明细、热力图单元格、比例条与归并来源标记共用，只有进度宽度与档位色留在行内。

## 9. 可访问性

- 可交互元素要有可读的名称与状态：无可见文字的图标按钮、可排序表头给 `aria-label`（文案走
  `locales.ts`）；展开/收起给 `aria-expanded`，Tab 给 `aria-selected`，开关给 `role="switch"` +
  `aria-checked`，排序表头给 `aria-sort`。
- 复合控件用结构角色：Tab 栏 `role="tablist"`、Tab `role="tab"`、内容 `role="tabpanel"`；弹窗
  `role="dialog"`、进度条 `role="progressbar"`、提示条 `role="status"`/`role="alert"`；异步结果需要
  播报时配 `aria-live`。
- 装饰元素一律 `aria-hidden`（图标、排序箭头、图表网点与图例色块），避免读屏念出无意义内容；语义标签
  （`button`/`nav`/`h1` 等）优先，只有无原生语义时才手写 `role`。

## 10. Hooks 与轮询

- 异步轮询标配三件套：`seqRef` 乱序守卫（后发先至丢弃旧响应）、失败保留旧数据仅置错、
  `enabled=false` 时清空数据且不发起请求；手动刷新走 `force: true`，不重置定时器。
- 间隔来自偏好设置，服务端 TTL 由请求体 `intervalMinutes` 推导（见 §5），两侧下限 3 分钟对齐。

## 11. 折叠与去重

折叠、去重与 fork 继承前缀的语义唯一权威是 `docs/ARCHITECTURE.md` §4；改折叠语义先改该文件。

## 12. 同一概念一种写法

动笔前先 grep 同义词（avg/mean、hitRate、showXRow/showX、可空判断），有现成写法就复用：

- **布尔条件**：同一组显隐只用一种形态，额度行显隐统一预计算 `showZai/showGo/showDeepSeek`。
- **t 转换**：每组件只转一次（`const tFn = t as unknown as LocaleFn` 置顶）；范围元组文案键标
  `UsageStatsKey`，消灭 `as never`。
- **表格**：排序分页走 `useSortTable` + `stableSort`，比较函数只留 switch 返回值；命中率/每次调用只用
  `hitRateOfDay`/`avgPerCall`；空值渲染优先用自带缺省的 `pctOf/fmtFull`（回 `--`）。
- **同名视图**：明细弹窗与面板对应 Tab 共用图表容器、表格基元（`firstCol`/`thSm`/`charts`/子代理行）与
  分组排序（`groupSessions`/`compareSessionGroup`），改一处即两处生效；唯一有意差异是明细会话表首列
  不吃满剩余宽度（弹窗较窄）；二级弹窗 chrome（`detail*` 类）也共用。
- **额度三件套**：轮询骨架只活在 `useQuota`；新增来源自写 fetch 与解析（如 `host/zaiQuota.ts`），
  `host/quota.ts` 的工厂只共享 TTL 缓存、单飞与 key 回退（`resolveFirstKey`）等通用逻辑。
- **非正常态提示**：一律用 `components/HintCard.tsx`（`variant` 选语义色，`tone` 分磁贴/深色 tooltip），
  正文按 `title` → `detail` → `keys` → `action` 四段；面板与明细用 `shared.statusWrap` 居中限宽，
  内联块直接放卡片，加载中与说明性小字用 `shared.goHint`；不另写纯文本错误提示。
- **确认操作/间隔输入**：走 `useConfirmOp`/`useIntervalText`，接口调用走 `postLedgerApi`。
- **判空**：只可能是 `null` 的值优先用 `=== null`/`!== null`；同时可能 `undefined`（可选参数、可选属性）
  用 `== null`/`!= null` 一次覆盖两种空（`eqeqeq: smart` 允许，见 `eslint.config.mjs`）。
