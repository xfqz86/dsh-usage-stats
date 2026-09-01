# 发布流程

通过 GitHub Actions 交付四种形态（见[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）：

| 形态 | 产物 | 安装 |
|------|------|------|
| GitHub 源码 | 仓库源码 + `prepare: tsdown` | `dsh plugin add github:xfqz86/dsh-usage-stats` |
| GitHub 预构建 | `release` 分支（仅 `lib/` + `package.json` + `cordis.patch.yml` + `README.md` + `LICENSE`） | `dsh plugin add github:xfqz86/dsh-usage-stats#release` |
| npm | `@xfqz86/dsh-usage-stats` | `dsh plugin add @xfqz86/dsh-usage-stats` |
| tarball | `xfqz86-dsh-usage-stats-*.tgz` + 固定别名 `xfqz86-dsh-usage-stats.tgz` | `dsh plugin add ./xxx.tgz` 或 `.../releases/latest/download/xfqz86-dsh-usage-stats.tgz` |

交付物仅含 5 项（`lib/` 内为压缩后的 `index.js` / `client.js`，无 `*.map`，合计 6 文件）：`lib/`、`package.json`（剪枝后仅保留 `name/version/description/type/main/exports/files/engines/dsh/license` + `repository`）、`cordis.patch.yml`、`README.md`、`LICENSE`。

## 工作流

| 工作流 | 触发 | 动作 |
|--------|------|------|
| CI (`ci.yml`) | `push` 到 `dev`/`main`、PR | `tsc` + `build` + `smoke` + `client-bundle` + `prune` + `pack` 校验 |
| Sync release branch (`release-branch.yml`) | `push` 到 `main` | 生产态构建 + 剪枝，覆盖 `release` 分支（`dev` 不触发） |
| Release (`release.yml`) | 推送 `v*` 标签 | 校验 tag 与版本一致，构建并发布 npm + GitHub Release（含版本化与固定别名两份 tarball） |

构建区分：`NODE_ENV=production` 时压缩且无 sourcemap（交付物），本地 `pnpm build` 为开发态（可读 + `*.map`）。剪枝由 `.github/actions/prune-package` 执行（可本地 `node .github/actions/prune-package/prune.mjs`）。

## 本地验证

```bash
npx tsc --noEmit && pnpm build && node test/smoke.mjs && node test/client-bundle.mjs

# 生产态校验
NODE_ENV=production pnpm build
pnpm pack --dry-run   # 应为 6 文件，无 *.map
```

## 发布步骤

`dev` 为开发分支，不直接发布。需先合到 `main` 再打 tag：

```bash
git checkout main && git merge dev
# 编辑 package.json version
git commit -am "chore: bump v0.2.0" && git push origin main  # 同步 release 分支

git tag v0.2.0 && git push origin v0.2.0  # 触发 Release：发布 npm + GitHub Release
```

## npm 认证（择一）

- **OIDC（推荐）**：npm 包 Settings → Trusted Publishers → 添加 `xfqz86/dsh-usage-stats` + `release.yml` + `npm`，workflow 自动 `npm publish --provenance`。
- **NPM_TOKEN**：npm 生成 Granular Token → GitHub 仓库 Settings → Secrets → `NPM_TOKEN`。

## 仓库迁移

Fork 后同步修改 `package.json: repository.url`、`README.md` 中的 `xfqz86/dsh-usage-stats`、`.github/workflows/release.yml` 的 `environment.url`（可选）。
