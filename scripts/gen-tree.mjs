#!/usr/bin/env node
/**
 * 生成 docs/STRUCTURE.md：反射仓库真实结构，避免目录树手写漂移。
 *
 * 每个文件的一行职责 = 其头部块注释的首句；无头注 / 非代码文件写固定备注。
 * 改动代码结构后运行 `pnpm tree` 重新生成，生成文件勿手改。
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

/** .gitignore 路径（用于尊重 git 忽略规则）。 */
const GITIGNORE_PATH = join(ROOT, '.gitignore')

/** 需提取头注的扩展名白名单（其余扩展名走固定备注或留空）。 */
const HEADER_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css'])

/** 非代码文件的固定职责备注（以相对仓库根路径为键；这些文件无块注释可提取）。 */
const NOTES = {
  'docs/API.md': '服务端 HTTP 协议与偏好设置约定（随接口演进维护）',
  'docs/PUBLISH.md': '发布流程（GitHub Actions 交付三种形态：release / npm / tarball）',
  'docs/STRUCTURE.md': '生成文件：由 `pnpm tree` 重新生成，勿手改',
  'AGENTS.md': '工程规范（注入的规则文件；仅规则变化时改，结构现状不进这里）',
  'README.md': '面向普通用户的功能说明',
  'cordis.patch.yml': '组合包 patch（dsh.bundle.patch）：插入插件条目',
  'package.json': '组合包元数据 / exports / 构建脚本',
  'pnpm-lock.yaml': '锁文件（不手改）',
  'pnpm-workspace.yaml': 'pnpm 工作区（含版本保鲜期白名单）',
  'tsconfig.json': 'TS 编译配置（严格模式）',
  'tsdown.config.ts': '双 bundle 构建配置（host ESM + client CJS）',
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
  const raw = readdirSync(dir).filter((name) => !EXCLUDED.has(name) && !name.startsWith('.'))
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
    const childPrefix = prefix + (isLast ? '    ' : '│   ')
    return [line, ...renderTree(full, childPrefix)]
  })
}

const body = ['# 项目结构（自动生成）', '',
  '> 由 `scripts/gen-tree.mjs` 生成；改动代码结构后运行 `pnpm tree` 重新生成，',
  '> 请勿手改本文件。每行职责取自对应代码文件的头部块注释的首句；',
  '> 非代码文件走固定备注。', '',
  '```', 'dsh-usage-stats/', ...renderTree(ROOT, ''), '```', ''].join('\n')

const out = join(ROOT, 'docs', 'STRUCTURE.md')
writeFileSync(out, body)
 
console.log(`written ${out.replace(ROOT + '/', '')}`)
