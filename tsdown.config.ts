/**
 * tsdown 构建配置：
 * - lib/index.js  —— 服务端（Host，Node ESM）。运行时只 import node 内置
 *   模块（含 node:sqlite）+ 本地代码；DSH 服务（webServer / sessionQuery /
 *   sessionPersistence）由 cordis 注入，从不直接 import。
 * - lib/client.js —— 浏览器端 bundle（CJS 闭包工厂），以包名 id
 *   `dsh-usage-stats` 通过 window.__ModuleLoader__.load({ id, factory })
 *   注册。
 *
 * 浏览器端 externals 复刻 shell 的冻结模块表；bundle 运行时只 require
 * react / react/jsx-runtime / primitives，其余全部内联。样式为真正的
 * CSS Modules（*.module.css），由 scripts/css-modules-inline.mjs 在构建时
 * 编译并内联注入（独立插件 bundle 无法携带 .css 资产）。
 *
 * 源码结构：src/host（服务端，Node ESM）与 src/client（浏览器端 bundle）
 * 分离，入口分别是 src/host/index.ts 与 src/client/index.ts。
 */
import type { UserConfig } from 'tsdown'
import { cssModulesInline } from './scripts/css-modules-inline.mjs'

/** bundle id = package.json `name`。 */
const PLUGIN_ID = 'dsh-usage-stats'

/** web shell 冻结模块表中的模块标识。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default [
  {
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    plugins: [cssModulesInline()],
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
