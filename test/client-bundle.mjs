/**
 * 浏览器端 bundle 冒烟测试（模拟 window.__ModuleLoader__ + document）。运行 `node test/client-bundle.mjs`（无需类型剥离，测的是构建产物）。
 *
 * 加载 lib/client.js（CJS 形态的插件 bundle），验证：
 *   1. 顶层通过 window.__ModuleLoader__.load 注册，id 为 @xfqz86/dsh-usage-stats；
 *   2. factory(require) 可执行，exports.inject 含必需服务、exports.apply 为函数；
 *   3. 加载期不碰 DOM：样式表以 { id, styles } 挂到全局注册表（Symbol.for(MODULE_STYLES_KEY)），
 *      属性与 shell 用 meta 安装的模块样式表一致（data-plugin=包名、data-path=包内路径）；期望全集从
 *      src 目录动态枚举，新增样式文件自动纳入断言，且样式文本含 scoped 类名；
 *   4. 模块样式表（新版 shell 的安装机制）：load 的 handoff 携带 meta()，键覆盖同一批 *.module.css、
 *      文本与注册表同源；meta 只清理历史版本留下的标签，不新建节点，且可重复调用。
 *   旧版 shell 的自注入（apply 里探测能力后注入）由 test/pure.mjs 直接测 legacyStyles 模块。
 */

import { createRequire } from 'node:module'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'

import { MODULE_STYLES_KEY } from '../scripts/css-modules-inline.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '../lib/client.js')

/** 递归枚举目录下全部 *.module.css 绝对路径（期望全集的单一事实来源）。 */
function walkModuleCss(root) {
  const dirents = readdirSync(root, { recursive: true, withFileTypes: true })
  return dirents
    .filter((e) => e.isFile() && e.name.endsWith('.module.css'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

/** 断言工具：失败即抛错，附上下文。 */
function assert(cond, msg) {
  if (!cond) throw new Error('CLIENT BUNDLE FAILED: ' + msg)
}

/** document 的最小 stub：收集注入的 style 标签，支持 style[data-plugin][data-path] 查询。 */
function makeDocument() {
  const styles = []
  const head = {
    appendChild(el) {
      if (el && el.tagName && el.tagName.toLowerCase() === 'style') styles.push(el)
      return el
    },
  }
  return {
    head,
    styles,
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        attributes: {},
        textContent: '',
        setAttribute(k, v) { this.attributes[k] = v },
        remove() {
          const index = styles.indexOf(this)
          if (index >= 0) styles.splice(index, 1)
        },
      }
    },
    querySelectorAll(sel) {
      // meta() 撤标签用到的查询：style[data-plugin="<owner>"]
      const m = /^style\[data-plugin="([^"]+)"\]$/.exec(sel ?? '')
      if (m === null) throw new Error('stub: 不支持的 querySelectorAll 选择器 ' + sel)
      return styles.filter((s) => s.attributes['data-plugin'] === m[1])
    },
    addEventListener() {},
  }
}

/** 用真实 node_modules 里的包作为 require 桩（构建期 externals 的运行时镜像）。
 *  primitives 真实加载会拉 katex 的 .css（Node 不识别）、react-dom 初始化要求完整 DOM；
 *  factory 只定义组件不渲染，这两个 UI 依赖用惰性 stub（任意成员返回渲染函数）即可。 */
const nodeRequire = createRequire(import.meta.url)
const lazyStub = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop === 'string') return (..._args) => null
    return undefined
  },
})
const STUBBED = new Set(['@deepseek-ai/dsh-client-ui-primitives', 'react-dom', 'react-dom/client'])
const requireStub = (spec) => (STUBBED.has(spec) ? lazyStub : nodeRequire(spec))

let registered = null
const prevModuleLoaderDesc = Object.getOwnPropertyDescriptor(globalThis, '__ModuleLoader__')
const prevWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window')
const prevDocumentDesc = Object.getOwnPropertyDescriptor(globalThis, 'document')

