/**
 * 浏览器端 bundle 冒烟测试（模拟 window.__ModuleLoader__ + document）。
 *
 * 加载 lib/client.js（CJS 形态的插件 bundle），验证：
 *   1. 顶层通过 window.__ModuleLoader__.load 注册，id 为 @xfqz86/dsh-usage-stats；
 *   2. factory(require) 可执行，exports.inject 含必需服务、exports.apply 为函数；
 *   3. CSS Modules 内联注入：每个 *.module.css 注入一个 data-plugin-css 的
 *      <style>（期望全集从 src 目录动态枚举，新增样式文件自动纳入断言，
 *      覆盖 views / components 下全部模块：UsageStatsFooter / UsageStatsPanel /
 *      UsageStatsCommon / OverviewTab / HeroTile / UsageHeatmap / DatesTab /
 *      SessionsTab / ModelsTab / SettingsTab / SettingsSwitch / Tooltip /
 *      Pagination / ModelPieChart / ModelStackedBar / DateStackedBar /
 *      ThSortable 等），且样式文本含 scoped 类名。
 */

import { createRequire } from 'node:module'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'

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

/** document 的最小 stub：收集注入的 style 标签，支持 data-plugin-css 查询。 */
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
      return { tagName: tag.toUpperCase(), attributes: {}, textContent: '', setAttribute(k, v) { this.attributes[k] = v } }
    },
    querySelector(sel) {
      // 只支持 bundle 内用到的 'style[data-plugin-css="..."]' 查询
      const m = /^style\[data-plugin-css="([^"]+)"\]$/.exec(sel ?? '')
      if (m) return styles.find((s) => s.attributes['data-plugin-css'] === m[1]) ?? null
      return null
    },
    addEventListener() {},
  }
}

/** 用真实 node_modules 里的包作为 require 桩（构建期 externals 的运行时镜像）。
 *  primitives 真实加载会拉 katex 的 .css（Node 不识别），但 factory 只定义
 *  组件不渲染，UI 组件用惰性 stub（任意成员返回渲染函数）即可。 */
const nodeRequire = createRequire(import.meta.url)
const primitivesStub = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop === 'string') return (..._args) => null
    return undefined
  },
})
const requireStub = (spec) =>
  spec === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : nodeRequire(spec)

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

  assert(registered !== null, 'bundle 未通过 window.__ModuleLoader__.load 注册')
  assert(registered.id === '@xfqz86/dsh-usage-stats', `注册 id 应为 @xfqz86/dsh-usage-stats，实际为 ${registered.id}`)

  const exports = registered.factory(requireStub)

  assert(exports && typeof exports === 'object', 'factory 返回值应为对象')
  assert(Array.isArray(exports.inject), 'exports.inject 应为数组')
  assert(typeof exports.apply === 'function', 'exports.apply 应为函数')

  // CSS 注入验证：每个 .module.css 注入一个 style 标签（按组件拆分的模块都在）。
  // 共享样式（UsageStatsCommon 被多个 Tab import）只应注入一次 —— 构建脚本按
  // 物理文件缓存虚拟 id 去重，否则 bundle 会有 N 份重复的样式文本与注入代码。
  const cssTags = document.styles.map((s) => s.attributes['data-plugin-css'])
  // 期望全集从源码目录动态枚举（不再硬编码清单）：新增 .module.css 自动纳入断言，
  // 防止构建插件漏包或忘记补测试导致样式注入回归逃过检查。注入标签 = 文件名
  // （basename 去扩展名），与 scripts/css-modules-inline.mjs 的 cssTagOf 一致。
  const expectedTags = [...new Set(walkModuleCss(join(here, '../src')).map((f) => 'dsh-usage-stats/' + basename(f, '.module.css')))]
  assert(expectedTags.length > 0, '源码目录未发现任何 *.module.css（枚举失效）')
  for (const tag of expectedTags) {
    assert(cssTags.includes(tag), `缺少 ${tag} 的 style 标签`)
  }
  // 去重校验：每个物理 .module.css 恰好注入一次（瓶颈是 UsageStatsCommon）
  const countOf = (t) => cssTags.filter((x) => x === t).length
  for (const tag of expectedTags) {
    assert(countOf(tag) === 1, `${tag} 应恰好注入一次，实际 ${countOf(tag)} 次（去重失效）`)
  }
  const panelCss = document.styles.find((s) => s.attributes['data-plugin-css'] === 'dsh-usage-stats/UsageStatsPanel')?.textContent ?? ''
  // lightningcss 的 scoped 类名形如 `_<hash>_tabbar`，断言匹配 scoped 化后的选择器
  assert(panelCss.includes('_tabbar'), 'UsageStatsPanel 样式应包含 scoped 的 .tabbar（Tab 栏）')
  assert(panelCss.includes('_modal'), 'UsageStatsPanel 样式应包含 scoped 的 .modal')
  const commonCss = document.styles.find((s) => s.attributes['data-plugin-css'] === 'dsh-usage-stats/UsageStatsCommon')?.textContent ?? ''
  assert(commonCss.includes('_cell'), 'UsageStatsCommon 样式应包含 scoped 的 .cell（统计磁贴基元）')

  console.log('CLIENT BUNDLE OK')
  console.log('  id:', registered.id)
  console.log('  inject:', exports.inject.join(', '))
  console.log('  apply:', typeof exports.apply)
  console.log('  styles:', cssTags.join(', '))
} finally {
  // 还原全局，避免污染其他测试
  if (prevModuleLoaderDesc === undefined) delete globalThis.__ModuleLoader__
  else Object.defineProperty(globalThis, '__ModuleLoader__', prevModuleLoaderDesc)
  if (prevWindowDesc === undefined) delete globalThis.window
  else Object.defineProperty(globalThis, 'window', prevWindowDesc)
  if (prevDocumentDesc === undefined) delete globalThis.document
  else Object.defineProperty(globalThis, 'document', prevDocumentDesc)
}