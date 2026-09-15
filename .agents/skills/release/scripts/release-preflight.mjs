#!/usr/bin/env node
/**
 * 发版前置检查：只读校验发版三处（package.json 版本、CHANGELOG 条目、更新说明文件）是否已同批就位。
 *
 * 三处缺一，要么 CI 挂、要么拖到推 tag 时才被 release.yml 的校验拦下，而 tag 推送后
 * 再改要删 tag 重发；故把一致性检查提前到本地。流程与门禁见同目录上一级的 SKILL.md。
 *
 * 用法：node .agents/skills/release/scripts/release-preflight.mjs [版本号]
 *      省略版本号则取 package.json 的 version；须在仓库内运行（向上找 package.json 定位仓库根）。
 * 退出码：0 无 FAIL；1 存在 FAIL（WARN 不阻断）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 从脚本所在目录向上找含 package.json 的目录作仓库根（不依赖脚本深度）。 */
function findRoot() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return dirname(fileURLToPath(import.meta.url))
    dir = parent
  }
}

const ROOT = findRoot()

/** 语义化版本形态（允许 -rc.1 一类预发布后缀）。 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 收集到的检查结果，按出现顺序输出。 */
const results = []
let failed = 0

/** 记录一条结果；FAIL 计入退出码。 */
function report(level, title, hint) {
  if (level === 'FAIL') failed += 1
  results.push({ level, title, hint })
}

/** 读文件，缺失或不可读返回 null。 */
function readMaybe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 取二级标题 `headingPrefix` 到下一个二级标题之间的正文；无该标题返回 null。 */
function section(body, headingPrefix) {
  const all = body.split('\n')
  const start = all.findIndex((line) => line.startsWith(headingPrefix))
  if (start === -1) return null
  const rest = all.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

const pkgText = readMaybe(join(ROOT, 'package.json'))
if (pkgText === null) {
  console.error(`找不到 ${join(ROOT, 'package.json')} — 本脚本须在仓库内运行。`)
  process.exit(1)
}
const pkg = JSON.parse(pkgText)
const target = String(process.argv[2] || pkg.version).replace(/^v/, '')

// ——— 版本号与 package.json ———
if (SEMVER.test(target)) report('PASS', `版本号 ${target} 合法`)
else report('FAIL', `版本号 ${target} 不是语义化版本`, '形如 0.5.0 或 0.5.0-rc.1')

if (pkg.version === target) report('PASS', `package.json version = ${target}`)
else report('FAIL', `package.json version 仍是 ${pkg.version}`, `把它改成 ${target}`)

// ——— docs/releases/v<版本>.md ———
const notesRel = `docs/releases/v${target}.md`
const notes = readMaybe(join(ROOT, notesRel))
if (notes === null) {
  report('FAIL', `缺少 ${notesRel}`, 'release.yml 校验它存在且文件名等于 tag，缺失即不发布')
} else if (notes.replace(/^#.*$/gm, '').trim().length < 20) {
  report('FAIL', `${notesRel} 正文过空`, '写清楚这个版本用户能看到什么变化')
} else {
  report('PASS', `${notesRel} 存在且非空`)
}

// ——— CHANGELOG ———
const changelog = readMaybe(join(ROOT, 'CHANGELOG.md'))
if (changelog === null) {
  report('FAIL', '缺少 CHANGELOG.md')
} else {
  const entry = section(changelog, `## [${target}]`)
  if (entry === null) {
    report('FAIL', `CHANGELOG.md 无 ## [${target}] 条目`, '把 [Unreleased] 草稿移到该版本标题下')
  } else if (!/^[ \t]*[-*] /m.test(entry)) {
    report('FAIL', `CHANGELOG.md 的 [${target}] 条目没有内容`, '每个版本至少一条面向用户的条目')
  } else {
    report('PASS', `CHANGELOG.md 有 [${target}] 条目`)
  }

  const hasLink = changelog.split('\n').some((line) => line.startsWith(`[${target}]:`))
  if (hasLink) report('PASS', `CHANGELOG.md 底部有 [${target}] 链接定义`)
  else report('FAIL', `CHANGELOG.md 底部缺 [${target}] 链接定义`, '补一行该版本的比较链接')

  const unreleased = section(changelog, '## [Unreleased]')
  if (unreleased === null) {
    report('WARN', 'CHANGELOG.md 无 [Unreleased] 段', '按 Keep a Changelog 应保留该段')
  } else {
    const pending = unreleased
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('###')).length
    if (pending > 0) {
      report('FAIL', `[Unreleased] 还有 ${pending} 行未归档`, `把它们移入 [${target}] 再发版`)
    } else {
      report('PASS', '[Unreleased] 已清空')
    }
  }

  const unreleasedLink = /^\[Unreleased\]:[ \t]*(\S+)/m.exec(changelog)
  if (unreleasedLink === null) {
    report('WARN', '[Unreleased] 无链接定义')
  } else if (unreleasedLink[1].includes(`v${target}...HEAD`)) {
    report('PASS', `[Unreleased] 链接已指向 v${target}`)
  } else {
    report('WARN', `[Unreleased] 链接未指向 v${target}`, `当前为 ${unreleasedLink[1]}`)
  }
}

// ——— git 状态（只提示，不阻断） ———
try {
  // stderr 吞掉：不在 git 仓库时 git 会自行打印错误，此处只需静默回退到 WARN
  const git = (args) =>
    execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'dev') report('PASS', '当前分支 dev（发版提交从这里起步）')
  else report('WARN', `当前分支是 ${branch}`, '发版提交走 dev，再 PR 合 main')

  if (git(['status', '--porcelain'])) report('WARN', '工作区有未提交改动', '改完三处一起提交；打 tag 前工作区应干净')
  else report('PASS', '工作区干净')

  if (git(['tag', '-l', `v${target}`])) report('WARN', `tag v${target} 已存在`, '需重发先 git push --delete origin 该 tag')
  else report('PASS', `tag v${target} 未被占用`)
} catch {
  report('WARN', '跳过 git 检查（git 不可用或不在仓库内）')
}

// ——— 输出 ———
const marks = {PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN'}
console.log(`\n发版前置检查 · 目标版本 ${target}`)
for (const {level, title, hint} of results) {
  console.log(`  ${marks[level]}  ${title}`)
  if (hint) console.log(`        ↳ ${hint}`)
}
const warns = results.filter((r) => r.level === 'WARN').length
console.log(`\n结果：${failed} 项 FAIL，${warns} 项 WARN`)
if (failed > 0) {
  console.log('补齐后重跑本脚本，再走 AGENTS.md §9 的验证门禁。')
  process.exit(1)
}
console.log(`下一步：跑 AGENTS.md §9 门禁 → commit → push dev → PR 合 main → 等 CI 全绿 → git tag v${target}（推 tag 前与用户确认）`)