try {
  // 模拟浏览器环境：window 即 globalThis，document 为 stub
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true })
  Object.defineProperty(globalThis, '__ModuleLoader__', {
    value: { load(handoff) { registered = handoff } },
    configurable: true,
  })
  const document = makeDocument()
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true })

  // require 即执行顶层 window.__ModuleLoader__.load(...)（注册，不执行 factory）
  nodeRequire(bundlePath)

  // 期望全集从源码目录动态枚举：新增 .module.css 自动纳入断言，防构建插件漏包或忘补测试。
  const OWNER = '@xfqz86/dsh-usage-stats'
  const expectedPaths = [...new Set(walkModuleCss(join(here, '../src'))
    .map((file) => relative(join(here, '..'), file).split(sep).join('/')))]
  assert(expectedPaths.length > 0, '源码目录未发现任何 *.module.css（枚举失效）')

  // 加载期不碰 DOM：新版 shell 按 meta 安装，旧版由 apply 探测能力后自注入（src/client/legacyStyles.ts）。
  assert(document.styles.length === 0, `bundle 加载时不应自注入 style 标签，实际 ${document.styles.length} 个`)

  // 全局注册表：{ id, styles } 覆盖全部 *.module.css，供旧版 shell 的运行时取用。
  const registry = globalThis[Symbol.for(MODULE_STYLES_KEY)]
  assert(registry !== undefined, 'bundle 未写入全局样式表注册表')
  assert(registry.id === OWNER, `注册表 id 应为 ${OWNER}，实际 ${registry.id}`)
  assert(Object.keys(registry.styles).length === expectedPaths.length, `注册表样式应为 ${expectedPaths.length} 份，实际 ${Object.keys(registry.styles).length}`)
  for (const path of expectedPaths) {
    const css = registry.styles[path]
    assert(typeof css === 'string' && css.length > 0, `注册表缺少 ${path} 的样式文本`)
    assert(css.includes('_'), `${path} 的样式文本未 scoped`)
  }
  const panelCss = registry.styles['src/client/views/UsageStatsPanel.module.css'] ?? ''
  // lightningcss 的 scoped 类名形如 `_<hash>_tabbar`，断言匹配 scoped 化后的选择器
  assert(panelCss.includes('_modal'), 'UsageStatsPanel 样式应包含 scoped 的 .modal')
  const commonCss = registry.styles['src/client/components/UsageStatsCommon.module.css'] ?? ''
  assert(commonCss.includes('_cell'), 'UsageStatsCommon 样式应包含 scoped 的 .cell（统计磁贴基元）')
  // Tab 栏是面板与模型明细弹窗共用的基元，落在 UsageStatsCommon
  assert(commonCss.includes('_tabbar'), 'UsageStatsCommon 样式应包含 scoped 的 .tabbar（Tab 栏基元）')

  const exports = registered.factory(requireStub)

  assert(exports && typeof exports === 'object', 'factory 返回值应为对象')
  assert(Array.isArray(exports.inject), 'exports.inject 应为数组')
  assert(typeof exports.apply === 'function', 'exports.apply 应为函数')
  // factory 只定义组件，同样不碰 DOM。
  assert(document.styles.length === 0, `factory 执行后不应出现 style 标签，实际 ${document.styles.length} 个`)

  // 模块样式表：新版 shell 在挂载期按 meta 安装（依赖先于依赖者、整体排在 shell 样式之后），
  // 键是包内相对路径；文本必须与注册表同源，否则两条交付会各自漂移。
  assert(typeof registered.meta === 'function', 'bundle 的 load handoff 未提供 meta()（新版 shell 靠它安装模块样式表）')
  const stylesheets = registered.meta().stylesheets
  assert(stylesheets !== null && typeof stylesheets === 'object', 'meta() 应返回 { stylesheets }')
  assert(Object.keys(stylesheets).length === expectedPaths.length, `meta 样式表应为 ${expectedPaths.length} 份，实际 ${Object.keys(stylesheets).length}`)
  for (const path of expectedPaths) {
    const sheet = stylesheets[path]
    assert(sheet !== undefined && typeof sheet.text === 'function', `meta 缺少 ${path} 的样式表`)
    assert(sheet.text({ asset: (reference) => reference }) === registry.styles[path], `${path} 的 meta 文本与注册表不一致`)
  }
  // meta() 只清理历史版本留下的自注入标签，不新建节点；重挂载会再次调用，必须幂等。
  const stale = document.createElement('style')
  stale.setAttribute('data-plugin', OWNER)
  stale.setAttribute('data-path', 'src/client/stale.module.css')
  document.head.appendChild(stale)
  assert(Object.keys(registered.meta().stylesheets).length === expectedPaths.length, 'meta() 重复调用应返回完整样式表')
  assert(!document.styles.includes(stale), 'meta() 应清理历史版本留下的自注入标签')
  assert(document.styles.length === 0, `meta() 后仍不应出现 style 标签，实际 ${document.styles.length} 个`)

  console.log('CLIENT BUNDLE OK')
  console.log('  id:', registered.id)
  console.log('  inject:', exports.inject.join(', '))
  console.log('  apply:', typeof exports.apply)
  console.log('  styles:', expectedPaths.length + ' module stylesheets')
} finally {
  Reflect.deleteProperty(globalThis, Symbol.for(MODULE_STYLES_KEY))
  // 还原全局，避免污染其他测试
  if (prevModuleLoaderDesc === undefined) delete globalThis.__ModuleLoader__
  else Object.defineProperty(globalThis, '__ModuleLoader__', prevModuleLoaderDesc)
  if (prevWindowDesc === undefined) delete globalThis.window
  else Object.defineProperty(globalThis, 'window', prevWindowDesc)
  if (prevDocumentDesc === undefined) delete globalThis.document
  else Object.defineProperty(globalThis, 'document', prevDocumentDesc)
}
