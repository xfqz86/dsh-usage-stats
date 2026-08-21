/**
 * rolldown 插件：把 *.module.css 编译成「scoped 类名映射 + 样式内联注入」的
 * JS 模块。
 *
 * 为什么需要它：独立插件 bundle 只有一个 JS 文件会被插件加载器服务，
 * 无法携带单独的 .css 资产（harness 仓库内由 monorepo 构建分发 css 文件，
 * 插件做不到）。源码仍然用真正的 CSS Modules（import css from './X.module.css'，
 * 与 harness 的 ui-sidebar 等项目写法一致），构建时经本插件：
 *   1. resolveId 把 .module.css 的 import 重写为 `\0css-modules:` 前缀的虚拟
 *      id，id = 绝对路径的 base64url（确定性强哈希，后缀不含 .css，绕开
 *      tsdown 内置 css-guard 对 css 文件的拦截检查）；
 *   2. load 钩子里用 lightningcss 的 cssModules 模式生成 scoped 类名与样式；
 *   3. 生成 JS 模块：export default 类名映射，并调用共享运行时（RUNTIME_ID）
 *      的 injectPluginStyle 注入 <style>（幂等）。
 *
 * 两项去重，避免 bundle 里重复代码，且全部无状态（关键：tsdown/rolldown 的
 * 插件钩子可能在不同实例上下文中执行，模块级 Map 不可靠，必须纯函数）：
 *   - 共享运行时：注入逻辑（建标签 / 查重 / 挂头）只生成一次，每个 CSS 模块
 *     只是一行 import + 一行调用，不内联整段样板；
 *   - 按文件确定性 id：同一 .module.css 从任意多处 import 都会解析到同一个
 *     虚拟 id，rolldown 据此只打包一份（否则 UsageStatsCommon 这类共享样式
 *     会在 bundle 里出现 N 份）。路径从 id 反解码，load 不依赖任何共享状态。
 *
 * 用 .mjs 实现：tsdown 在 Node 22 上加载含运行时 import 的 TS 配置会触发
 * 已知 bug（需要 --config-loader tsx），原生 ESM 则无此问题。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { transform } from 'lightningcss'

/** 插件所属标识，用于注入标签的 data-plugin 属性。 */
const PLUGIN_NAME = 'dsh-usage-stats'

/** 虚拟 id 前缀（后缀不含 .css，绕开 tsdown 的 css-guard）。 */
const VIRTUAL_PREFIX = '\0css-modules:'
/** 共享运行时虚拟 id：样式注入助手，整个 bundle 只定义一份。 */
const RUNTIME_ID = `${VIRTUAL_PREFIX}runtime`
/** 生成的 CSS 模块 import 共享运行时所用的说明符（经 resolveId 路由到 RUNTIME_ID）。 */
const RUNTIME_SPECIFIER = 'dsh-usage-stats:css-inject'

/** 每个 .module.css 对应一个注入标签；键为不含扩展名的文件名。 */
function cssTagOf(filePath) {
  return `${PLUGIN_NAME}/${basename(filePath, '.module.css')}`
}

// 虚拟 id -> 真实路径的全局映射，解决 rolldown 多实例下模块级 Map 不共享的问题
// 同时用哈希而非明文路径做 id，彻底避免把本地绝对路径（/Users/...）编码进产物变量名
const idToPath = (globalThis.__dshCssModulesMap ??= new Map())

/** 绝对路径 -> 确定性短哈希虚拟 id（基于相对路径的 sha256，无本地环境泄露）。 */
function virtualIdOf(filePath) {
  const rel = relative(process.cwd(), filePath)
  const hash = createHash('sha256').update(rel).digest('base64url').slice(0, 12)
  const id = VIRTUAL_PREFIX + hash
  idToPath.set(id, filePath)
  return id
}

/** 虚拟 id -> 绝对路径（查表；未命中返回 null）。 */
function filePathOf(id) {
  if (!id.startsWith(VIRTUAL_PREFIX) || id === RUNTIME_ID) return null
  return idToPath.get(id) ?? null
}

/** 共享运行时源码：注入助手只定义一次，各 CSS 模块调一行即可。 */
const RUNTIME_CODE = [
  `/** dsh-usage-stats CSS Modules 内联注入助手（构建时生成，幂等）。 */`,
  `export function injectPluginStyle(css, cssTag, pluginName) {`,
  `  if (typeof document === 'undefined') return;`,
  `  if (document.querySelector('style[data-plugin-css="' + cssTag + '"]')) return;`,
  `  const el = document.createElement('style');`,
  `  el.setAttribute('data-plugin', pluginName);`,
  `  el.setAttribute('data-plugin-css', cssTag);`,
  `  el.textContent = css;`,
  `  if (document.head) document.head.appendChild(el);`,
  `  else document.addEventListener('DOMContentLoaded', () => { if (document.head) document.head.appendChild(el); });`,
  `}`,
].join('\n')

/** tsdown（rolldown）插件入口。 */
export function cssModulesInline() {
  return {
    name: 'css-modules-inline',
    resolveId(source, importer) {
      // 共享运行时的说明符先于一切处理，路由到固定虚拟 id。
      if (source === RUNTIME_SPECIFIER) return { id: RUNTIME_ID, moduleSideEffects: false }
      // 只处理 .module.css 的 import（虚拟 id 自身不会再次进入）。
      if (!source.endsWith('.module.css')) return null
      const filePath = resolve(importer ? dirname(importer) : process.cwd(), source)
      return { id: virtualIdOf(filePath), moduleSideEffects: true }
    },
    load(id) {
      if (id === RUNTIME_ID) return { code: RUNTIME_CODE, map: null }
      const filePath = filePathOf(id)
      if (filePath === null) return null
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
      const cssText = result.code.toString()
      const tag = cssTagOf(filePath)
      const js = [
        `import { injectPluginStyle } from ${JSON.stringify(RUNTIME_SPECIFIER)};`,
        `injectPluginStyle(${JSON.stringify(cssText)}, ${JSON.stringify(tag)}, ${JSON.stringify(PLUGIN_NAME)});`,
        `export default ${JSON.stringify(locals)};`,
      ].join('\n')
      return { code: js, map: null }
    },
  }
}
