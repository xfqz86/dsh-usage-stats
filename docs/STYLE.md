# 风格经验（STYLE.md）

`eslint.config.mjs` 是底线（0 errors 门禁），本文件是它管不到的一致性约定；与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准。

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

## 3. 字符串

- 插值优先模板字面量：`` `${a} ${b}` `` 而非 `a + ' ' + b`。唯一例外是模型键拼接
  `provider + '\0' + model`（全仓库统一，含测试），拆分只用 `splitModelKey`。
- 裸 `\0` 字节绝不进源码：测试写转义 `'\0'`，DB 入列前走 `sanitizeSqlText`。

## 4. 错误消息与文案

- `throw/reject` 用英文（如 `request body too large`），注释与文档用中文；面向用户的文案一律走
  `locales.ts`。`t` 进纯函数时用别名 `t as unknown as LocaleFn`（`LocaleFn` 定义于 `locales.ts`）。

## 5. 魔法数字

| 常量 | 值 | 位置 | 用途 |
|---|---|---|---|
| `SERIES_MAX_DAYS` | 366 | `utils.ts` | 快照截断与图表 `all` 上限 |
| `DAY_MS` | 86_400_000 | `utils.ts` | 日期差换算（禁推进） |
| `QUOTA_MIN_FETCH_MS` | 3 分钟 | `utils.ts` | 额度轮询 TTL 下限（手动 force 刷新不受限） |
| `QUOTA_CACHE_TTL_MS` | 5 分钟 | `utils.ts` | 额度缓存上限 |
| `effectiveQuotaTtl()` | — | `utils.ts` | `min(上限, max(下限, 间隔))`，三额度共用 |
| `SCAN_WORKERS` | 4 | `host/scan.ts` | 扫描并发数 |
| `SNAPSHOT_LIMIT` | 500 | `client/api.ts` | 快照会话明细请求上限（服务端默认 200、上限 1000） |
| `SNAPSHOT_INTERVAL_MS` | 4000 | `client/api.ts` | 快照轮询间隔（`useSnapshot` 默认值） |
| `PAGE_SIZE` | 20 / 15 | 各视图内 | 故意 per-file：Tab 20、明细弹窗 15 |

## 6. 注释内容

- 每个源码文件以块注释开头，**首句 = 该文件职责**（`pnpm tree` 取首句生成 `STRUCTURE.md`，到第一个
  `。！？!?` 为止）；改职责先改首句，再跑 `pnpm tree`。`locales.ts` 式单行头注是允许的例外。
- 注释只写代码说不出的约束与理由（why），不复述代码、不复制文档、不写修复历史与过程叙事：
  历史归 `CHANGELOG.md`，机制/协议归 `docs/ARCHITECTURE.md`/`docs/API.md`，提及时留一行指针。

## 7. TypeScript 只写可擦除语法

- 禁参数属性（`constructor(private x)`）、禁枚举（已有 lint 规则），用联合类型——`test/pure.mjs`
  靠 `node --experimental-strip-types` 直引源码，非擦除语法直接跑不起来。
- 类型放 `types.ts`；纯函数放 `utils.ts`/`agg.ts`/`stats.ts`；跨端新常量优先进 `utils.ts`
  （host/client 各自内联，无 bundle 交叉引用）。

## 8. CSS 与内联样式

- 静态样式走 `*.module.css`，颜色只引用主题真实声明的变量（`--dsw-*` / `--ds-*`，`test/styles.mjs`
  对照 `@deepseek-ai/dsh-client-ui-theme` 校验，`pnpm test:styles` 可单独跑）；**不要新增
  `var(--token, 写死颜色)` 兜底**——兜底会掩盖变量缺失，深色模式下出现白色色块而非报错；已有兜底
  不扩大，改到相关文件时顺手去掉。固定语义的静态色（气泡深底）与阴影用 `--dsw-static-*` /
  `--dsw-shadow-*`，其余静态颜色走 alias。图表数据色（`MODEL_PALETTE`/`DATE_TOKEN_META`/`HIT_RATE_COLOR`，
  集中于 `stats.ts`）是唯一豁免，因 SVG `fill` 不解析 `var()`。
