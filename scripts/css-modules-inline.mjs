/**
 * rolldown 插件：把 *.module.css 编译成「scoped 类名映射 + 双轨样式交付」的 JS 模块。
 *
 * 为什么需要它：独立插件 bundle 只有一个 JS 文件会被插件加载器服务，无法携带单独的 .css
 * 资产；源码仍是真正的 CSS Modules，构建期由本插件编译。机制与产物形态见
 * docs/ARCHITECTURE.md §6，这里只列本文件的约束：
 *   - resolveId 把 .module.css 的 import 重写为以 \0css-modules: 开头的虚拟 id，id 取相对
 *     路径的 sha256 短哈希——同一文件从任意处 import 解析到同一 id，rolldown 只打包一份；
 *     虚拟 id 的后缀不含 .css，绕开 tsdown 内置 css-guard 对 css 文件的拦截检查。
 *   - load 钩子用 lightningcss 的 cssModules 模式生成 scoped 类名与样式：模块只导出类名映射，
 *     样式文本按仓库相对路径收集，交给 renderChunk 统一交付。
 *   - 双轨交付：renderChunk 把 banner / footer 的占位符换成同一份样式表对象的两个引用，
 *     产物里的 CSS 文本只存一份：
 *       1) 注册调用携带 meta().stylesheets——新版 shell 在挂载期按 owner 排序安装，依赖先于
 *          依赖者、整体排在 shell 自身样式之后，插件对 shell 组件的同特异性覆盖（如 Modal 的
 *          .modal 对 .dialog）才成立；
 *       2) 工厂外的自注入 <style data-plugin data-path>——旧版 shell 不读 meta，只有这条才生效；
 *          属性与 shell 自己安装的模块样式表完全一致（owner 包名 + 包内路径），两种模式下的
 *          DOM 对得上。
 *     meta 被调用即说明新 shell 接管了样式，顺手撤掉自注入标签，同一份 CSS 只装一遍。
 *     两处占位符缺失或重复都直接让构建失败：静默产出没有样式的 bundle 只会在页面上才暴露。
 *   - 插件钩子可能在不同 rolldown 实例上下文中执行，模块级 Map 不可靠：虚拟 id → 真实路径
 *     的映射与编译文本都挂在 globalThis，load 只按 id 查表，不依赖调用顺序。
 *
 * 用 .mjs 实现：tsdown 在 Node 22 上加载含运行时 import 的 TS 配置会触发已知 bug
 * （需要 --config-loader tsx），原生 ESM 无此问题。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { transform } from 'lightningcss'

/** 虚拟 id 前缀（后缀不含 .css，绕开 tsdown 的 css-guard）。 */
const VIRTUAL_PREFIX = '\0css-modules:'

/** banner 里的样式表占位符：renderChunk 换成「仓库相对路径 → scoped CSS」对象字面量。 */
export const MODULE_STYLES_BANNER = '/*__DSH_MODULE_STYLES__*/'

/** banner 里样式表对象的变量名：footer 的生成代码按它引用，配置里的 banner 同源引用。 */
export const MODULE_STYLES_VARIABLE = '__dshStyles'

/** footer 第一处占位符：注册对象里的 meta，renderChunk 换成新版 shell 的样式表交付。 */
export const MODULE_META_BLOCK = '/*__DSH_MODULE_META_BLOCK__*/'

/** footer 第二处占位符：load 调用之后的自注入，旧版 shell 的兜底。 */
export const MODULE_LEGACY_STYLE_BLOCK = '/*__DSH_MODULE_LEGACY_STYLE_BLOCK__*/'

// 虚拟 id -> 真实路径的全局映射，解决 rolldown 多实例下模块级 Map 不共享的问题
// 同时用哈希而非明文路径做 id，彻底避免把本地绝对路径（/Users/...）编码进产物变量名
const idToPath = (globalThis.__dshCssModulesMap ??= new Map())

/** 编译后的样式文本：仓库相对 POSIX 路径 → scoped CSS（跨钩子共享）。 */
const styleTexts = (globalThis.__dshCssModulesText ??= new Map())

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
  if (!id.startsWith(VIRTUAL_PREFIX)) return null
  return idToPath.get(id) ?? null
}

/** 仓库相对 POSIX 路径：模块样式表在 owner 包内的路径，也是产物里的稳定键。 */
function stylePathOf(filePath) {
  return relative(process.cwd(), filePath).split(sep).join('/')
}

