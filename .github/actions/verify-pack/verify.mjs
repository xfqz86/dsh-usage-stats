/**
 * 校验交付物仅含 6 文件且 package.json 已剪枝（仅供 GitHub Action 使用）
 * 支持 tarball (.tgz) 与 payload 目录两种形态，path/allow 均由 action.yml 传入。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, isAbsolute, basename, dirname } from 'node:path'

function getInput(name, fallback = '') {
  const val = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || ''
  const trimmed = val.trim()
  if (trimmed === '') return fallback
  return trimmed
}

const parsed = {
  path: getInput('path', ''),
  allow: getInput('allow', ''),
}

if (!parsed.path) {
  console.error('::error::path input is required')
  process.exit(1)
}
if (!parsed.allow) {
  console.error('::error::allow input is required')
  process.exit(1)
}

const ALLOW = new Set(parsed.allow.split(',').map(s => s.trim()).filter(Boolean))
if (ALLOW.size === 0) {
  console.error('::error::allow input is empty after parsing')
  process.exit(1)
}

// 支持 glob：若 path 含 * 则按 shell 展开规则取首个匹配
function resolvePath(inputPath) {
  if (!inputPath.includes('*')) return inputPath
  // 简单 glob：仅处理 *.tgz 这类单目录通配
  const dir = dirname(inputPath)
  const pattern = basename(inputPath)
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  const absDir = isAbsolute(dir) ? dir : resolve(process.cwd(), dir)
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    console.error(`::error::glob dir not found: ${absDir}`)
    process.exit(1)
  }
  const candidates = readdirSync(absDir).filter(n => regex.test(n)).map(n => resolve(absDir, n))
  if (candidates.length === 0) {
    console.error(`::error::no file matched glob: ${inputPath}`)
    process.exit(1)
  }
  if (candidates.length > 1) console.log(`glob matched ${candidates.length} files, using first: ${candidates[0]}`)
  return candidates[0]
}

const rawPath = resolvePath(parsed.path)
const PKG_PATH = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath)

function fail(msg) {
  console.error(`::error::${msg}`)
  process.exit(1)
}

function verifyTarball(tgzPath) {
  const abs = resolve(tgzPath)
  if (!existsSync(abs)) fail(`tarball not found: ${abs}`)
  console.log(`verifying tarball: ${abs}`)
  const list = execSync(`tar -tzf ${JSON.stringify(abs)} | sort`, { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean)
  console.log(list.join('\n'))
  const check = (re, msg) => {
    if (!list.some(p => re.test(p))) fail(msg)
  }
  check(/^package\/lib\/index\.js$/, 'lib/index.js missing in tarball')
  check(/^package\/lib\/client\.js$/, 'lib/client.js missing in tarball')
  check(/^package\/package\.json$/, 'package.json missing in tarball')
  check(/^package\/cordis\.patch\.yml$/, 'cordis.patch.yml missing in tarball')
  check(/^package\/README\.md$/, 'README.md missing in tarball')
  check(/^package\/LICENSE$/, 'LICENSE missing in tarball')

  if (list.length !== 6) fail(`unexpected file count ${list.length}, expected 6 (lib/index.js + lib/client.js + package.json/cordis.patch.yml/README.md/LICENSE)\n${list.join('\n')}`)
  if (list.some(p => p.includes('client.js.map'))) fail('client.js.map should not be in tarball')
  if (list.some(p => /^package\/(src\/|tsconfig|tsdown|scripts\/|test\/|docs\/|\.github\/)/.test(p))) {
    fail(`tarball contains unwanted src/tsconfig/scripts/test files:\n${list.join('\n')}`)
  }

  const pkgJson = execSync(`tar -xzOf ${JSON.stringify(abs)} package/package.json`, { encoding: 'utf-8' })
  if (pkgJson.includes('"prepare"')) fail('prepare still in packed package.json')
  if (pkgJson.includes('"devDependencies"')) fail('devDependencies still in packed package.json')
  if (pkgJson.includes('"scripts"')) fail('scripts still in packed package.json')
  if (pkgJson.includes('"packageManager"')) fail('packageManager still in packed package.json')
  const j = JSON.parse(pkgJson)
  const extra = Object.keys(j).filter(k => !ALLOW.has(k))
  if (extra.length) fail(`packed package.json has extra keys: ${extra.join(', ')} (allow: ${[...ALLOW].join(', ')})`)
  console.log(`packed package.json pruned ok: ${Object.keys(j).join(', ')}`)
  console.log('tarball verify ok — only lib(2) + package.json(pruned) + LICENSE + cordis.patch.yml + README.md')
}

function verifyPayload(dir) {
  const abs = resolve(dir)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) fail(`payload dir not found: ${abs}`)
  const files = execSync(`find ${JSON.stringify(abs)} -type f | sort`, { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean)
  console.log(files.join('\n'))
  const rel = files.map(f => f.replace(abs + '/', ''))
  if (files.length !== 6) fail(`payload file count ${files.length}, expected 6 (lib/index.js, lib/client.js + package.json/cordis.patch.yml/README.md/LICENSE)\n${rel.join('\n')}`)
  const need = ['lib/index.js', 'lib/client.js', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']
  for (const n of need) if (!rel.includes(n)) fail(`payload missing ${n}`)
  if (rel.some(p => p.includes('client.js.map'))) fail('payload contains client.js.map (should be no map)')
  if (rel.some(p => p.endsWith('.ts'))) fail(`payload contains .ts source:\n${rel.join('\n')}`)
  const pkgPath = resolve(abs, 'package.json')
  const pkgJson = readFileSync(pkgPath, 'utf-8')
  const j = JSON.parse(pkgJson)
  const extra = Object.keys(j).filter(k => !ALLOW.has(k))
  if (extra.length) fail(`payload package.json has extra keys: ${extra.join(', ')}`)
  if (pkgJson.includes('"prepare"')) fail('prepare still in payload package.json')
  console.log('payload verify ok — only lib(2) + package.json(pruned) + LICENSE + cordis.patch.yml + README.md')
}

function main() {
  let stat
  try {
    stat = statSync(PKG_PATH)
  } catch {
    fail(`path not found: ${PKG_PATH}`)
  }
  if (stat.isDirectory()) verifyPayload(PKG_PATH)
  else if (PKG_PATH.endsWith('.tgz') || PKG_PATH.endsWith('.tar.gz')) verifyTarball(PKG_PATH)
  else fail(`path must be .tgz tarball or payload directory: ${PKG_PATH}`)
}

if (import.meta.main) main()
