/**
 * 浏览器端 bundle 冒烟测试（模拟 window.__ModuleLoader__ + document）。
 *
 * 加载 lib/client.js（CJS 形态的插件 bundle），验证：
 *   1. 顶层通过 window.__ModuleLoader__.load 注册，id 为 dsh-usage-statistics；
 *   2. factory(require) 可执行，exports.inject 含必需服务、exports.apply 为函数；
 *   3. CSS Modules 内联注入：document 出现 data-plugin-css 的 <style> 标签
 *      （UsageStatsFooter / UsageStatsPanel），且样式文本含 scoped 类名。
 */

import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '../lib/client.js')

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
  assert(registered.id === 'dsh-usage-statistics', `注册 id 应为 dsh-usage-statistics，实际为 ${registered.id}`)

  const exports = registered.factory(requireStub)

  assert(exports && typeof exports === 'object', 'factory 返回值应为对象')
  assert(Array.isArray(exports.inject), 'exports.inject 应为数组')
  assert(typeof exports.apply === 'function', 'exports.apply 应为函数')

  // CSS 注入验证：两个样式标签（Footer + Panel），含 scoped 类名
  const cssTags = document.styles.map((s) => s.attributes['data-plugin-css'])
  assert(cssTags.includes('dsh-usage-statistics/UsageStatsFooter'), '缺少 UsageStatsFooter 的 style 标签')
  assert(cssTags.includes('dsh-usage-statistics/UsageStatsPanel'), '缺少 UsageStatsPanel 的 style 标签')
  const panelCss = document.styles.find((s) => s.attributes['data-plugin-css'] === 'dsh-usage-statistics/UsageStatsPanel')?.textContent ?? ''
  // lightningcss 的 scoped 类名形如 `_<hash>_tabbar`，断言匹配 scoped 化后的选择器
  assert(panelCss.includes('_tabbar'), 'UsageStatsPanel 样式应包含 scoped 的 .tabbar（Tab 栏）')
  assert(panelCss.includes('_modal'), 'UsageStatsPanel 样式应包含 scoped 的 .modal')

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