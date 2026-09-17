#!/usr/bin/env node
/**
 * 发布形态验证：生产构建 → 打真 tarball → 校验包内容与 Remote 方法签名 → 还原开发态构建。
 *
 * 为什么必须验发布形态：开发态构建掩盖生产态才暴露的问题。`lib/index.js` 的方法
 * 参数名是 SRC 分发的线路字段（网关按方法源码文本读参数名），一旦被压缩改名，
 * 全部带参 Remote 调用在真实网关上被判 `gateway/arguments-invalid` 拒收——0.4.2
 * 的线上故障正是生产构建把 `snapshot(request)` 压成 `snapshot(e)`；客户端 bundle
 * 的 externals 与剪枝后的 package.json 同理只在发布形态成立。
 *
 * 用法：`node .agents/skills/release/scripts/verify-release.mjs`（须在仓库内运行），出包后由
 * 装机实测消费（本机流程见 AGENTS.local.md，规则见 AGENTS.md §9，流程见同目录上一级的
 * SKILL.md）。产物固定落在 <tmp>/dsh-usage-stats-release/。任一项校验失败即非零退出并列出失败项。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 从脚本所在目录向上找含 package.json 的目录作仓库根（不依赖脚本深度）。 */
function findRoot() {
  const start = dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

const ROOT = findRoot()
/** 出包目录：固定路径，装机实测脚本按同一条路径取包，不猜时间戳。 */
const OUT_DIR = join(tmpdir(), 'dsh-usage-stats-release')
/** 交付物清单（7 文件），与 .github/actions/verify-pack 的期望一致。 */
const EXPECTED_FILES = [
  'package/lib/index.js', 'package/lib/client.js', 'package/package.json',
  'package/cordis.patch.yml', 'package/README.md', 'package/CHANGELOG.md', 'package/LICENSE',
]

const failures = []
const fail = (msg) => { failures.push(msg); console.error(`FAIL: ${msg}`) }
const pass = (msg) => console.log(`  ✓ ${msg}`)

/** 跑一条命令，返回 { code, out }（输出合并供失败时定位）。 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** 剪枝白名单：从 prune-package 动作的默认值读取，避免两处维护。 */
function pruneAllowlist() {
  const action = readFileSync(join(ROOT, '.github/actions/prune-package/action.yml'), 'utf8')
  const m = /default: "([^"]*name,version[^"]*)"/.exec(action)
  if (m === null) throw new Error('读不到 prune-package 动作的 allow 默认值')
  return m[1].split(',')
}

/**
 * 源码里每个 @Remote 方法声明的参数名：SRC 分发下它就是线路字段名。
 * @returns {Map<string, string[]>} 方法名 → 参数名列表。
 */
function sourceParameterNames() {
  const source = readFileSync(join(ROOT, 'src/host/service.ts'), 'utf8')
  const table = new Map()
  const re = /@Remote\('(\w+)'\)\s*(?:async\s+)?\w+\(([^)]*)\)/g
  for (const m of source.matchAll(re)) {
    const params = m[2].trim() === '' ? [] : m[2].split(',').map((p) => p.trim().split(':')[0].trim())
    table.set(m[1], params)
  }
  if (table.size === 0) throw new Error('src/host/service.ts 未解析出任何 @Remote 方法')
  return table
}

/** 产物原型方法的参数名：与网关同款读法（Function.prototype.toString）。 */
function builtParameterNames(Service) {
  const table = new Map()
  for (const name of Object.getOwnPropertyNames(Service.prototype)) {
    if (name === 'constructor') continue
    const desc = Object.getOwnPropertyDescriptor(Service.prototype, name)
    if (typeof desc?.value !== 'function') continue
    const source = Function.prototype.toString.call(desc.value)
    const open = source.indexOf('(')
    const close = source.indexOf(')', open + 1)
    const body = source.slice(open + 1, close).trim()
    table.set(name, body === '' ? [] : body.split(',').map((p) => p.trim()))
  }
  return table
}

const sameNames = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

