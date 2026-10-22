#!/usr/bin/env node
/**
 * 生成 docs/STRUCTURE.md：反射仓库真实结构，避免目录树手写漂移。
 *
 * 每个文件的一行职责 = 其头部块注释的首句；无头注 / 非代码文件写固定备注。
 * 改动代码结构后运行 `pnpm tree` 重新生成，生成文件勿手改。
 * 加 --check 只比对不写盘，供 CI 与发版前置检查使用。
 * docs/releases 只列目录不逐文件：发版必然新增 v<版本>.md，逐文件列出会让本文件每次发版都过期，且这些行没有文件级职责信息。
 *
 * 为什么有这个脚本：AGENTS.md 是被注入的规则文件，目录树这类随代码频繁变化
 * 的现状快照不能放进去（会频繁失效注入前缀缓存），需要一份可再生成、可维护
 * 的独立结构文档。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 仓库根（脚本位于 <root>/scripts/）。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 不入树的内容：构建产物 / 依赖 / 版本控制 / 本机私有 / 系统文件。 */
const EXCLUDED = new Set([
  'node_modules', 'lib', '.git', '.DS_Store',
  'AGENTS.local.md', 'CLAUDE.local.md', 'pnpm-debug.log',
])

/** 点开头条目默认不入树（本机 / 工具目录），白名单内纳入：CI、git 规则与发版技能属仓库内容。 */
const DOT_ALLOW = new Set(['.agents', '.github', '.gitignore'])

/** .gitignore 路径（用于尊重 git 忽略规则）。 */
const GITIGNORE_PATH = join(ROOT, '.gitignore')

/** 需提取头注的扩展名白名单（其余扩展名走固定备注或留空）。 */
const HEADER_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css'])

/** 非代码文件的固定职责备注（以相对仓库根路径为键；这些文件无块注释可提取）。 */
const NOTES = {
  '.gitignore': 'git 忽略规则（不入库清单：产物 / 锁目录 / 本机私有）',
  '.github/actions/gate/action.yml': 'Gate 复合动作（gate-ci）：校验指定 SHA 的 CI job 是否已成功（release 发布前强制验证）',
  '.github/actions/prune-package/action.yml': '剪枝复合动作：把 package.json 剪到发布所需最小字段白名单',
  '.github/actions/setup/action.yml': '统一 JS 环境复合动作：pnpm + Node（缓存 pnpm）+ 依赖安装',
  '.github/actions/verify-pack/action.yml': '校验复合动作：交付物仅含白名单文件且 package.json 已剪枝',
  '.github/workflows/ci.yml': 'CI：类型检查 / 目录结构新鲜度 / 生产态构建 / 样式与冒烟测试 / 打包校验（每次 PR、推送 dev/main 与手动触发执行）',
  '.github/workflows/release-branch.yml': '同步 release 分支：仅含预构建交付物的最小形态（GitHub 安装路径）',
  '.github/workflows/release.yml': '发布到 npm 与交付 tarball（GitHub Release 附件只附固定别名；版本化产物走 workflow artifact）',
  '.agents/skills/release/SKILL.md': '发版技能：发布与交付的唯一权威（交付形态 / 发版步骤 / 门禁 / npm 认证）',
  'docs/API.md': 'Remote 协议与偏好设置约定（随接口演进维护）',
  'docs/ARCHITECTURE.md': '架构与统计口径唯一权威（账本/数据流/折叠/墓碑/口径；AGENTS.md 只留规则与指针）',
  'docs/STYLE.md': '风格经验沉淀（lint 之外的统一约定，新会话先读）',
  'docs/STRUCTURE.md': '生成文件：由 `pnpm tree` 重新生成，勿手改',
  'AGENTS.md': '工程规范（注入的规则文件；仅规则变化时改，结构现状不进这里）',
  'README.md': '面向普通用户的功能说明',
  'CHANGELOG.md': '更新日志（每次发版同步记录功能更新与 Bug 修复）',
  'cordis.patch.yml': '组合包 patch（dsh.bundle.patch）：插入插件条目',
  'icon.svg': '插件图标（package.json icon）：dsh 插件列表展示用',
  'package.json': '组合包元数据 / exports / 构建脚本',
  'screenshots.json': '插件市场展示用的截图清单',
  'pnpm-lock.yaml': '锁文件（不手改）',
  'pnpm-workspace.yaml': 'pnpm 工作区（含版本保鲜期白名单）',
  'tsconfig.json': 'TS 编译配置（严格模式）',
  'tsdown.config.ts': '双 bundle 构建配置（host ESM + client CJS）',
}

