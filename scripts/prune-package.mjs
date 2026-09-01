/**
 * 剪枝 package.json 至发布所需最小字段集合。
 * 仅保留：name、version、description、type、main、exports、files、engines、dsh、license、repository
 * 其余（scripts、devDependencies、packageManager、keywords、publishConfig 等）
 * 在发布产物（npm / tarball / release 分支）中剥离，避免把开发时依赖与源码配置带入交付物。
 * 保留 repository 以满足 npm OIDC provenance 对 repository.url 的校验。
 *
 * 用法：
 *   node scripts/prune-package.mjs          # 原地改写 package.json（先备份为 package.json.bak）
 *   node scripts/prune-package.mjs --check  # 仅校验，不改写
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const PKG_PATH = resolve(import.meta.dirname, '../package.json')

/** 发布必需的顶层字段白名单 */
const ALLOW = new Set([
  'name',
  'version',
  'description',
  'type',
  'main',
  'exports',
  'files',
  'engines',
  'dsh',
  'license',
  'repository',
])

function prune(pkg) {
  const out = {}
  for (const k of ALLOW) {
    if (k in pkg) out[k] = pkg[k]
  }
  // 排序：按 ALLOW 顺序输出，剩余按字母序（实际无剩余）
  return out
}

function main() {
  const raw = readFileSync(PKG_PATH, 'utf-8')
  const pkg = JSON.parse(raw)
  const pruned = prune(pkg)
  const isCheck = process.argv.includes('--check')

  if (isCheck) {
    const keys = Object.keys(pkg)
    const extra = keys.filter(k => !ALLOW.has(k))
    if (extra.length === 0) {
      console.log('package.json already pruned — only allowed keys:', [...ALLOW].join(', '))
      process.exit(0)
    } else {
      console.log('package.json has extra keys:', extra.join(', '))
      console.log('allowed:', [...ALLOW].join(', '))
      process.exit(1)
    }
  }

  // 备份
  if (!existsSync(`${PKG_PATH}.bak`)) {
    writeFileSync(`${PKG_PATH}.bak`, raw)
    console.log('backup written to package.json.bak')
  }
  writeFileSync(PKG_PATH, `${JSON.stringify(pruned, null, 2)}\n`)
  console.log('pruned package.json to allowed keys:', [...ALLOW].join(', '))
  console.log(JSON.stringify(pruned, null, 2))
}

if (import.meta.main) main()
