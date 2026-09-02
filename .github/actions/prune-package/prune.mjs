/**
 * 剪枝 package.json 至发布所需最小字段集合
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'

function getInput(name, fallback = '') {
  const val = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || ''
  const trimmed = val.trim()
  if (trimmed === '') return fallback
  return trimmed
}

const parsed = {
  path: getInput('path', ''),
  allow: getInput('allow', ''),
  check: getInput('check', 'false').toLowerCase() === 'true',
}

if (!parsed.path.trim()) {
  console.error('::error::path input is required')
  process.exit(1)
}
if (!parsed.allow.trim()) {
  console.error('::error::allow input is required (comma-separated allowlist)')
  process.exit(1)
}

const ALLOW = new Set(parsed.allow.split(',').map(s => s.trim()).filter(Boolean))
const PKG_PATH = isAbsolute(parsed.path) ? parsed.path : resolve(process.cwd(), parsed.path)

function prune(pkg, allow = ALLOW) {
  const out = {}
  for (const k of allow) {
    if (k in pkg) out[k] = pkg[k]
  }
  return out
}

function main() {
  let raw
  try {
    raw = readFileSync(PKG_PATH, 'utf-8')
  } catch (e) {
    console.error(`::error::package.json not found: ${PKG_PATH} (${e.message})`)
    process.exit(1)
  }
  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch (e) {
    console.error(`::error::invalid JSON in ${PKG_PATH}: ${e.message}`)
    process.exit(1)
  }
  const pruned = prune(pkg, ALLOW)

  if (parsed.check) {
    const extra = Object.keys(pkg).filter(k => !ALLOW.has(k))
    if (extra.length === 0) {
      console.log('package.json already pruned — only allowed keys:', [...ALLOW].join(', '))
      process.exit(0)
    } else {
      console.log('package.json has extra keys:', extra.join(', '))
      console.log('allowed:', [...ALLOW].join(', '))
      process.exit(1)
    }
  }

  if (!existsSync(`${PKG_PATH}.bak`)) {
    writeFileSync(`${PKG_PATH}.bak`, raw)
    console.log('backup written to package.json.bak')
  }
  writeFileSync(PKG_PATH, `${JSON.stringify(pruned, null, 2)}\n`)
  console.log('pruned package.json to allowed keys:', [...ALLOW].join(', '))
  console.log(JSON.stringify(pruned, null, 2))
}

if (import.meta.main) main()
