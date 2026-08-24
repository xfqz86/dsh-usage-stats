# 发布流程

本项目通过 GitHub Actions 交付三种形态（见 [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）：

| 形态 | 产物 | 安装方式 |
|------|------|----------|
| GitHub 源码 | 仓库源码 + `prepare: tsdown` | `dsh plugin add github:xfqz86/dsh-usage-stats` |
| GitHub 预构建 | `release` 分支（仅 `lib/` + `package.json` + `cordis.patch.yml` + `README.md`） | `dsh plugin add github:xfqz86/dsh-usage-stats#release` |
| npm | `@xfqz86/dsh-usage-stats`（预构建，已剪枝） | `dsh plugin add @xfqz86/dsh-usage-stats` |
| tarball | `xfqz86-dsh-usage-stats-*.tgz`（同 npm 内容） | `dsh plugin add ./xfqz86-dsh-usage-stats-*.tgz` |

所有可分发产物（`release` 分支 / npm / tarball）均仅包含 4 项：`lib/`、`package.json`（剪枝后仅 `name/version/description/type/main/exports/files/engines/dsh/license`）、`cordis.patch.yml`、`README.md`（`lib` 内为压缩后的 `index.js` / `client.js` 共 2 文件，无 `*.map`，合计 5 文件）。源码（`src/`、`tsconfig.json`、`scripts/`、`test/` 等）不在交付物中。

## 工作流

- **CI**（`.github/workflows/ci.yml`）：`push` 到 `dev/main` 与 PR 触发，执行 `tsc --noEmit`、`NODE_ENV=production pnpm build`（压缩，无 map）、`node test/smoke.mjs`、`node test/client-bundle.mjs`、剪枝 `package.json` 后 `pnpm pack` 校验（仅上述 4 项，5 文件）。
- **Sync release branch**（`.github/workflows/release-branch.yml`）：`push` 到 `main` 时自动 `NODE_ENV=production pnpm build`（压缩，无 map）、剪枝 `package.json`，组装仅含上述 4 项的最小 `release` 分支（无源码，`orphan/clean` 覆盖），保障 `github:xfqz86/dsh-usage-stats#release` 预构建安装可用。`dev` 为开发分支，不触发发布。
- **Release**（`.github/workflows/release.yml`）：推送 `v*` 标签时触发（通常从 `main` 打 tag），校验 `tag` 与 `package.json` 版本一致，`NODE_ENV=production pnpm build` 后剪枝 `package.json` + `npm pack` 生成 tarball（压缩，无 map），上传为 workflow artifact，并发布到 npm（支持 OIDC trusted publishing 或 `NPM_TOKEN`）与 GitHub Release。

构建由 `tsdown.config.ts` 根据 `NODE_ENV` 区分：`production` 时压缩且无 `sourcemap`（交付物），其他环境（本地 `pnpm build`）保留可读性与 `*.map` 便于调试。剪枝由 `scripts/prune-package.mjs` 执行，白名单：`name, version, description, type, main, exports, files, engines, dsh, license`。`scripts`、`devDependencies`、`packageManager`、`repository` 等开发态字段在交付物中剥离；`prepare: tsdown` 仅保留在 `dev` 分支供 `github:xfqz86/dsh-usage-stats` 源码安装时自动构建（此时为开发态，未压缩）。

## 本地验证

```bash
npx tsc --noEmit
pnpm build            # 本地调试：未压缩，带 *.map（tsdown 默认开发态）
ls -lh lib/           # index.js ~37k, client.js ~112k, 含 *.map
node test/smoke.mjs
node test/client-bundle.mjs

# 产出校验（需生产态，压缩无 map，5 文件）
NODE_ENV=production pnpm build
ls -lh lib/           # index.js ~17k, client.js ~62k, 无 *.map
node scripts/prune-package.mjs
pnpm pack --dry-run   # 5 文件：lib 2 + 顶部 3，且 package.json 已剪枝
ls lib/*.map 2>&1 | grep -q "No such" && echo "no map - ok (production)"
```

## 发布到 npm

`dev` 仅用于开发，不直接发布。发布需先合到 `main`，再在 `main` 上打 tag：

1. 合并 `dev` → `main` 并更新版本：
   ```bash
   git checkout main
   git merge dev
   # 编辑 package.json version（如 0.1.0 → 0.2.0）
   git commit -am "chore: bump v0.2.0"
   git push origin main   # 触发 sync-release-branch → 更新 release 分支（最小 5 文件）
   ```
2. 在 `main` 上打标签并推送：
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. GitHub Actions 自动：
   - 校验 `release` 分支已在 `main` 推送时同步为最小交付物（5 文件，无 map，已压缩）
   - 构建并生成 `xfqz86-dsh-usage-stats-0.2.0.tgz`（`package/` 目录 + artifact + Release 附件，同样仅含上述 4 项/5 文件）
   - 发布至 `https://www.npmjs.com/package/@xfqz86/dsh-usage-stats`

## npm 认证配置（择一）

**方式一：OIDC trusted publishing（推荐，无 token）**：

1. 在 [npmjs.com](https://www.npmjs.com) 进入包 Settings → Trusted Publishers → Add publisher
2. 选择 GitHub Actions，填入：
   - Organization：`xfqz86`
   - Repository：`dsh-usage-stats`
   - Workflow：`release.yml`
   - Environment：`npm`

此后 `release.yml` 的 `id-token: write` 权限将通过 OIDC 自动完成 `npm publish --provenance`。

**方式二：NPM_TOKEN**：

1. 在 npmjs 生成 Granular Access Token（publish 权限）
2. 在 GitHub 仓库 Settings → Secrets and variables → Actions → New secret
3. 名称 `NPM_TOKEN`，值为 token
4. workflow 会自动回退到 `NODE_AUTH_TOKEN` 方式发布

## 仓库地址

当前仓库：`https://github.com/xfqz86/dsh-usage-stats`（`package.json` 的 `repository.url` 已对齐）

Fork 或迁移后请同步修改：

- `package.json` → `repository.url`
- `README.md` 中的 `xfqz86/dsh-usage-stats`
- `.github/workflows/release.yml` 中 `environment.url`（可选）
