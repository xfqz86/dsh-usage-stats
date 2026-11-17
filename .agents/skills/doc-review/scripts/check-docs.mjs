#!/usr/bin/env node
/**
 * 文档审查机械校验：归属登记与覆盖、登记项存在、版本同步、凭据名一致、相对链接与仓库路径可打开、职责声明。
 *
 * FAIL 阻断（CI 门禁与 doc-review 技能 P0 共用），WARN 只提示。
 * 语义类问题——重复表述、口径漂移、读者错位、过期示例——查不出来，交给 doc-review 技能的审查阶段。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（脚本位于 <root>/.agents/skills/doc-review/scripts/）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const fails = []
const warns = []
const fail = (check, msg) => fails.push({ check, msg })
const warn = (check, msg) => warns.push({ check, msg })
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const exists = (p) => existsSync(join(ROOT, p))

/** 去掉代码围栏内的行后逐行产出（围栏内的反引号/链接不算文档正文）。 */
function* proseLines(file) {
  let fenced = false
  for (const line of read(file).split('\n')) {
    if (line.trimStart().startsWith('```')) { fenced = !fenced; continue }
    if (!fenced) yield line
  }
}

/** AGENTS.md §10 归属表的每行原文（不含表头与分隔行）。 */
function ownershipRows() {
  const lines = read('AGENTS.md').split('\n')
  const start = lines.findIndex((l) => l.startsWith('| 主题 |'))
  if (start < 0) return null
  const rows = []
  for (let i = start + 1; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2 || cells.every((c) => /^-+$/.test(c) || c === '')) continue
    rows.push(cells.join(' | '))
  }
  return rows
}

/** 受审文档清单：根文档 + docs/*.md + 各技能 SKILL.md。 */
function auditedDocs() {
  const docs = ['AGENTS.md', 'README.md', 'CHANGELOG.md']
  for (const f of readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))) docs.push('docs/' + f)
  for (const d of readdirSync(join(ROOT, '.agents/skills'))) {
    if (exists('.agents/skills/' + d + '/SKILL.md')) docs.push('.agents/skills/' + d + '/SKILL.md')
  }
  return docs
}

