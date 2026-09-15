---
name: release
description: dsh-usage-stats 的发版流程——改三处版本信息（package.json / CHANGELOG.md / docs/releases/v<版本>.md）、过验证门禁、dev 提交、PR 合 main、打 v* 标签交付 npm 与 GitHub Release；含交付形态、发布门禁与 npm 认证。凡涉及发版、发布新版本、升/改版本号、打 tag、写更新说明或 CHANGELOG 条目、生成 tarball、release 分支、npm 发布认证，或询问插件的安装/交付形态时使用。
---

# 发版（dsh-usage-stats）

本技能是「发布与交付」的唯一权威。发版不可逆——tag 一推就发 npm、建 GitHub Release，出错只能删 tag 重来，所以逐节走、每步看到结果再往下。

打包与安装的机制背景见 deepseek-harness 文档[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。

## 交付形态

发一次版要保证四种安装方式同时可用：

| 形态 | 产物 | 安装 |
|------|------|------|
| GitHub 源码 | 仓库源码，安装时 `prepare: tsdown` 自构建 | `dsh plugin add github:xfqz86/dsh-usage-stats` |
| GitHub 预构建 | `release` 分支（只含交付物） | `dsh plugin add github:xfqz86/dsh-usage-stats#release` |
| npm | `@xfqz86/dsh-usage-stats` | `dsh plugin add @xfqz86/dsh-usage-stats` |
| tarball | `xfqz86-dsh-usage-stats-<版本>.tgz` + 固定别名 `xfqz86-dsh-usage-stats.tgz` | `dsh plugin add ./xxx.tgz`，或 GitHub Releases 的 latest 固定地址（README 引用，永不变动） |

## 分支

- `dev`：开发分支，**不发布**；发版提交也从这里起步。
- `main`：生产分支；发版提交经 PR 合入，`main` 的 CI 成功后自动把交付物同步到 `release` 分支。
- `release`：机器维护（`release-branch.yml`），只有交付物，不手改、不手动 push。

## 发版步骤

### 1. 前置检查

```bash
node .agents/skills/release/scripts/release-preflight.mjs <版本号>
```

只读校验三处（`package.json` 版本、`CHANGELOG.md` 条目、`docs/releases/v<版本>.md`）是否同批就位、`[Unreleased]` 是否已清空。有 FAIL 就先补完再往下；省略版本号则取 `package.json` 当前版本。

### 2. 三处同批改（同一个提交）

| 位置 | 改什么 |
|------|--------|
| `package.json` | `version` 改成新版本，将来 tag 必须一字不差 |
| `CHANGELOG.md` | `[Unreleased]` 草稿移到 `## [<版本>] - <YYYY-MM-DD>`；清空 `[Unreleased]`；底部补 `[<版本>]` 链接，并把 `[Unreleased]` 指向新 tag |
| `docs/releases/v<版本>.md` | 面向用户的更新说明，**文件名即 tag**；缺失时 `release.yml` 直接失败，不会发布 |

### 3. 过验证门禁

先跑 `AGENTS.md` §9 的全部命令（`npx tsc --noEmit`、`npx eslint .`、`pnpm build` 与四个测试脚本），再补生产态交付物校验——CI 与发布走的都是生产态构建，开发态看不出剪枝问题。本地按下面五步走，**不能**写成 `NODE_ENV=production pnpm build && pnpm pack --dry-run`：

```bash
NODE_ENV=production pnpm build        # 1) 生产态构建（压缩、无 map）
INPUT_PATH=package.json \
  INPUT_ALLOW="name,version,description,type,main,exports,files,engines,dsh,license,repository" \
  node .github/actions/prune-package/prune.mjs   # 2) 原地剪枝并留 package.json.bak
npm pack --dry-run                    # 3) 应为 7 文件、无 *.map
mv package.json.bak package.json      # 4) 还原 package.json
pnpm build                            # 5) 恢复开发态 lib/（否则 link: 装的是生产产物）
```

两个坑：`npm pack` 会执行 `prepare: tsdown` 把开发态构建重跑一遍、覆盖生产产物，所以必须先剪枝（`scripts` 被剪掉后就不再触发 `prepare`）；且 `NODE_ENV=production` 只作用于紧随的那一条命令，写成 `&&` 链里的一段会被 pack 绕开。

### 4. 提交并推 dev

```bash
git commit -am "chore: 发布 <版本>"
git push origin dev
```

### 5. 确认后打 tag

依次等绿：`dev` 的 CI → 开 PR 合 `main`（等 PR 的 CI）→ `main` 的 CI。然后：

```bash
git checkout main && git pull
git tag v<版本> && git push origin v<版本>
```

**这一步之前要问用户。** 推送 tag 等于正式对外发布（npm + GitHub Release）；除非用户本次已明确说「直接发」，先把版本号、更新说明与 CI 结果报给用户确认。

推送后盯 `release.yml` 跑完（`gh run watch` 或网页），确认 npm 已发布、GitHub Release 正文是更新说明、附件含版本化与固定别名两份 tarball，再回报用户。

## 更新说明与 CHANGELOG 的写法

两者都**面向用户**：读者是插件用户，只写「出了什么问题、现在能看到什么变化」。

- 不写内部实现：接口改名、类型、状态码、构建、依赖、测试、文件与组件名都不进条目；纯重构与文档整理在 CHANGELOG 简记一行。
- 保留用户需要的事实：配置路径（如 `$DSH_HOME/settings.yaml`）、凭据环境变量、升级需重启 dsh 这类提醒。
- 实现细节的归属：规则进 `AGENTS.md`，机制进 `docs/*`，代码约束进注释。

## 发布门禁（改 workflow 前先读）

- `release.yml`（tag 推送）先过三道校验：tag 与 `package.json` 版本一致、`docs/releases/v<tag>.md` 存在、该提交的 CI `verify` job 成功（由 `.github/actions/gate` 查）。任一不过即失败，npm 与 Release 都不产出。
- `ci.yml`（推 dev/main、PR）：`tsc` → 生产态构建 → styles → smoke → client-bundle → 校验 `prepare` 为 `tsdown` → 剪枝 → `pack` → `verify-pack`。
- 交付物 6 项（`lib/` 内 2 个文件，合计 7 文件）：`lib/`、剪枝后 `package.json`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE`。字段白名单见 `.github/actions/prune-package/action.yml` 的 `allow`，改它要同步 `.github/actions/verify-pack`。
- 手动跑 `release.yml`（`workflow_dispatch`）只构建不发布，用于验产物。

## 一次性配置

### npm 认证（择一）

- **OIDC（推荐）**：npm 包的 Settings → Trusted Publishers 添加 `xfqz86/dsh-usage-stats` + `release.yml` + environment `npm`，workflow 自动 `npm publish --provenance`。
- **NPM_TOKEN**：npm 生成 Granular Token → 仓库 Settings → Secrets 里存 `NPM_TOKEN`。

### Fork 后要改

`package.json` 的 `repository.url`、`README.md` 里的 `xfqz86/dsh-usage-stats`、`release.yml` 的 `environment.url`；npm 认证按 OIDC 重新指向自己的仓库。

### 构建形态

`NODE_ENV=production pnpm build` 压缩、无 sourcemap（CI 与发布用）；本地 `pnpm build` 是开发态（可读 + `*.map`）。
