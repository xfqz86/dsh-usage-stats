# 发布流程

通过 GitHub Actions 交付四种形态（见[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）：

| 形态 | 产物 | 安装 |
|------|------|------|
| GitHub 源码 | 仓库源码 + `prepare: tsdown` | `dsh plugin add github:xfqz86/dsh-usage-stats` |
| GitHub 预构建 | `release` 分支（仅 `lib/` + `package.json` + `cordis.patch.yml` + `README.md` + `CHANGELOG.md` + `LICENSE`） | `dsh plugin add github:xfqz86/dsh-usage-stats#release` |
| npm | `@xfqz86/dsh-usage-stats` | `dsh plugin add @xfqz86/dsh-usage-stats` |
| tarball | `xfqz86-dsh-usage-stats-*.tgz` + 固定别名 `xfqz86-dsh-usage-stats.tgz` | `dsh plugin add ./xxx.tgz` 或 `.../releases/latest/download/xfqz86-dsh-usage-stats.tgz` |

交付物仅含 6 项（`lib/` 内为压缩后的 `index.js` / `client.js`，无 `*.map`，合计 7 文件）：`lib/`、`package.json`（剪枝后仅保留 `name/version/description/type/main/exports/files/engines/dsh/license` + `repository`）、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE`。

## 工作流

| 工作流 | 触发 | 动作 |
|--------|------|------|
| CI (`ci.yml`) | `push` 到 `dev`/`main`、PR | `tsc` + `build` + `smoke` + `client-bundle` + `prune` + `pack` 校验 |
| Sync release branch (`release-branch.yml`) | `push` 到 `main` | 生产态构建 + 剪枝，覆盖 `release` 分支（`dev` 不触发） |
| Release (`release.yml`) | 推送 `v*` 标签 | 校验 tag 与版本一致且 `docs/releases/v<版本>.md` 存在，构建并发布 npm + GitHub Release（正文取该说明文件，附件含版本化与固定别名两份 tarball） |

构建区分：`NODE_ENV=production` 时压缩且无 sourcemap（交付物），本地 `pnpm build` 为开发态（可读 + `*.map`）。剪枝由 `.github/actions/prune-package` 执行（可本地 `node .github/actions/prune-package/prune.mjs`）。

## 本地验证

```bash
npx tsc --noEmit && pnpm build && node test/smoke.mjs && node test/client-bundle.mjs

# 生产态校验
NODE_ENV=production pnpm build
pnpm pack --dry-run   # 应为 7 文件，无 *.map
```

## 发布步骤

`dev` 为开发分支，不直接发布；发版提交走 PR 合到 `main`，再在 `main` 上打 tag：

```bash
# 1) 在 dev 上准备发版提交，三处同批改完：
#    package.json version、CHANGELOG.md 该版本条目（Unreleased 草稿后移并清空）、
#    docs/releases/v<版本>.md（面向用户的更新说明，见下节）
git commit -am "chore: 发布 0.3.0" && git push origin dev

# 2) 等 dev 的 CI 通过，开 PR 合到 main，等 PR 的 CI 通过后合并

# 3) 等 main 上的 CI 通过（tag 发布的 gate 以此为前提），再打 tag
git checkout main && git pull
git tag v0.3.0 && git push origin v0.3.0  # 触发 Release：发布 npm + GitHub Release
```

## 更新说明（GitHub Release 正文）

`docs/releases/v<版本>.md` 就是 GitHub Release 的正文，每个版本必须新增：

- **面向用户写**：这个版本做了什么、用户能看到什么变化，说清结果即可。
- **不写内部实现**：接口改名、类型、构建、依赖、测试这类细节留在 `CHANGELOG.md`，不进这里。
- **文件名等于 tag**：`v0.3.0` → `docs/releases/v0.3.0.md`。`release.yml` 在 tag 校验阶段强制该文件存在，缺失直接失败，不会发布到 npm 也不会建 Release。

即 `CHANGELOG.md` 记开发者视角的完整改动，`docs/releases/*.md` 记用户视角的更新说明，两者随发版同批更新。

## npm 认证（择一）

- **OIDC（推荐）**：npm 包 Settings → Trusted Publishers → 添加 `xfqz86/dsh-usage-stats` + `release.yml` + `npm`，workflow 自动 `npm publish --provenance`。
- **NPM_TOKEN**：npm 生成 Granular Token → GitHub 仓库 Settings → Secrets → `NPM_TOKEN`。

## 仓库迁移

Fork 后同步修改 `package.json: repository.url`、`README.md` 中的 `xfqz86/dsh-usage-stats`、`.github/workflows/release.yml` 的 `environment.url`（可选）。
