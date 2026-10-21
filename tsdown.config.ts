/**
 * tsdown 构建配置：双 bundle（host Node ESM + client 浏览器 CJS）。
 *
 * 产物形态与 CSS 内联机制见 docs/ARCHITECTURE.md §6；本文件相关的约束：
 * - host 端 `deps.neverBundle: true`：不打包任何 npm 包，运行时值导入（基座机制值，见
 *   AGENTS §0 依赖三段式）由本包 node_modules 解析；sessionQuery / sessionPersistence 由
 *   cordis 注入，从不直接 import。
 * - host 端恒不压缩（生产构建同样如此）：网关按方法源码文本取 Remote 线路字段名，压缩
 *   重命名参数会让请求被判 gateway/arguments-invalid 拒收（回归见 test/smoke.mjs）。
 * - client 端 `externals` 是浏览器 shell 的冻结模块表（react 系 + cordis + store / slots /
 *   primitives / dockkit），其余全部内联；生产构建压缩且无 sourcemap。
 * - 装饰器降级：@Remote 等标准装饰器经 decoratorLowering()（TypeScript transpileModule，
 *   与 harness typert 生成器插件同原理）降为 __esDecorate 辅助后打包，否则产物保留原生
 *   装饰器语法、Node 22 无法解析；只处理含装饰器的 TS 源文件。
 */
import { readFileSync } from 'node:fs';

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

/** 是否为生产构建：仅 `NODE_ENV=production` 时压缩浏览器端 bundle 并去掉 sourcemap，便于本地调试时保留可读性与映射。 */
const isProd = process.env.NODE_ENV === 'production';

/** bundle id = package.json `name`，必须与 package.json 的 name 完全一致，含 scope。 */
const PLUGIN_ID = '@xfqz86/dsh-usage-stats';

/** 包版本号：构建时注入浏览器 bundle，「关于」页与更新比较不手写版本，避免与 package.json 漂移。 */
const PLUGIN_VERSION = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** 浏览器 shell 冻结模块表中的模块标识（本仓库只需这 9 项，其余全部内联）。 */
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
    // 恒不压缩（生产构建同样如此）：网关按方法源码文本取 Remote 线路字段名，
    // 压缩重命名参数会让请求被判 gateway/arguments-invalid 拒收，见文件头注释。
    minify: false,
    sourcemap: !isProd,
    plugins: [decoratorLowering()],
    // 服务端仅依赖 Node 内置 + 本地代码 + DSH 基座机制值导入
    //（typert-protocol 装饰器体系、cordis Service 符号，见 AGENTS §0 依赖三段式）；
    // neverBundle 禁止任何 node_modules 打包，运行时由本包 node_modules 解析，
    // 避免误引入值导致 cordis/cosmokit 等被内联
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
      DSH_USAGE_STATS_VERSION: JSON.stringify(PLUGIN_VERSION),
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
