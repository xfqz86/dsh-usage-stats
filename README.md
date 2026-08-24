# dsh-usage-stats — DSH 用量统计插件

DSH（DeepSeek Harness）的 Web 用量统计插件。按**模型 / Provider**、**会话**、**日期**三个维度统计 token 用量与调用次数，挂载于侧边栏底部（设置按钮旁）。底部展示今日统计，点击打开详情模态窗；不做费用换算。

## 功能

- **侧边栏底部今日统计**：宽列展示 `图标 + 今日 + 今日 tokens + 调用数`，折叠为 56px rail 时仅展示图标按钮；无会话权限或扫描中时展示对应状态。
- **详情模态窗**（点击侧边栏角标打开），按 Tab 组织：
  - **概览**：今日 / 总计 tokens、调用数、会话数汇总 + 近 26 周热力图 + OpenCode Go 额度区（三档进度与重置时间）；
  - **日期**：按日趋势曲线（7 天 / 2 周 / 1 月 / 全部）；
  - **会话**：按会话聚合（标题 / 工作目录 / 最近活跃）；
  - **模型**：按模型 / Provider 拆分（输入 / 输出 / 缓存 / 总计 + 占比）；
  - **设置**：刷新、重建账本、偏好设置。
- **OpenCode Go 额度**：展示滚动 5 小时 / 本周 / 本月用量百分比（≥80% 预警，≥100% 超支，悬停显示重置时间）。

## 统计口径

- 数据源为 `assistant/message` 事件中携带 `data.usage` 的记录。
- `total = input + output + cacheRead + cacheWrite`，`reasoning` 单列，不计入 `total`。
- 按模型维度取 `data.message.source.provider` 与 `model`，缺失记为 `unknown`。
- 按会话维度记录标题、工作目录、创建时间与最近活跃时间。
- 按本地自然日划分日期（`startOfDay` 为唯一口径）。

## 安装与卸载

本插件为标准 cordis 组合包（`dsh.bundle.patch` → `cordis.patch.yml`），通过 profile 注入 web。

### 本地开发（link）

```bash
# 在本仓库目录执行
dsh plugin --profile web add "link:$(pwd)"
# 卸载（按安装时的包名）
dsh plugin --profile web remove @xfqz86/dsh-usage-stats
# 兼容旧 id 的卸载
# dsh plugin --profile web remove dsh-usage-stats
```

### 从 npm 安装（推荐，预构建，无需授权）

发布到 npm 后，用户无需源码即可安装：

```bash
dsh plugin --profile web add @xfqz86/dsh-usage-stats
# 指定版本
dsh plugin --profile web add @xfqz86/dsh-usage-stats@0.1.0
```

### 从 GitHub 安装

```bash
# 方式一：源码安装（dev 分支，触发 pnpm prepare 自构建）
dsh plugin --profile web add github:xfqz86/dsh-usage-stats
# 或显式指定 dev 分支
# dsh plugin --profile web add github:xfqz86/dsh-usage-stats#dev
# pnpm ≥10 首次会拒绝执行 prepare 并提示：
#   allowBuilds:
#     "@xfqz86/dsh-usage-stats": true
# 按提示将该段加入 profile 的 pnpm-workspace.yaml 后重新执行 add

# 方式二：预构建 release 分支（GitHub Actions 自动将 lib 推送至 release 分支，无需授权）
dsh plugin --profile web add github:xfqz86/dsh-usage-stats#release

# 锁定 commit（可信安装）
dsh plugin --profile web add github:xfqz86/dsh-usage-stats#<commit-sha>
```

### 从 tarball 安装

```bash
# 在本仓库目录生成 tarball（CI 与 release workflow 同款产物，NODE_ENV=production 产出压缩无 map）
NODE_ENV=production pnpm build
pnpm pack          # 或 pnpm pack --pack-destination ./dist
# 产物：xfqz86-dsh-usage-stats-0.1.0.tgz（内含 lib/ + cordis.patch.yml + README.md，已剪枝无 prepare）
dsh plugin --profile web add ./xfqz86-dsh-usage-stats-0.1.0.tgz
# 或直接交付该 tgz 文件
```

### 验证

安装后重启 dsh（web profile）生效：

```bash
curl -s -X POST http://127.0.0.1:3080/usage-stats/api/snapshot \
  -H 'content-type: application/json' \
  -H 'x-dsh-usage-stats: dsh-usage-stats' -d '{}'
# 缺失或不匹配 x-dsh-usage-stats 头时返回 403 forbidden（防跨站 CSRF）。
```

### 卸载

```bash
dsh plugin --profile web remove @xfqz86/dsh-usage-stats
```

## 设置

设置位于模态窗 **设置** Tab 的 **偏好设置** 分区，持久化于浏览器 `localStorage`（key 为 `dsh-usage-stats.settings`）：

- **启用 OpenCode Go 额度抓取**（默认开启）：关闭后停止轮询额度接口，侧边栏与模态窗均不展示额度；
- **在侧边栏展示剩余额度**（默认开启）：仅控制侧边栏底部额度芯片，模态窗内额度详情仍可见；关闭抓取时该项置灰；
- **额度抓取间隔**（默认 5 分钟，下限 3 分钟）：轮询官方额度接口的间隔；服务端对官方端点的实际访问间隔不低于 3 分钟。

## 数据存储

账本文件位于 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`（SQLite，`$DSH_HOME` 默认为 `~/.dsh`）。首次启动自动扫描历史会话日志并导入，之后随会话事件实时增量更新；具备介质恢复能力，重启后不依赖原始日志即可恢复统计。

## OpenCode Go 额度配置

无订阅或无需展示时可忽略。需展示额度时，满足任一条件即可：

- 配置环境变量 `OPENCODE_GO_API_KEY`（兼容旧名 `OPENCODE_API_KEY`）；
- 已通过 `opencode login` 登录（自动复用 CLI 登录态，无需额外配置）。

## 开发者

- 工程规范与架构说明见 `AGENTS.md`；
- 接口协议见 `docs/API.md`；
- 模块结构与文件职责见 `docs/STRUCTURE.md`（由 `pnpm tree` 生成，请勿手改）；
- 发布流程见 `docs/PUBLISH.md`。

## License

MIT
