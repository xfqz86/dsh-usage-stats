/**
 * rolldown 插件：把 *.module.css 编译成「scoped 类名映射 + 样式内联注入」的
 * JS 模块。
 *
 * 为什么需要它：独立插件 bundle 只有一个 JS 文件会被插件加载器服务，
 * 无法携带单独的 .css 资产（harness 仓库内由 monorepo 构建分发 css 文件，
 * 插件做不到）。源码仍然用真正的 CSS Modules（import css from './X.module.css'，
 * 与 harness 的 ui-sidebar 等项目写法一致），构建时经本插件：
 *   1. resolveId 把 .module.css 的 import 重写为 `\0css-modules:` 前缀的
 *      序号虚拟 id（后缀不含 .css，绕开 tsdown 内置 css-guard 对 css 文件
 *      的拦截检查），并记录虚拟 id -> 绝对路径；
 *   2. load 钩子里用 lightningcss 的 cssModules 模式生成 scoped 类名与样式；
 *   3. 生成 JS 模块：export default 类名映射，并在浏览器端把样式注入
 *      <style> 标签（按文件名幂等，重复加载不重复注入）。
 *
 * 用 .mjs 实现：tsdown 在 Node 22 上加载含运行时 import 的 TS 配置会触发
 * 已知 bug（需要 --config-loader tsx），原生 ESM 则无此问题。
 */

import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

/** 插件所属标识，用于注入标签的 data-plugin 属性。 */
const PLUGIN_NAME = 'dsh-usage-statistics'

/** 虚拟 id 前缀（序号形式，后缀不含 .css，绕开 tsdown 的 css-guard）。 */
const VIRTUAL_PREFIX = '\0css-modules:'
/** 虚拟 id -> 原始 .module.css 绝对路径。 */
const virtualToPath = new Map()
/** 虚拟 id 序号。 */
let nextVirtualId = 0

/** 每个 .module.css 对应一个注入标签；键为不含扩展名的文件名。 */
function cssTagOf(filePath) {
  return `${PLUGIN_NAME}/${basename(filePath, '.module.css')}`
}

/** 生成浏览器端样式注入代码（模块加载时执行，幂等）。 */
function styleInjection(css, tag) {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const cssTag = ${JSON.stringify(tag)};`,
    `if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + cssTag + '"]')) {`,
    `  const tag = document.createElement('style');`,
    `  tag.setAttribute('data-plugin', ${JSON.stringify(PLUGIN_NAME)});`,
    `  tag.setAttribute('data-plugin-css', cssTag);`,
    `  tag.textContent = css;`,
    `  if (document.head) document.head.appendChild(tag);`,
    `  else document.addEventListener('DOMContentLoaded', () => { if (document.head) document.head.appendChild(tag); });`,
    `}`,
  ].join('\n')
}

/** tsdown（rolldown）插件入口。 */
export function cssModulesInline() {
  return {
    name: 'css-modules-inline',
    resolveId(source, importer) {
      // 只处理 .module.css 的 import（虚拟 id 自身不会再次进入）。
      if (!source.endsWith('.module.css')) return null
      // 说明符可能是相对的（相对 importer）或绝对的；记下绝对路径并给一个
      // 不带 .css 后缀的序号虚拟 id。
      const filePath = resolve(importer ? dirname(importer) : process.cwd(), source)
      const virtualId = VIRTUAL_PREFIX + String(nextVirtualId++)
      virtualToPath.set(virtualId, filePath)
      return { id: virtualId, moduleSideEffects: true }
    },
    load(id) {
      const filePath = virtualToPath.get(id)
      if (filePath === undefined) return null
      const source = readFileSync(filePath, 'utf8')
      const result = transform({
        filename: filePath,
        code: Buffer.from(source),
        cssModules: true,
        minify: true,
      })
      // lightningcss 的 exports 形状：{ 原类名: { name: 'scoped 类名', ... } }
      const locals = {}
      for (const [key, value] of Object.entries(result.exports ?? {})) {
        if (value && typeof value === 'object' && typeof value.name === 'string') {
          locals[key] = value.name
        }
      }
      const js = [
        styleInjection(result.code.toString(), cssTagOf(filePath)),
        `export default ${JSON.stringify(locals)};`,
      ].join('\n')
      return { code: js, map: null }
    },
  }
}