/** 目录级剪枝：目录路径 → 一行说明；命中的目录只输出目录行，不递归列子项（原因见头部注释）。 */
const DIR_NOTES = {
  'docs/releases': '各版本更新说明（按版本累积，不逐文件列出）',
}

// ——— .gitignore 尊重逻辑（优先 git check-ignore，无依赖；失败回退到解析 .gitignore） ———

/** 将相对路径统一转为 POSIX 形式（/ 分隔）。 */
function toPosix(p) {
  return p.split(sep).join('/')
}

/** glob 转正则核心（处理 *、?、**、[]）。 */
function globToRegexCore(glob) {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*\\/)?'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i += 1
      }
    } else if (c === '?') {
      re += '[^/]'
      i += 1
    } else if (c === '[') {
      let j = i + 1
      while (j < glob.length && glob[j] !== ']') j += 1
      if (j < glob.length) {
        re += glob.slice(i, j + 1)
        i = j + 1
      } else {
        re += '\\['
        i += 1
      }
    } else {
      if ('+.^$()|{}[]\\'.includes(c)) re += '\\' + c
      else re += c
      i += 1
    }
  }
  return re
}

/** fallback 解析缓存。 */
let fallbackPatterns = null
/** git 可用性缓存：null 未探测，true/false 已探测。 */
let gitAvailable = null
/** 已计算的忽略集合（相对 POSIX 路径）。 */
let ignoreSet = null

/** 加载并解析 .gitignore 为模式对象数组（按出现顺序，后者覆盖前者）。 */
function loadFallbackPatterns() {
  if (fallbackPatterns !== null) return fallbackPatterns
  fallbackPatterns = []
  let content = ''
  try {
    content = readFileSync(GITIGNORE_PATH, 'utf8')
  } catch {
    return fallbackPatterns
  }
  const lines = content.split(/\r?\n/)
  for (let raw of lines) {
    // 去除首尾空白（git 会 trim 未转义的空格）
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // 处理转义的前导 # / !
    if (raw.trimStart().startsWith('\\#') || raw.trimStart().startsWith('\\!')) {
      raw = raw.trimStart().slice(1)
    }
    let line = trimmed
    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1).trim()
      if (!line) continue
    }
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    let patternBody = dirOnly ? line.slice(0, -1) : line
    const anchored = patternBody.startsWith('/')
    if (anchored) patternBody = patternBody.slice(1)
    const containsSlash = patternBody.includes('/')
    const isBasename = !anchored && !containsSlash
    const core = globToRegexCore(patternBody)
    let regex
    if (isBasename) {
      // 基名模式：匹配任意层级的段（git 无斜杠时匹配任意层）
      regex = new RegExp('^' + core + '$')
    } else if (dirOnly) {
      regex = new RegExp('^' + core + '(?:/.*)?$')
    } else {
      regex = new RegExp('^' + core + '$')
    }
    fallbackPatterns.push({ negated, regex, isBasename, dirOnly, patternBody })
  }
  return fallbackPatterns
}

/** 回退：用解析的 .gitignore 模式判断单个相对路径是否被忽略。 */
function isIgnoredByFallback(relPosix) {
  const patterns = loadFallbackPatterns()
  if (patterns.length === 0) return false
  let ignored = false
  const segments = relPosix.split('/')
  for (const p of patterns) {
    let matched = false
    if (p.isBasename) {
      // 无斜杠模式匹配任意层级的段（目录忽略则其后代亦忽略，段匹配即代表忽略）
      matched = segments.some((seg) => p.regex.test(seg))
    } else {
      matched = p.regex.test(relPosix)
    }
    if (matched) ignored = !p.negated
  }
  return ignored
}

/** 探测 git 是否可用。 */
function ensureGitAvailable() {
  if (gitAvailable !== null) return gitAvailable
  try {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' })
    gitAvailable = probe.status === 0 && !probe.error
  } catch {
    gitAvailable = false
  }
  return gitAvailable
}

