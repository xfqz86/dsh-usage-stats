在侧边栏底部常驻今日 token 用量，点开面板按日期、会话、模型查看明细；同时监控 DeepSeek、OpenCode Go 与 Z.ai 额度，并在输入区显示当前会话的模型速度。

## 能做什么

- **一个入口**：侧边栏底部常驻今日用量与输入 / 输出 / 缓存占比条，收起侧边栏后收成紧凑芯片。
- **概览**：今日与总计、近半年每日热力图，以及 DeepSeek、OpenCode Go、Z.ai 三张额度卡片。
- **三个维度**：日期、会话、模型各成一页，日期与模型页可切换时间范围（7 天到全部，默认 365 天）；子代理折叠进主会话。
- **两处读数**：输入区状态行显示本会话平均 TTFT 与 ATPS；会话标题旁的 session-id 徽标一键复制。

完整功能清单见 [README](https://github.com/xfqz86/dsh-usage-stats)。

## 怎么用

1. 点击侧边栏底部的今日用量打开面板。
2. 顶部切换「概览 / 日期 / 会话 / 模型 / 设置 / 关于」。
3. 设置 Tab 里可以开关额度监控与抓取间隔、开关会话 ID 与模型速度读数、维护模型统计重定向、导出 / 导入配置串，以及清零或重建账本。
4. 「关于」页可以检查更新、查看数据与隐私说明，并直接升级新版本。

## 额度监控

在 DSH 凭据中心配置对应 Key 后生效：

- DeepSeek：`DEEPSEEK_API_KEY`
- OpenCode Go：`OPENCODE_GO_API_KEY`
- Z.ai：`ZAI_CODING_CN_API_KEY`

完整别名与优先序见 [`docs/API.md` §3](https://github.com/xfqz86/dsh-usage-stats/blob/main/docs/API.md)。

关闭某项监控后，插件不再请求对应的官方接口；额度请求只带该凭据直达官方端点，不经过第三方。

## 数据与隐私

- 数据只存本机：统计只在本地聚合，不上传用量、会话内容或账号信息，也没有遥测。
- 检查更新只查版本，不上传用量。

## 安装与更新

- 在 DSH 插件页安装 `@xfqz86/dsh-usage-stats`，或执行 `dsh plugin --profile web add @xfqz86/dsh-usage-stats`。
- 「关于」页发现新版本后可一键升级，升级后重启一次 DSH 生效。
- 卸载：`dsh plugin --profile web remove @xfqz86/dsh-usage-stats`。

更多安装方式和开发文档见 [GitHub 仓库](https://github.com/xfqz86/dsh-usage-stats)。