/** 样式表对象字面量：键为仓库相对路径，值可直接观察（不依赖加载顺序）。 */
function moduleStylesObject() {
  const entries = [...styleTexts.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return '{' + entries.map(([path, css]) => JSON.stringify(path) + ':' + JSON.stringify(css)).join(',') + '}'
}

/**
 * 生成 footer 的两段内容：注册对象里的 meta（新版 shell 的安装机制）与 load 调用后的兼容注入。
 * 两段都引用 banner 里的同一个样式表对象，产物不重复存 CSS 文本；选择器在运行时用
 * JSON.stringify 拼出，生成代码里不嵌转义引号。
 * 自注入标签只用 data-plugin（owner 包名）与 data-path（包内路径），和 shell 用 meta 安装的
 * 模块样式表同属性，两种模式下 DOM 一致。
 * @param {string} styles - banner 里样式表对象的变量名。
 * @param {string} pluginId - 插件包名，也是模块样式表的 owner。
 * @returns {{ meta: string, legacy: string }} 注册对象内的 meta 片段与 load 调用后的自注入片段。
 */
function moduleStylesFooter(styles, pluginId) {
  const owner = JSON.stringify(pluginId)
  const meta = [
    'meta: () => {',
    '  const stylesheets = {};',
    '  for (const path of Object.keys(' + styles + ')) stylesheets[path] = { text: () => ' + styles + '[path] };',
    '  // 新 shell 接管样式：撤掉自注入的标签，同一份 CSS 只装一遍。',
    '  if (typeof document !== "undefined") for (const el of document.querySelectorAll("style[data-plugin=" + JSON.stringify(' + owner + ') + "]")) el.remove();',
    '  return { stylesheets };',
    '}',
  ].join('\n')
  const legacy = [
    'for (const path of Object.keys(' + styles + ')) {',
    '  if (typeof document === "undefined") break;',
    '  if (document.querySelector("style[data-plugin=" + JSON.stringify(' + owner + ') + "][data-path=" + JSON.stringify(path) + "]")) continue;',
    '  const el = document.createElement("style");',
    '  el.setAttribute("data-plugin", ' + owner + ');',
    '  el.setAttribute("data-path", path);',
    '  el.textContent = ' + styles + '[path];',
    '  if (document.head) document.head.appendChild(el);',
    '}',
  ].join('\n')
  return { meta, legacy }
}

/**
 * 定位唯一占位符的偏移：缺失或重复都说明 tsdown.config.ts 的 banner / footer 与插件失配，
 * 直接抛错让构建停在这里（返回 null 会静默产出没有样式、也没有 meta 的 bundle）。
 * @param {string} code - 当前产物文本。
 * @param {string} marker - 占位符。
 * @param {string} label - 出错信息里的占位符用途。
 * @returns {number} 占位符起点。
 */
function markerOffset(code, marker, label) {
  const at = code.indexOf(marker)
  if (at < 0) throw new Error('tsdown: css-modules-inline: missing ' + label + ' marker (' + marker + ') in the emitted chunk (see banner / footer in tsdown.config.ts)')
  if (code.indexOf(marker, at + marker.length) >= 0) throw new Error('tsdown: css-modules-inline: repeated ' + label + ' marker (' + marker + ') in the emitted chunk (see banner / footer in tsdown.config.ts)')
  return at
}

/**
 * tsdown（rolldown）插件入口。
 * @param {{ pluginId: string }} options - pluginId 是插件包名，同时用作模块样式表 owner 与标签属性。
 */
export function cssModulesInline({ pluginId } = {}) {
  if (typeof pluginId !== 'string' || pluginId === '') {
    throw new Error('tsdown: css-modules-inline: pluginId is required (the client bundle package name)')
  }
  return {
    name: 'css-modules-inline',
    buildStart() {
      // 增量构建（watch）会复用进程，先清空上一轮的文件集合。
      styleTexts.clear()
    },
    resolveId(source, importer) {
      // 只处理 .module.css 的 import（虚拟 id 自身不会再次进入）。
      if (!source.endsWith('.module.css')) return null
      const filePath = resolve(importer ? dirname(importer) : process.cwd(), source)
      return { id: virtualIdOf(filePath), moduleSideEffects: true }
    },
    load(id) {
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
      styleTexts.set(stylePathOf(filePath), result.code.toString())
      return { code: 'export default ' + JSON.stringify(locals) + ';', map: null }
    },
    renderChunk(code) {
      const bannerAt = markerOffset(code, MODULE_STYLES_BANNER, 'module styles')
      let output = code.slice(0, bannerAt) + moduleStylesObject() + code.slice(bannerAt + MODULE_STYLES_BANNER.length)
      const { meta, legacy } = moduleStylesFooter(MODULE_STYLES_VARIABLE, pluginId)
      const metaAt = markerOffset(output, MODULE_META_BLOCK, 'module meta')
      output = output.slice(0, metaAt) + meta + output.slice(metaAt + MODULE_META_BLOCK.length)
      const legacyAt = markerOffset(output, MODULE_LEGACY_STYLE_BLOCK, 'legacy styles')
      output = output.slice(0, legacyAt) + legacy + output.slice(legacyAt + MODULE_LEGACY_STYLE_BLOCK.length)
      return { code: output, map: null }
    },
  }
}