async function main() {
  const head = run('git', ['rev-parse', '--short', 'HEAD']).out.trim()
  const dirty = run('git', ['status', '--porcelain']).out.trim() !== ''
  console.log(`发布形态验证：HEAD ${head}${dirty ? '（工作区有未提交改动）' : ''}`)

  // 1) 生产构建
  console.log('1/5 生产构建 …')
  const build = run('pnpm', ['build'], { env: { ...process.env, NODE_ENV: 'production' } })
  if (build.code !== 0) { fail(`生产构建失败：\n${build.out}`); return }
  const hostSize = readFileSync(join(ROOT, 'lib/index.js')).length
  const clientSize = readFileSync(join(ROOT, 'lib/client.js')).length
  pass(`构建完成：lib/index.js ${(hostSize / 1024).toFixed(1)} kB、lib/client.js ${(clientSize / 1024).toFixed(1)} kB`)
  if (existsSync(join(ROOT, 'lib/index.js.map'))) fail('生产构建不该产出 lib/index.js.map')

  // 2) Remote 方法签名：产物参数名必须等于源码声明的参数名（SRC 线路字段）
  console.log('2/5 校验 Remote 方法签名 …')
  const expected = sourceParameterNames()
  const Service = (await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)).UsageStatsService
  const actual = builtParameterNames(Service)
  let signatureOk = true
  for (const [method, params] of expected) {
    const got = actual.get(method)
    if (got === undefined) { fail(`产物缺 Remote 方法 ${method}`); signatureOk = false; continue }
    if (!sameNames(params, got)) {
      fail(`${method} 产物参数名 [${got.join(', ')}] 与源码 [${params.join(', ')}] 不一致（构建改写了方法签名？）`)
      signatureOk = false
    }
  }
  if (signatureOk) pass(`${expected.size} 个 Remote 方法的参数名与源码一致`)

  // 3) 组装发布目录并打真包：临时目录 + 剪枝后的 manifest，既不动工作区 package.json，
  //    也避免 pack 触发 `prepare: tsdown` 把开发态构建覆盖进包（CI 剪枝同理）
  console.log('3/5 打包 …')
  rmSync(OUT_DIR, { recursive: true, force: true })
  const staging = join(OUT_DIR, 'package')
  mkdirSync(staging, { recursive: true })
  cpSync(join(ROOT, 'lib'), join(staging, 'lib'), { recursive: true, filter: (src) => !src.endsWith('.map') })
  for (const file of ['cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
    cpSync(join(ROOT, file), join(staging, file))
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const pruned = {}
  for (const key of pruneAllowlist()) if (key in manifest) pruned[key] = manifest[key]
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(pruned, null, 2)}\n`)
  const packed = run('pnpm', ['pack', '--pack-destination', OUT_DIR], { cwd: staging })
  if (packed.code !== 0) { fail(`打包失败：\n${packed.out}`); return }  const tgz = join(OUT_DIR, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`)
  if (!existsSync(tgz)) { fail(`未产出预期 tarball：${tgz}`); return }
  // 固定文件名的副本（与 GitHub Release 附件同名）：装机实测按它安装，路径不随版本号变化
  const stable = join(OUT_DIR, `${manifest.name.replace('@', '').replace('/', '-')}.tgz`)
  copyFileSync(tgz, stable)
  pass(`${tgz}（${(readFileSync(tgz).length / 1024).toFixed(1)} kB）`)
  pass(`装机实测用固定副本：${stable}`)

  // 4) 包内容：7 文件、无 map、剪枝后的 manifest、包内服务端产物与刚验证过的一致
  console.log('4/5 校验包内容 …')
  const listed = run('tar', ['-tzf', tgz]).out.split('\n')
    .filter((f) => f !== '' && !f.endsWith('/')).sort()
  const missing = EXPECTED_FILES.filter((f) => !listed.includes(f))
  if (missing.length > 0) fail(`包内缺交付物：${missing.join(', ')}`)
  const extra = listed.filter((f) => !EXPECTED_FILES.includes(f))
  if (extra.length > 0) fail(`包内多出交付物：${extra.join(', ')}`)
  if (listed.some((f) => f.endsWith('.map'))) fail('包内出现 sourcemap')
  const packedManifest = JSON.parse(run('tar', ['-xzf', tgz, '-O', 'package/package.json']).out)
  if ('devDependencies' in packedManifest || 'scripts' in packedManifest) fail('包内 package.json 未剪枝')
  const packedHost = run('tar', ['-xzf', tgz, '-O', 'package/lib/index.js']).out
  if (packedHost !== readFileSync(join(ROOT, 'lib/index.js'), 'utf8')) fail('包内 lib/index.js 与刚校验过的构建产物不一致')
  for (const [method, params] of expected) {
    if (params.length > 0 && !packedHost.includes(`${method}(${params[0]})`)) {
      fail(`包内 ${method} 的参数名 ${params[0]} 丢失（打包过程改写了签名？）`)
    }
  }
  if (failures.length === 0) pass(`交付物 ${EXPECTED_FILES.length} 项齐备、无 sourcemap、manifest 已剪枝、服务端签名保留`)

  // 5) 还原开发态 lib/（link: 安装用的是这份，留在生产态会缺 map 且难调试）
  console.log('5/5 还原开发态构建 …')
  const restore = run('pnpm', ['build'])
  if (restore.code !== 0) fail(`开发态构建还原失败：\n${restore.out}`)
  else pass('lib/ 已还原为开发态')

  console.log('')
  if (failures.length > 0) {
    console.error(`发布形态验证失败（${failures.length} 项）：`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('发布形态验证通过')
  console.log(`  tarball: ${tgz}`)
  console.log('  下一步：装机实测该 tarball（本机流程见 AGENTS.local.md），再提交')
}

await main()
