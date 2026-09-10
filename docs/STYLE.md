# 风格经验（STYLE.md）

`eslint.config.mjs` 是底线（0 errors 门禁），本文件是它管不到的一致性约定。
新会话写代码前先读本文件；与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准。

## 1. 缺省值：`||` 与 `??` 的分工

- **数值归零一律 `|| 0`**：`Number(r.x) || 0`、`input || 0`、`u?.total || 0`。
  原因：`??` 会透传 `NaN`（`NaN ?? 0 === NaN`），而脏数据与 `Number()` 转换恰恰产生 `NaN`；
  `||` 把 `0/NaN/undefined/null/''` 统一归零，正是数值归一要的语义。
- **`??` 只用于三处**：
  1. 键回退（0 是有效值时）：`rec.currentValue ?? rec.used`、`rawType ?? type`——此处用 `||` 会误吞 0；
  2. 哨兵缺省：`?? -1`（命中率 null 参与排序）、`?? []`、`?? {}`；
  3. 可空字符串语义保留：`value.lastError ?? value.scanError ?? ''`。
- 反例：`usageTotal` 曾用 `u?.total ?? 0`，NaN 会污染排序比较，已改为 `||`。

## 2. 数字归一

- 外部输入先 `Number(v)`，再判 `Number.isFinite(n) && n > 0`，整数列加 `Math.floor`
 （`ledger.ts toLedgerEvent` 为范本）；DB 读回一律 `Number(r.x) || 0`。
- 禁全局 `isNaN/isFinite`（eslint 已 warn），用 `Number.` 前缀版。
- 日期差换算用 `DAY_MS`（`utils.ts`），**绝不**用毫秒回推逐日推进——夏令时日不是 24h，
  推进一律 `date.setDate(date.getDate() ± n)`（`stats.ts buildSet` 注释有完整论证）。

## 3. 字符串

- 插值优先模板字面量：`` `${a} ${b}` `` 而非 `a + ' ' + b`。
- 唯一例外是模型键拼接 `provider + '\0' + model`：全仓库统一此写法（含测试），
  拆分只用 `splitModelKey`，不手写 `split('\0')`。
- 裸 `\0` 字节绝不进源码：测试里写转义 `'\0'`，DB 入列前走 `sanitizeSqlText`。

## 4. 错误消息与文案

- `throw/reject` 的错误消息用英文（如 `request body too large`），注释与文档用中文；
  面向用户的文案一律走 `locales.ts`，不手拼中文。
- `t` 函数进纯函数时用别名：`t as unknown as LocaleFn`
  （`LocaleFn` 定义于 `locales.ts`），不重复内联 `(k: string, p?: …) => string`。

## 5. 魔法数字

| 常量 | 值 | 位置 | 用途 |
|---|---|---|---|
| `SERIES_MAX_DAYS` | 366 | `utils.ts` | 快照截断与图表 `all` 上限 |
| `DAY_MS` | 86_400_000 | `utils.ts` | 日期差换算（禁推进） |
| `QUOTA_MIN_FETCH_MS` | 3 分钟 | `utils.ts` | 额度抓取下限 |
| `QUOTA_CACHE_TTL_MS` | 5 分钟 | `utils.ts` | 额度缓存上限 |
| `effectiveQuotaTtl()` | — | `utils.ts` | `min(上限, max(下限, 间隔))`，三额度共用 |
| `GO/DEEPSEEK/ZAI_MIN_FETCH_MS` | 别名 | 各额度模块 | 仅为对外兼容保留，对内用共享常量 |
| `SCAN_WORKERS` | 4 | `scan.ts` | 扫描并发数 |
| `SNAPSHOT_LIMIT` | 500 | `client/api.ts` | 快照会话明细上限 |
| `SNAPSHOT_INTERVAL_MS` | 4000 | `client/api.ts` | 快照轮询间隔（`useSnapshot` 默认值，不再各处手写 4000） |
| `PAGE_SIZE` | 20 | 各 Tab 内 | 故意 per-file 常量，不共享，避免跨 Tab 耦合 |

## 6. 文件头注释

- 每个源码文件以块注释开头，**首句 = 该文件职责**（`pnpm tree` 取首句生成 `STRUCTURE.md`，
  到第一个 `。！？!?` 为止）。改职责先改首句，再跑 `pnpm tree`。
- `locales.ts` 式单行头注是允许的例外。

## 7. TypeScript 只写可擦除语法

- 禁参数属性（`constructor(private x)`）、禁枚举（已有 lint 规则），用联合类型。
  原因：`test/pure.mjs` 靠 `node --experimental-strip-types` 直引源码，
  非擦除语法会直接跑不起来（`Ledger` 构造函数曾因此改写）。
