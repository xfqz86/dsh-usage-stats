在侧边栏底部常驻今日 token 用量，点开面板按日期、会话、模型查看明细；同时监控 DeepSeek、OpenCode Go 与 Z.ai 额度，并在输入区显示当前会话的模型速度。

## 能做什么

- **侧边栏今日用量**：宽列显示今日 tokens、调用数与输入 / 输出 / 缓存占比条；收起侧边栏后收成紧凑芯片。
- **概览**：今日与总计、近半年（26 周）的每日热力图，以及三张额度卡片。
- **日期**：每天一根堆叠柱（输入 / 输出 / 缓存），叠加缓存命中率折线；下方表格可排序、分页。
- **会话**：按会话汇总用量，子代理折叠到主会话、可展开；支持按最近活跃、用量等列排序。
- **模型**：模型与 Provider 拆分表，配饼图和堆叠柱；模型表可按厂商或按模型分组。
- **明细弹窗**：日期、模型、会话每行末尾的「明细」，分别查看当天、该模型、该会话的用量构成。
- **额度监控**：DeepSeek 余额、OpenCode Go（滚动 5 小时 / 本周 / 本月）、Z.ai（滚动 5 小时 / 本周 / 每月 Web 搜索）；可单独开关、设置抓取间隔与是否显示在侧边栏。
- **模型速度**：输入区状态行显示当前会话的平均 TTFT 与 ATPS，点开看每次调用的柱状图和平均 / 最近 / 最小 / 最大。
- **会话 ID 徽标**：会话标题旁显示短 ID，点击复制。

## 怎么用

1. 点击侧边栏底部的今日用量打开面板。
2. 顶部切换「概览 / 日期 / 会话 / 模型 / 设置 / 关于」。
3. 设置 Tab 里可以开关额度监控与抓取间隔、开关会话 ID 与模型速度读数、维护模型统计重定向、导出 / 导入配置串，以及清零或重建账本。
4. 「关于」页可以检查更新、查看数据与隐私说明，并直接升级新版本。

## 额度监控

在 DSH 凭据中心配置对应 Key 后生效，同一凭据有多个名字时按顺序取第一个：

- DeepSeek：`DEEPSEEK_API_KEY`（也认 `DEEPSEEK_APIKEY`、`DEEPSEEK_API_TOKEN`、`DEEPSEEK_TOKEN`）
- OpenCode Go：`OPENCODE_GO_API_KEY`
- Z.ai：`ZAI_CODING_CN_API_KEY` 或 `ZAI_API_KEY`（前者优先）

关闭某项监控后，插件不再请求对应的官方接口；额度请求只带该凭据直达官方端点，不经过第三方。

## 数据与隐私

- 用量来自本机会话日志，账本保存在 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`（默认 `~/.dsh/storages/...`）。
- 首次启动会扫描历史会话并导入，之后随会话事件增量更新。
- 统计只在本地聚合，不上传用量、会话内容或账号信息；没有遥测。
- 「检查更新」只读取 npm registry 与 GitHub Release。

## 安装与更新

- 在 DSH 插件页安装 `@xfqz86/dsh-usage-stats`，或执行 `dsh plugin --profile web add @xfqz86/dsh-usage-stats`。
- 「关于」页发现新版本后可一键升级，升级后重启一次 DSH 生效。
- 卸载：`dsh plugin --profile web remove @xfqz86/dsh-usage-stats`。

更多安装方式和开发文档见 [GitHub 仓库](https://github.com/xfqz86/dsh-usage-stats)。
