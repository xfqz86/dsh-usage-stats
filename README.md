# dsh-usage-stats — DSH 用量统计插件

DSH（DeepSeek Harness）的 Web 用量统计插件。按**模型 / Provider**、**会话**、**日期**三个维度统计 token 用量与调用次数，挂载于侧边栏底部（设置按钮旁）。底部展示今日统计，点击打开详情模态窗；不做费用换算。

## 功能

- **侧边栏底部今日统计**：宽列与 56px rail 两种形态。
- **详情模态窗**：按 Tab 组织——概览、日期、会话、模型、设置。
- **OpenCode Go 额度**：滚动 5 小时 / 本周 / 本月三档用量。

## 安装与卸载

本插件为标准 cordis 组合包（`dsh.bundle.patch` → `cordis.patch.yml`），通过 profile 注入 web。

### 从 npm 安装

```bash
dsh plugin --profile web add @xfqz86/dsh-usage-stats
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:xfqz86/dsh-usage-stats#release
```

### 从 tarball 安装

```bash
dsh plugin --profile web add https://github.com/xfqz86/dsh-usage-stats/releases/latest/download/xfqz86-dsh-usage-stats.tgz
```

> 固定地址，始终指向最新 Release 的 tarball；也可在 [Releases](https://github.com/xfqz86/dsh-usage-stats/releases) 复制指定版本的 `xfqz86-dsh-usage-stats-*.tgz` 链接。

### 本地开发（link）

```bash
git clone https://github.com/xfqz86/dsh-usage-stats.git
cd dsh-usage-stats
pnpm install
pnpm build
dsh plugin --profile web add "link:$(pwd)"
# 后续改动后重新 pnpm build，浏览器刷新即可；服务端改动需重启 dsh
```

### 卸载：

```bash
dsh plugin --profile web remove @xfqz86/dsh-usage-stats
```

## 设置

设置位于模态窗 **设置** Tab 的 **偏好设置** 分区，持久化于浏览器 `localStorage`（key 为 `dsh-usage-stats.settings`）：

- **启用 OpenCode Go 额度监控**（默认开启）：关闭后停止轮询额度接口，侧边栏与模态窗均不展示额度；
- **在侧边栏展示 OpenCode Go 剩余额度**（默认开启）：仅控制侧边栏底部额度芯片，模态窗内额度详情仍可见；关闭抓取时该项置灰；
- **OpenCode Go 额度抓取间隔**（默认 5 分钟，下限 3 分钟）：轮询官方额度接口的间隔；服务端对官方端点的实际访问间隔不低于 3 分钟。

无订阅或无需展示额度时可忽略。需展示额度时满足任一条件即可：

- 配置环境变量 `OPENCODE_GO_API_KEY`（兼容旧名 `OPENCODE_API_KEY`）；
- 已通过 `opencode login` 登录（自动复用 CLI 登录态，无需额外配置）。

## 统计口径

- 数据源为 `assistant/message` 事件中携带 `data.usage` 的记录。
- `total = input + output + cacheRead + cacheWrite`，`reasoning` 单列，不计入 `total`。
- 按模型维度取 `data.message.source.provider` 与 `model`，缺失记为 `unknown`。
- 按会话维度记录标题、工作目录、创建时间与最近活跃时间及子代理归属。
- 按本地自然日划分日期（`startOfDay` 为唯一口径）。

## 数据存储

账本文件位于 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`（SQLite，`$DSH_HOME` 默认为 `~/.dsh`）。首次启动自动扫描历史会话日志并导入，之后随会话事件实时增量更新；具备介质恢复能力，重启后不依赖原始日志即可恢复统计。

## 开发者

- 工程规范与架构说明见 `AGENTS.md`；
- 接口协议见 `docs/API.md`；
- 模块结构与文件职责见 `docs/STRUCTURE.md`（由 `pnpm tree` 生成，请勿手改）；
- 发布流程见 `docs/PUBLISH.md`。

## License

MIT
