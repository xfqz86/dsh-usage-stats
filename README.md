# dsh-usage-stats — DSH 用量统计插件

DSH 的 Web 用量统计插件，按模型、会话、日期三个维度统计 token 用量与调用次数，挂载于侧边栏底部展示今日用量，点击打开详情面板。

<div align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="Powered by DSH" src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" /></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/@xfqz86/dsh-usage-stats"><img alt="NPM Downloads" src="https://img.shields.io/npm/d18m/%40xfqz86%2Fdsh-usage-stats?style=flat-square&logo=npm&logoColor=white&label=NPM%20%E4%B8%8B%E8%BD%BD%E9%87%8F" /></a>
  &nbsp;
  <a href="https://github.com/xfqz86/dsh-usage-stats/releases/latest/"><img alt="GitHub Downloads" src="https://img.shields.io/github/downloads/xfqz86/dsh-usage-stats/xfqz86-dsh-usage-stats.tgz?displayAssetName=false&style=flat-square&logo=github&logoColor=white&label=Github%20%E4%B8%8B%E8%BD%BD%E9%87%8F" /></a>
  &nbsp;
  <a href="https://github.com/xfqz86/dsh-usage-stats"><img alt="GitHub stars" src="https://img.shields.io/github/stars/xfqz86/dsh-usage-stats" /></a>
  &nbsp;
  <a href="https://github.com/xfqz86/dsh-usage-stats/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/xfqz86/dsh-usage-stats?style=flat-square&logoColor=white" /></a>
</div>

## 功能

- 侧边栏底部常驻今日用量，宽列与收起状态自适应展示；点击打开详情面板
- 概览：今日与总计、每日热力图，以及下面三项额度卡片
- 按日期、会话、模型分别统计 token 用量
- 日期页每行末尾点「明细」，弹窗看这一天分别花在哪些会话、哪些模型上
- 模型页每行末尾点「明细」，弹窗看这块模型的每日用量与用它的会话
- 会话页主会话行末尾点「明细」，弹窗看这条会话的用量按日期、按模型摊开，子会话一并计入
- 模型统计重定向：可以把某个供应商的某个模型的用量算到另一个供应商的某个模型名下
- DeepSeek 余额，展示多币种余额
- OpenCode Go 额度，展示滚动 5 小时、本周、本月三档已使用额度
- Z.ai 额度，展示滚动 5 小时、本周已使用额度，以及每月 Web 搜索次数
- 会话标题旁 session-id 徽标，支持一键复制

<p align="center">
  <img src="https://raw.githubusercontent.com/xfqz86/dsh-usage-stats/main/docs/screenshot/footer.png" alt="侧边栏底部" width="320" />
  <br>
  <em>侧边栏底部</em>
</p>

<table>
  <tr>
    <td align="center" width="20%">
      <img src="https://raw.githubusercontent.com/xfqz86/dsh-usage-stats/main/docs/screenshot/01-overview.png" alt="概览" />
      <br>
      <sub>概览</sub>
    </td>
    <td align="center" width="20%">
      <img src="https://raw.githubusercontent.com/xfqz86/dsh-usage-stats/main/docs/screenshot/02-dates.png" alt="日期" />
      <br>
      <sub>日期</sub>
    </td>
    <td align="center" width="20%">
      <img src="https://raw.githubusercontent.com/xfqz86/dsh-usage-stats/main/docs/screenshot/03-sessions.png" alt="会话" />
      <br>
      <sub>会话</sub>
    </td>
    <td align="center" width="20%">
      <img src="https://raw.githubusercontent.com/xfqz86/dsh-usage-stats/main/docs/screenshot/04-models.png" alt="模型" />
      <br>
      <sub>模型</sub>
    </td>
    <td align="center" width="20%">
      <img src="https://raw.githubusercontent.com/xfqz86/dsh-usage-stats/main/docs/screenshot/05-settings.png" alt="设置" />
      <br>
      <sub>设置</sub>
    </td>
  </tr>
</table>

## 安装与卸载

### 在 DeepSeek Harness 网页版或桌面版中安装

在 **添加插件** 向导的「包名或地址」输入框中填写 `@xfqz86/dsh-usage-stats`，然后点击 **安装**：

![Add_plugin_wizard](https://raw.githubusercontent.com/xfqz86/dsh-usage-stats/main/docs/screenshot/install-help.png)

你也可以填入 `github:xfqz86/dsh-usage-stats#release`，来体验最新代码（可能包含未开发完成的功能）。

---

### 使用 `dsh` CLI 安装

```bash
# 安装最新发行版
dsh plugin --profile web add @xfqz86/dsh-usage-stats
```

```bash
# 安装最新代码版本（可能包含未开发完成的功能）
dsh plugin --profile web add github:xfqz86/dsh-usage-stats#release
```

---

### 更新插件

```sh
dsh plugin --profile web update @xfqz86/dsh-usage-stats
```

---

### 本地开发

```bash
git clone https://github.com/xfqz86/dsh-usage-stats.git
cd dsh-usage-stats
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add "link:$(pwd)"
# 后续改动后重新 pnpm build，浏览器刷新即可；服务端改动需重启 dsh
```

### 卸载

```bash
dsh plugin --profile web remove @xfqz86/dsh-usage-stats
```

## 设置

设置位于详情面板的设置 Tab，保存在 DSH 该 profile 的配置文件 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（`$DSH_HOME` 未设置的情况下默认为 `~/.dsh`）的 `usage-stats` 条目里。配置文件只写改过的字段。

设置 Tab 可改：三项额度监控的开关、是否在侧边栏展示、抓取间隔（最短 3 分钟），会话标题旁 session-id 徽标开关，以及模型统计重定向规则。

设置 Tab 的「配置迁移」折叠区可以把当前偏好导出成一串配置串（Base64 文本，直接复制粘贴即可），在别的机器、别的 profile 的设置 Tab 里粘贴导入：导入以配置串为准整份覆盖，配置串里没有的项回到默认值，适合备份还原与两台机器对齐。

设置 Tab 底部的「账本操作」折叠区为清零与重建，需二次确认；扫描历史会话期间（面板顶部显示“扫描中…”）两项置灰不可点，等扫描结束自动恢复。

需展示额度时，在 DSH 凭据中心配置对应 Key（同名多项时按顺序取第一个配好的）：

- DeepSeek：`DEEPSEEK_API_KEY`（也认 `DEEPSEEK_APIKEY`、`DEEPSEEK_API_TOKEN`、`DEEPSEEK_TOKEN`）
- OpenCode Go：`OPENCODE_GO_API_KEY`
- Z.ai：`ZAI_CODING_CN_API_KEY` 或 `ZAI_API_KEY`（前者优先）

## 数据存储

账本位于 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`。首次启动自动扫描历史会话并导入，之后随事件增量更新，重启后从账本恢复。

## 开发者

- 工程规范见 `AGENTS.md`
- 架构、数据流与统计口径见 `docs/ARCHITECTURE.md`
- 风格经验（lint 之外的统一约定）见 `docs/STYLE.md`
- 接口协议见 `docs/API.md`
- 模块结构见 `docs/STRUCTURE.md`，由 `pnpm tree` 生成
- 发布流程见 `.agents/skills/release/SKILL.md`（发版技能，可直接加载执行）
- 更新日志见 `CHANGELOG.md`，每次发版同步记录功能更新与 Bug 修复

## License

MIT
