/**
 * tsdown 构建配置：
 * - lib/index.js —— 服务端 Host，Node ESM。运行时只 import node 内置
 *   模块含 node:sqlite + 本地代码；DSH 服务 webServer / sessionQuery /
 *   sessionPersistence 由 cordis 注入，从不直接 import。
 * - lib/client.js —— 浏览器端 bundle，CJS 闭包工厂，以包名 id
 *   `@xfqz86/dsh-usage-stats` 通过 window.__ModuleLoader__.load({ id, factory })
 *   注册。
 *
 * 浏览器端 externals 复刻 shell 的冻结模块表；bundle 运行时只 require
 * react / react/jsx-runtime / primitives，其余全部内联。样式为真正的
 * CSS Modules *.module.css，由 scripts/css-modules-inline.mjs 在构建时
 * 编译并内联注入，独立插件 bundle 无法携带 .css 资产。
 *
 * 源码结构：src/host 服务端，Node ESM 与 src/client 浏览器端 bundle
 * 分离，入口分别是 src/host/index.ts 与 src/client/index.ts。
 *
 * 装饰器降级：@Remote 等标准装饰器经 decoratorLowering()（TypeScript
 * transpileModule，与 harness typert 生成器插件的 transform 同原理）
 * 降为 __esDecorate 辅助后打包，否则产物保留原生装饰器语法、
 * Node 22 无法解析。只处理含装饰器的 TS 源文件。
 *
 * 构建区分：
 * - 本地调试 `pnpm build`，`NODE_ENV` 非 production：不压缩、保留 sourcemap，便于跟踪问题
 * - 生产发布 `NODE_ENV=production pnpm build`，CI/release 使用：压缩 minify 且无 sourcemap，最终产物仅含压缩后的 2 个 js，无 map
 */
import ts from 'typescript';

import { cssModulesInline } from './scripts/css-modules-inline.mjs';


import type { UserConfig } from 'tsdown';

/** 匹配装饰器语法的源码才走 TypeScript 降级，其余文件原样。 */
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m;

/**
 * 标准装饰器降级 rolldown 插件：harness 仓库内由 typert 生成器插件
 * 顺手完成，本仓库独立构建故自备最小 transform。
 */
function decoratorLowering(): { name: string; transform: (code: string, id: string) => { code: string; map: string | undefined } | undefined } {
  return {
    name: 'dsh-usage-stats-decorator-lowering',
    transform(code, id) {
      const file = id.split('?', 1)[0] ?? id;
      if (!/\.[cm]?tsx?$/.test(file) || !DECORATOR_SYNTAX.test(code)) return undefined;
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      });
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      };
    },
  };
}

/** 是否为生产构建：仅 `NODE_ENV=production` 时压缩并去掉 sourcemap，便于本地调试时保留可读性与映射。 */
const isProd = process.env.NODE_ENV === 'production';

/** bundle id = package.json `name`，必须与 package.json 的 name 完全一致，含 scope。 */
const PLUGIN_ID = '@xfqz86/dsh-usage-stats';

/** web shell 冻结模块表（复刻 PLATFORM_MODULES 九项）中的模块标识。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

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
    minify: isProd,
    sourcemap: !isProd,
    plugins: [decoratorLowering()],
    // 服务端仅依赖 Node 内置 + 本地代码 + DSH 基座机制值导入
    //（typert-protocol 装饰器体系、cordis Service 符号，见 AGENTS §0 例外），
    // 不 bundled 任何 npm 包，运行时由本包 node_modules 解析。
    // 设 neverBundle:true 可完全禁止 node_modules 打包，避免误引入值导致 cordis/cosmokit 等被内联
    deps: { neverBundle: true },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: !isProd,
    clean: false,
    minify: isProd,
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
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[];