/** 构建忽略集合（单次批量 git check-ignore；失败回退到解析）。 */
function ensureIgnoreSet() {
  if (ignoreSet !== null) return ignoreSet
  ignoreSet = new Set()
  // 收集候选相对路径（沿用 EXCLUDED + 隐藏文件过滤，避免遍历巨大的被排除目录）
  const allRels = []
  function collect(abs) {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const name = ent.name
      if (EXCLUDED.has(name) || name.startsWith('.')) continue
      const full = join(abs, name)
      const rel = toPosix(full.slice(ROOT.length + 1))
      allRels.push(rel)
      if (ent.isDirectory()) collect(full)
    }
  }
  try {
    collect(ROOT)
  } catch (_e) {}
  if (allRels.length === 0) return ignoreSet

  if (ensureGitAvailable()) {
    try {
      const input = Buffer.from(allRels.join('\0') + '\0')
      const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
        cwd: ROOT,
        input,
        maxBuffer: 10 * 1024 * 1024,
      })
      if (!result.error && (result.status === 0 || result.status === 1)) {
        const out = result.stdout ? result.stdout.toString('utf8') : ''
        const ignored = out.split('\0').filter(Boolean).map((p) => toPosix(p))
        for (const p of ignored) ignoreSet.add(p)
        return ignoreSet
      }
    } catch {
      // 回退到解析
    }
  }
  // git 不可用或失败：逐一用 fallback 判断
  for (const rel of allRels) {
    if (isIgnoredByFallback(rel)) ignoreSet.add(rel)
  }
  return ignoreSet
}

/** 判断相对 POSIX 路径是否被 git 忽略（基于缓存的 ignoreSet）。 */
function isGitIgnored(relPosix) {
  if (!relPosix) return false
  const set = ensureIgnoreSet()
  return set.has(relPosix)
}

