/**
 * 旧版 shell 的样式兜底：新版 shell 在挂载期按 `meta().stylesheets` 安装模块样式表，旧版不会。
 * 这里在 apply 时按模块系统能力判断，只有旧版才把 bundle 注册表里的样式自注入，
 * 新版不再插一遍再撤，省掉一次重复的 CSS 解析与整轮 DOM 插入/移除。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis';

/** 构建期注入的 Symbol 键：bundle 加载时把 { id, styles } 挂到 Symbol.for(<键>) 上。 */
declare const DSH_USAGE_STATS_STYLES_KEY: string;

/** bundle 交给运行时的样式表清单：插件包名 + 包内路径 → scoped CSS。 */
export interface BundledStylesheets {
  /** 插件包名，也是模块样式表的 owner（写进 data-plugin）。 */
  readonly id: string
  /** 包内相对路径 → 编译后的 CSS 文本（写进 data-path）。 */
  readonly styles: Readonly<Record<string, string>>
}

/**
 * 新版 shell 的能力信号：模块系统提供记录订阅与枚举，renderer 靠它们安装 meta 样式表。
 * 旧版模块系统没有这两个方法（随模块样式机制一起加的）。判据偏向保守：只会把新版漏判成
 * 旧版（最多多插一次样式），不会把旧版误判成新版（那样会掉样式）。
 * @param modules - `ctx.get('modules')` 的返回值，旧版可能缺席。
 * @returns 样式是否由 shell 按 meta 安装。
 */
export function supportsModuleStyles(modules: unknown): boolean {
  if (typeof modules !== 'object' || modules === null) return false;
  return typeof Reflect.get(modules, 'subscribeModules') === 'function'
    && typeof Reflect.get(modules, 'activeRecords') === 'function';
}

/**
 * 按 shell 的模块样式表格式注入 style 标签：data-plugin 写包名、data-path 写包内路径，
 * 与 shell 用 meta 安装出来的属性一致。已存在同路径标签时跳过（重复 apply 幂等）。
 * @param doc - 目标文档。
 * @param stylesheets - bundle 注册表里的样式表清单。
 */
export function installStyles(doc: Document, stylesheets: BundledStylesheets): void {
  for (const [path, css] of Object.entries(stylesheets.styles)) {
    const selector = 'style[data-plugin="' + stylesheets.id + '"][data-path="' + path + '"]';
    if (doc.querySelector(selector) !== null) continue;
    const el = doc.createElement('style');
    el.setAttribute('data-plugin', stylesheets.id);
    el.setAttribute('data-path', path);
    el.textContent = css;
    doc.head.appendChild(el);
  }
}

/**
 * apply 入口：新版 shell 直接返回（样式由 renderer 安装），旧版从 bundle 注册表取样式自注入。
 * @param ctx - 插件上下文，经可选服务取模块系统。
 * @param options - 测试注入口：注册表键与文档对象，生产代码不传。
 */
export function installLegacyStyles(
  ctx: ClientContext,
  options: { key?: string, document?: Document } = {},
): void {
  if (supportsModuleStyles(ctx.get('modules'))) return;
  const key = Symbol.for(options.key ?? DSH_USAGE_STATS_STYLES_KEY);
  const stylesheets: unknown = Reflect.get(globalThis, key);
  if (typeof stylesheets !== 'object' || stylesheets === null) return;
  installStyles(options.document ?? document, stylesheets as BundledStylesheets);
}