- 类型放 `types.ts`，纯函数放 `utils.ts`/`agg.ts`/`stats.ts`，两者分离；
  跨端共享的新常量优先进 `utils.ts`（host/client 各自内联，无 bundle 交叉引用）。

## 8. CSS 与内联样式

- 静态样式走 `*.module.css`，颜色与动效只引用主题包声明过的变量
  （`--dsw-*` / `--ds-*`，`test/styles.mjs` 对照 `@deepseek-ai/dsh-client-ui-theme` 校验，
  `pnpm test:styles` 可单独跑）；**不写自定义属性兜底**——主题缺声明时兜底值会
  在深色模式把浅色写死，症状是白色色块而不是报错，让唯一门禁（该测试）失效。
  唯一豁免是图表数据色（`MODEL_PALETTE`/`DATE_TOKEN_META`/`HIT_RATE_COLOR` 集中于 `stats.ts`），
  因 SVG `fill` 属性不解析 `var()`。
- 文字色按用途选，不按“看起来够灰”：正文与可点文字用 `label-primary`/`label-secondary`/`label-tertiary`，
  `label-caption` 只给说明性小标签（分区标题、表头、状态胶囊）。深色模式下 caption 在 12px 文字上
  对比度不足（约 3.8:1），**Tab 这类可点文字用 `label-tertiary` 起**（对齐 harness 的 tab 写法）。
- 模态窗内的表面（卡片、磁贴、图表卡、吸顶表头、分页条、输入框）一律 `bg-layer-2`：
  卡片底色由 primitives Modal 的 dialog 铺设（就是这一层），浅色下与 `bg-base` 同为白色、视觉无差，
  深色下 `bg-base` 比卡片暗一档，会把整条栏画成黑带。
- tsx 内联 `style` 只放动态值（颜色/尺寸/定位）；悬浮叠加层（如命中率折线 svg）
  必须 `pointer-events: none`，几何常量与 CSS 尺寸的换算写进注释
  （见 `StackedBar.tsx` 的 `BAR_W/BAR_GAP` 注释范本）。

## 9. Hooks 与轮询

- 异步轮询标配三件套：`seqRef` 乱序守卫（后发先至丢弃旧响应）、失败保留旧数据仅置错、
  `enabled=false` 时清空数据且不发起请求。手动刷新走 `force: true`，不重置定时器。
- 间隔来自偏好设置，服务端 TTL 由请求体 `intervalMinutes` 推导（见 §5 公式），
  两侧下限 3 分钟对齐。

## 10. 折叠与去重（一句话版）

`foldRecord` 是实时与扫描的唯一入口：`seq>=0` 按 `maxSeq` 水位，`seq=-1` 按主键存在性；
零用量事件直接丢弃不入账本。改折叠语义先改 `AGENTS.md §5/§6`，再改代码。

## 11. 同一概念一种写法

多次会话协作最容易烂的就是这里：同一个东西，三个人写三样。
动笔前先 grep 同义词（avg/mean、hitRate、showXRow/showX、可空判断），有现成写法就复用：

- **布尔条件**：同一组显隐只用一种形态。额度行显隐统一为预计算
  `showZai/showGo/showDeepSeek`（宽列与 rail 共用），不在 JSX 里 inline 重写条件；
  新增同类行时跟这个写法。
- **t 转换**：每组件只转一次（`const tFn = t as unknown as LocaleFn` 置顶），
  不在 20 个调用点各转一次；范围元组的文案键类型标 `UsageStatsKey`，消灭 `as never`。
- **表格**：排序分页走 `useSortTable` + `stableSort`，比较函数只留 switch 返回值；
  命中率/平均每次调用只用 `hitRateOfDay`/`avgPerCall`（`stats.ts`），不在各表各写一份；
  空值渲染优先用自带缺省的 `pctOf/fmtFull`（回 `--`），少写 `x == null ? '--' : …` 三元。
- **额度三件套**：轮询骨架只活在 `useQuota`，服务端查询只活在
  `createQuotaQuery`/`resolveFirstKey`（`host/quota.ts`），新增额度来源时配
  端点/键名/error 占位，不抄整份文件。
- **确认操作/间隔输入**：走 `useConfirmOp`/`useIntervalText`，接口调用走 `postLedgerApi`。
- **判空**：可空类型全是 `T | null`，用 `=== null`/`!== null`；`!= null` 只留给
  运行时可能出现 undefined 的防御位（如 `p?.t`）；`== null` 不出现。
- **新文件归属**：可复用 hook 进 `src/client/use*.ts`，跨端常量进 `utils.ts`，
  别在视图文件里各建一份。