/** 取一段文本中首个块注释的首句（到中文句号为止）。 */
function firstSentence(text) {
  const m = /\/\*\*?([\s\S]*?)\*\//.exec(text)
  if (!m) return ''
  const joined = m[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
  const end = joined.search(/[。！？!?]/)
  const sentence = end === -1 ? joined : joined.slice(0, end + 1)
  return sentence.trim()
}

/** 文件的一行职责：固定备注优先，其次代码文件头注首句，否则空串。 */
function annotationOf(rel, file) {
  if (NOTES[rel]) return NOTES[rel]
  const ext = file.slice(file.lastIndexOf('.'))
  if (!HEADER_EXTS.has(ext)) return ''
  try {
    return firstSentence(readFileSync(file, 'utf8'))
  } catch {
    return ''
  }
}

/** 目录项按「目录在前、文件在后，各自按字典序」排列，并过滤 .gitignore 忽略项。 */
function list(dir) {
  const raw = readdirSync(dir).filter(
    (name) => !EXCLUDED.has(name) && (!name.startsWith('.') || DOT_ALLOW.has(name)),
  )
  // 叠加 .gitignore 过滤（基于相对 POSIX 路径）
  const filtered = raw.filter((name) => {
    const rel = toPosix(join(dir, name).slice(ROOT.length + 1))
    return !isGitIgnored(rel)
  })
  return filtered.sort((a, b) => {
    const aDir = statSync(join(dir, a)).isDirectory()
    const bDir = statSync(join(dir, b)).isDirectory()
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.localeCompare(b, 'zh-CN')
  })
}

/**
 * 递归渲染目录树。prefix 为当前层的前置缩进（顶层为空串）；每项按「是否为
 * 该层最后一项」决定分支符，并据此给儿童层级续接 `'    '` / `'│   '`。
 */
function renderTree(abs, prefix) {
  return list(abs).flatMap((name, i, names) => {
    const full = join(abs, name)
    const isDir = statSync(full).isDirectory()
    const isLast = i === names.length - 1
    const branch = isLast ? '└── ' : '├── '
    const line = prefix + branch + name + (isDir ? '/' : '')
    if (!isDir) {
      const rel = toPosix(join(abs, name).slice(ROOT.length + 1))
      const ann = annotationOf(rel, full)
      return [line + (ann ? ` ← ${ann}` : '')]
    }
    const rel = toPosix(join(abs, name).slice(ROOT.length + 1))
    if (DIR_NOTES[rel]) return [line + ` ← ${DIR_NOTES[rel]}`]
    const childPrefix = prefix + (isLast ? '    ' : '│   ')
    return [line, ...renderTree(full, childPrefix)]
  })
}

/** 差异摘要最多打印的行数（含上下文），避免 CI 日志被整份文档刷屏。 */
const DIFF_MAX_LINES = 60

/** 每个变化段前后保留的上下文行数。 */
const DIFF_CONTEXT = 2

/** 按行拆分并去掉末尾换行产生的空串（末尾换行在比对时单独判断）。 */
function splitLines(text) {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 行级 LCS 对齐：返回从磁盘内容到生成结果的操作序列（same / del / add），
 * 每项带各自行号，供差异摘要定位。行数很小（数百行），二维表足够。
 */
function alignLines(oldLines, newLines) {
  const n = oldLines.length
  const m = newLines.length
  // dp[i][j] = oldLines[i:] 与 newLines[j:] 的最长公共子序列长度
  const dp = Array.from({length: n + 1}, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({kind: 'same', oldLine: i + 1, text: oldLines[i]})
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({kind: 'del', oldLine: i + 1, text: oldLines[i]})
      i += 1
    } else {
      ops.push({kind: 'add', newLine: j + 1, text: newLines[j]})
      j += 1
    }
  }
  while (i < n) {
    ops.push({kind: 'del', oldLine: i + 1, text: oldLines[i]})
    i += 1
  }
  while (j < m) {
    ops.push({kind: 'add', newLine: j + 1, text: newLines[j]})
    j += 1
  }
  return ops
}

/**
 * 打印 --check 的差异摘要：按变化段聚合并带行号，只给少量上下文；
 * 超出上限即折叠，避免把整份 STRUCTURE.md 刷进日志。
 */
function reportStale(actual, expected) {
  const oldLines = splitLines(actual)
  const newLines = splitLines(expected)
  const ops = alignLines(oldLines, newLines)
  const removed = ops.filter((op) => op.kind === 'del').length
  const added = ops.filter((op) => op.kind === 'add').length
  console.log(
    `docs/STRUCTURE.md 已过期：磁盘 ${oldLines.length} 行，生成结果 ${newLines.length} 行` +
    `（磁盘独有 ${removed} 行 / 生成结果独有 ${added} 行）。`,
  )
  if (actual.endsWith('\n') !== expected.endsWith('\n')) {
    console.log(`  末尾换行不同：磁盘${actual.endsWith('\n') ? '有' : '无'}，生成结果${expected.endsWith('\n') ? '有' : '无'}。`)
  }
  // 每个变化行向外扩出上下文，重叠窗口合并成段
  const windows = []
  ops.forEach((op, index) => {
    if (op.kind === 'same') return
    const start = Math.max(0, index - DIFF_CONTEXT)
    const end = Math.min(ops.length - 1, index + DIFF_CONTEXT)
    const last = windows[windows.length - 1]
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else windows.push({start, end})
  })
  let budget = DIFF_MAX_LINES
  let truncated = false
  for (const {start, end} of windows) {
    if (budget <= 0) {
      truncated = true
      break
    }
    const stop = Math.min(end, start + budget - 1)
    for (let k = start; k <= stop; k += 1) {
      const op = ops[k]
      const mark = op.kind === 'same' ? ' ' : (op.kind === 'del' ? '-' : '+')
      const lineNo = op.kind === 'add' ? op.newLine : op.oldLine
      console.log(`${mark} ${String(lineNo).padStart(4, ' ')}: ${op.text}`)
    }
    budget -= stop - start + 1
    if (stop < end) truncated = true
  }
  if (truncated) console.log(`  …差异超过 ${DIFF_MAX_LINES} 行，仅显示前段；其余以生成结果为准。`)
  console.log('修复：运行 `pnpm tree` 重新生成并同批提交。')
}

const body = ['# 项目结构（自动生成）', '',
  '> 由 `scripts/gen-tree.mjs` 生成；改动代码结构后运行 `pnpm tree` 重新生成，',
  '> 请勿手改本文件。每行职责取自对应代码文件的头部块注释的首句；',
  '> 非代码文件走固定备注。', '',
  '```', 'dsh-usage-stats/', ...renderTree(ROOT, ''), '```', ''].join('\n')

const out = join(ROOT, 'docs', 'STRUCTURE.md')

if (!process.argv.includes('--check')) {
  writeFileSync(out, body)
  console.log(`written ${out.replace(ROOT + '/', '')}`)
} else {
  // 只读比对：与生成逻辑同源，不写盘，供 CI 与发版前置检查复用
  let actual = null
  try {
    actual = readFileSync(out, 'utf8')
  } catch {
    // 缺失按过期处理，与内容不一致同一出口
  }
  if (actual === null) {
    console.log('docs/STRUCTURE.md 不存在或不可读；运行 `pnpm tree` 生成后同批提交。')
    process.exitCode = 1
  } else if (actual === body) {
    console.log('docs/STRUCTURE.md 与当前目录结构一致')
  } else {
    reportStale(actual, body)
    process.exitCode = 1
  }
}