// ——— 1/2. 归属表：覆盖与登记项存在 ———
const rows = ownershipRows()
if (!rows) {
  fail('归属表', 'AGENTS.md 里找不到「| 主题 |」开头的归属表')
} else {
  const tableText = rows.join('\n')
  const registered = new Set()
  for (const row of rows) for (const m of row.matchAll(/`([^`]+)`/g)) registered.add(m[1])
  for (const doc of auditedDocs()) {
    const covered = doc.includes('/')
      // 嵌套文档必须由完整路径或目录登记覆盖（`docs/releases/` 覆盖其下文件）
      ? [...registered].some((t) => t === doc || (t.endsWith('/') && doc.startsWith(t)))
      // 根文档允许在表里以纯文字出现（AGENTS.md 那行写的是「本文件（AGENTS.md）」）
      : tableText.includes(doc)
    if (!covered) fail('归属覆盖', `未登记进 AGENTS.md §10 归属表：${doc}`)
  }
  for (const p of registered) {
    if (p.includes('<') || p.includes('*') || p.startsWith('http')) continue
    if (!exists(p)) fail('登记存在性', `归属表登记但文件不存在：${p}`)
  }
}

// ——— 3. 版本同步：CHANGELOG 与 docs/releases 双向对齐 ———
const changelogVersions = [...read('CHANGELOG.md').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
const releaseVersions = readdirSync(join(ROOT, 'docs/releases'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/^v/, '').replace(/\.md$/, ''))
for (const v of changelogVersions) if (!releaseVersions.includes(v)) fail('版本同步', `CHANGELOG 有 [${v}] 但缺 docs/releases/v${v}.md`)
for (const v of releaseVersions) if (!changelogVersions.includes(v)) fail('版本同步', `docs/releases/v${v}.md 存在但 CHANGELOG 没有 [${v}] 条目`)

// ——— 4. 凭据名：用户面提到的 KEY/TOKEN 必须真在代码里 ———
const codeKeys = new Set()
for (const f of readdirSync(join(ROOT, 'src/host'), { recursive: true }).map(String)) {
  if (!f.endsWith('.ts')) continue
  for (const m of read('src/host/' + f).matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) {
    if (/KEY|TOKEN/.test(m[1])) codeKeys.add(m[1])
  }
}
const USER_FACING = ['README.md', 'docs/DETAIL.md', 'docs/DETAIL.en.md']
for (const doc of USER_FACING) {
  for (const line of proseLines(doc)) {
    for (const m of line.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
      if (!/KEY|TOKEN/.test(m[1])) continue
      if (!codeKeys.has(m[1])) fail('凭据名一致', `${doc} 提到代码里不存在的凭据名：${m[1]}`)
    }
  }
}

// ——— 5/6. 相对链接与仓库路径可打开 ———
for (const doc of auditedDocs()) {
  const dir = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/')) : ''
  for (const raw of proseLines(doc)) {
    // 行内代码里的示例（如 `[![alt](图)](链接)`）不是真链接
    const line = raw.replace(/`[^`]*`/g, '')
    for (const m of line.matchAll(/\]\((<?)([^)\s>]+)\1\)/g)) {
      const target = m[2]
      if (/^(https?:|mailto:|#)/.test(target)) continue
      const p = target.split('#')[0]
      if (!p) continue
      if (!exists(dir ? dir + '/' + p : p)) fail('相对链接', `${doc} 的链接打不开：${target}`)
    }
    for (const m of line.matchAll(/`((?:src|docs|test|scripts|locale|\.github|\.agents|lib)\/[^`]*)`/g)) {
      let p = m[1].replace(/:\d+(-\d+)?$/, '')
      if (/[<>*{}]/.test(p) || p.endsWith('/')) continue
      if (!exists(p)) fail('仓库路径', `${doc} 提到不存在的路径：${p}`)
    }
  }
}

// ——— 7. 职责声明：技术权威文档开头要说清自己负责什么 ———
for (const doc of ['AGENTS.md', 'CHANGELOG.md', 'docs/API.md', 'docs/ARCHITECTURE.md', 'docs/STYLE.md', 'docs/STRUCTURE.md']) {
  const head = read(doc).split('\n').slice(0, 8).join('\n')
  if (!/本文件|本技能|维护约定|生成/.test(head)) fail('职责声明', `${doc} 开头缺少职责声明（本文件是……的唯一权威）`)
}

// ——— 8. 跨文档整句重复（WARN，只作线索） ———
const seen = new Map()
for (const doc of auditedDocs()) {
  if (doc === 'docs/STRUCTURE.md' || doc.startsWith('docs/releases/')) continue
  for (const line of proseLines(doc)) {
    const t = line.trim()
    if (t.length < 30 || !/[。）]$/.test(t) || /^[|>#-]/.test(t)) continue
    if (!seen.has(t)) seen.set(t, [])
    const files = seen.get(t)
    if (!files.includes(doc)) files.push(doc)
  }
}
let dupCount = 0
for (const [text, files] of seen) {
  if (files.length < 2) continue
  if (++dupCount > 10) break
  warn('疑似重复', `${files.join(' + ')}：${text.slice(0, 40)}…`)
}

// ——— 输出 ———
const checks = ['归属覆盖', '登记存在性', '版本同步', '凭据名一致', '相对链接', '仓库路径', '职责声明']
for (const c of checks) {
  const f = fails.filter((x) => x.check === c)
  const w = warns.filter((x) => x.check === c)
  console.log(`${f.length ? '✗' : '✓'} ${c}${f.length ? `（${f.length}）` : ''}${w.length ? ` 提示 ${w.length}` : ''}`)
  for (const x of f) console.log('    FAIL ' + x.msg)
  for (const x of w) console.log('    warn ' + x.msg)
}
const duplicated = warns.filter((x) => x.check === '疑似重复')
if (duplicated.length) {
  console.log(`! 疑似重复${duplicated.length ? `（${duplicated.length}）` : ''}`)
  for (const x of duplicated) console.log('    warn ' + x.msg)
}
console.log()
console.log(`机械项：${checks.length} 类，FAIL ${fails.length}，提示 ${warns.length}`)
process.exit(fails.length ? 1 : 0)
