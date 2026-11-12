/**
 * rolldown 插件：把带 raw 后缀的 SVG import 编译成「导出 SVG 文本」的 JS 模块。
 *
 * 为什么需要它：浏览器端 bundle 只有一个 JS 文件会被插件加载器服务，运行时读不到包内的
 * icon.svg；「关于」页的品牌图标必须与插件列表同源，故在构建期把同一文件内联进 bundle。
 * 机制与产物形态见 docs/ARCHITECTURE.md §6，这里只列本文件的约束：
 *   - resolveId 把 `<path>.svg?raw` 解析为真实文件的 `?raw` 虚拟 id（按引入方目录解析相对路径）。
 *   - load 返回 `export default <JSON 字符串>`，SVG 文本原样进包，不解析、不转义成 HTML。
 *   - 只处理带 `?raw` 后缀的 import，其他 .svg 资源不归本插件管。
 *
 * 用 .mjs 实现：与 scripts/css-modules-inline.mjs 同理，tsdown 在 Node 22 上加载含运行时
 * import 的 TS 配置会触发已知 bug（需要 --config-loader tsx），原生 ESM 无此问题。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 显式原始文本导入后缀：与普通 .svg 资源区分。 */
const RAW_SUFFIX = '?raw'

/** tsdown（rolldown）插件入口。 */
export function svgRaw() {
  return {
    name: 'svg-raw',
    resolveId(source, importer) {
      if (!source.endsWith(`.svg${RAW_SUFFIX}`)) return null
      const file = source.slice(0, -RAW_SUFFIX.length)
      const absolute = resolve(importer === undefined ? process.cwd() : dirname(importer), file)
      return { id: `${absolute}${RAW_SUFFIX}`, moduleSideEffects: false }
    },
    load(id) {
      if (!id.endsWith(RAW_SUFFIX)) return null
      const svg = readFileSync(id.slice(0, -RAW_SUFFIX.length), 'utf8')
      return `export default ${JSON.stringify(svg)}`
    },
  }
}
