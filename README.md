# dsh-usage-statistics — DSH 用量统计插件

DSH (DeepSeek Harness) 的 Web 用量统计插件：把 **token 用量** 按 **模型 /
Provider**、**会话**、**日期** 三个维度统计出来，挂在**侧边栏底部**（设置按钮旁）。
底部显示**今日统计**，点击弹出**详情模态窗**查看完整统计与 **OpenCode Go
订阅额度**。不做费用换算——只统计 token 与调用次数。

## 功能

- **侧边栏底部今日统计**：`icon + 今日 + 今日 tokens + 调用数`（宽列），
  折叠成 56px rail 时显示纯图标按钮；缺少会话权限或扫描中时给出状态角标。
- **详情模态窗**（点击角标打开），按 **Tab** 划分：
  - **概览**：今日 / 总 tokens、调用数、会话数汇总网格 + **近 26 周热力图** +
    **OpenCode Go 额度区**（三档进度条 + 百分比 + 重置时间）；
  - **日期**：每日趋势**曲线**（7 天 / 2 周 / 1 月 / 全部）；
  - **会话**：按会话查看（标题 / 工作目录 / 最近活跃）；
  - **模型**：按模型 / Provider 拆分（输入 / 输出 / 缓存 / 总计 + 占比条）；
  - **设置**：手动刷新、重建账本、偏好设置。
- **OpenCode Go 额度**：自动显示滚动 5 小时 / 本周 / 本月用量百分比
  （≥80% 预警、≥100% 超支，hover 显示重置时间）。

## 设置

设置页（模态窗 → **设置** Tab → **偏好设置**）提供三项 OpenCode Go 相关设置，
保存在浏览器 localStorage（`dsh-usage-statistics.settings`）：

- **启用 OpenCode Go 额度抓取**（默认开）：关闭后不再轮询官方额度接口，
  侧边栏与模态窗均不显示 Go 额度；
- **在侧边栏展示剩余额度**（默认开）：只控制侧边栏底部的 Go 额度芯片，
  模态窗内额度详情仍可见；关闭抓取时该项置灰；
- **额度抓取间隔**（默认 5 分钟，最短 3 分钟）：轮询官方额度接口的频率；
  官方端点始终至少间隔 3 分钟才被访问一次。

## 统计口径

- 只统计 `assistant/message` 事件中带用量数据的调用，不做费用换算。
- `total = input + output + cacheRead + cacheWrite`（reasoning 单列，不计入 total）。
- 按模型 = Provider + 模型名；会话维度记录标题 / 工作目录 / 创建与最近活跃时间。

## 安装

本插件是标准的 cordis **组合包**，装入 web profile（link 依赖，改代码后
重新 `pnpm build` + 重启生效）：

```bash
# 在本仓库目录内执行（link 指向仓库自身）
dsh plugin --profile web add "link:$(pwd)"
```

移除：

```bash
dsh plugin --profile web remove dsh-usage-statistics
```

装完后**重启 dsh（web profile）**。验证 API：

```bash
curl -s -X POST http://127.0.0.1:3080/usage-stats/api/snapshot \
  -H 'content-type: application/json' -d '{}'
```

## 数据存储

统计账本保存在 `$DSH_HOME/storages/dsh-usage-statistics/ledger.sqlite`
（SQLite，`$DSH_HOME` 默认 `~/.dsh`）。首次启动自动扫描历史会话日志导入，
之后随会话事件实时更新；日志被删除也能从账本恢复统计（重启后不依赖日志）。

## OpenCode Go 额度配置

无订阅或不关心时可忽略。要显示 OpenCode Go 额度，任选其一：

- 设置环境变量 `OPENCODE_GO_API_KEY`（或兼容旧名 `OPENCODE_API_KEY`），或
- 已用 `opencode login` 登录（自动复用 CLI 的登录态，无需额外配置）。

## 开发者

构建、测试与编码规范见仓库内 `AGENTS.md`；接口协议见 `docs/API.md`；模块
结构与各文件职责见 `docs/STRUCTURE.md`（由 `pnpm tree` 自动生成，勿手改）。
README 面向普通用户，不展开工程细节。

## License

MIT