- 文字色按用途选：正文与可点文字用 `label-primary`/`label-secondary`/`label-tertiary`，
  `label-caption` 只给说明性小标签；深色下 caption 在 12px 文字上对比度不足（约 3.8:1），
  **Tab 这类可点文字用 `label-tertiary` 起**（对齐 harness 的 tab 写法）。
- 模态窗内表面（卡片、磁贴、图表卡、吸顶表头、分页条、输入框）一律 `bg-layer-2`：
  卡片底色由 primitives Modal 的 dialog 铺设，深色下 `bg-base` 会画成黑带。
- tsx 内联 `style` 只放动态值；悬浮叠加层（如命中率折线 svg）必须 `pointer-events: none`，
  几何常量与 CSS 尺寸的换算写进注释（见 `StackedBar.tsx` 的 `BAR_W/BAR_GAP`）。
- 提示气泡：纯文字用基座 `Tooltip`，多行排版或鼠标跟随用本仓 `components/Tooltip.tsx`（基座只收
  纯文本 `label`）；气泡内卡片统一用 `UsageStatsCommon.module.css` 的 `tip*` 类（底色深色
  `--dsw-alias-tooltip-bg`，层级靠白色透明度叠加），额度明细、热力图单元格、比例条与归并来源标记共用，
  只有进度宽度与档位色留在行内。

## 9. Hooks 与轮询

- 异步轮询标配三件套：`seqRef` 乱序守卫（后发先至丢弃旧响应）、失败保留旧数据仅置错、
  `enabled=false` 时清空数据且不发起请求；手动刷新走 `force: true`，不重置定时器。
- 间隔来自偏好设置，服务端 TTL 由请求体 `intervalMinutes` 推导（见 §5），两侧下限 3 分钟对齐。

## 10. 折叠与去重

折叠、去重与 fork 继承前缀的语义唯一权威是 `docs/ARCHITECTURE.md` §4；改折叠语义先改该文件。

## 11. 同一概念一种写法

动笔前先 grep 同义词（avg/mean、hitRate、showXRow/showX、可空判断），有现成写法就复用：

- **布尔条件**：同一组显隐只用一种形态，额度行显隐统一预计算 `showZai/showGo/showDeepSeek`。
- **t 转换**：每组件只转一次（`const tFn = t as unknown as LocaleFn` 置顶）；范围元组文案键标
  `UsageStatsKey`，消灭 `as never`。
- **表格**：排序分页走 `useSortTable` + `stableSort`，比较函数只留 switch 返回值；命中率/每次调用只用
  `hitRateOfDay`/`avgPerCall`；空值渲染优先用自带缺省的 `pctOf/fmtFull`（回 `--`）。
- **同名视图**：明细弹窗与面板对应 Tab 共用图表容器、表格基元（`firstCol`/`thSm`/`charts`/子代理行）与
  分组排序（`groupSessions`/`compareSessionGroup`），改一处即两处生效；唯一有意差异是明细会话表首列
  不吃满剩余宽度（弹窗较窄）；二级弹窗 chrome（`detail*` 类）也共用。
- **额度三件套**：轮询骨架只活在 `useQuota`，服务端查询只活在 `createQuotaQuery`/`resolveFirstKey`
  （`host/quota.ts`），新增来源只配端点/键名/error 占位。
- **非正常态提示**：一律用 `components/HintCard.tsx`（`variant` 选语义色，`tone` 分磁贴/深色 tooltip），
  正文按 `title` → `detail` → `keys` → `action` 四段；面板与明细用 `shared.statusWrap` 居中限宽，
  内联块直接放卡片，加载中与说明性小字用 `shared.goHint`；不另写纯文本错误提示。
- **确认操作/间隔输入**：走 `useConfirmOp`/`useIntervalText`，接口调用走 `postLedgerApi`。
- **判空**：可空类型全是 `T | null`，用 `=== null`/`!== null`；`!= null` 只留给运行时可能
  undefined 的防御位（如 `p?.t`）；`== null` 不出现。
- **新文件归属**：可复用 hook 进 `src/client/use*.ts`，跨端常量进 `utils.ts`。
