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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（脚本位于 <root>/scripts/）。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 不入树的内容：构建产物 / 依赖 / 版本控制 / 本机私有 / 系统文件。 */
const EXCLUDED = new Set([
  'node_modules', 'lib', '.git', '.DS_Store',
  'AGENTS.local.md', 'CLAUDE.local.md', 'pnpm-debug.log',
])

/** 需提取头注的扩展名白名单（其余扩展名走固定备注或留空）。 */
const HEADER_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css'])

/** 非代码文件的固定职责备注（以相对仓库根路径为键；这些文件无块注释可提取）。 */
const NOTES = {
  'docs/API.md': '服务端 HTTP 协议与偏好设置约定（随接口演进维护）',
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

/** 目录项按「目录在前、文件在后，各自按字典序」排列。 */
function list(dir) {
  return readdirSync(dir)
    .filter((name) => !EXCLUDED.has(name) && !name.startsWith('.'))
    .sort((a, b) => {
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
      const rel = join(abs, name).slice(ROOT.length + 1)
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
  '```', 'dsh-usage-statistics/', ...renderTree(ROOT, ''), '```', ''].join('\n')

const out = join(ROOT, 'docs', 'STRUCTURE.md')
writeFileSync(out, body)
// eslint-disable-next-line no-console
console.log(`written ${out.replace(ROOT + '/', '')}`)
