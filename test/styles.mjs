/**
 * 样式契约单测：本插件全部 *.module.css 只允许引用 dsh 主题真实声明的设计变量。
 *
 * 运行 `node --experimental-strip-types test/styles.mjs`（或 `pnpm test:styles`）。
 * 为什么不测别的：未声明的自定义属性不报错，它让整条声明在计算值阶段失效，
 * 写着 token 的那行形同没写；若该行还带写死的浅色兜底（如 `#f6f7f9`），
 * 浅色模式看着正常、深色模式出现白色色块——设置 Tab 的分组头部与计数徽标
 * 就是这样白了一整年。变量名是否真实存在，只有对照主题表才判得出来。
 *
 * 主题变量来源：devDependency `@deepseek-ai/dsh-client-ui-theme`（界面唯一配色来源，
 * 与 harness 运行时同包同版本），其 `lib/client.js` 内联了主题全部样式表；
 * 不依赖本机 harness checkout，CI 上 `pnpm install` 后即可判定。
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(REPO_ROOT, 'src');
/** 主题包名：token 声明的唯一事实来源（与 harness 运行时同包同版本）。 */
const THEME_PACKAGE = '@deepseek-ai/dsh-client-ui-theme';
/** 本仓库允许引用的主题变量前缀：`--dsw-*` 设计 token 与 `--ds-*` 动效/字体变量。 */
const VAR_PREFIX = /^--(?:dsw|ds)-[a-z0-9-]+$/;

/**
 * 主题样式全文（含全部 token 声明）。
 * @returns 主题包内联样式的文本。
 */
function themeText() {
  let manifestPath;
  try {
    manifestPath = createRequire(import.meta.url).resolve(`${THEME_PACKAGE}/package.json`);
  } catch {
    assert.fail(`解析不到主题包 ${THEME_PACKAGE}，请先 pnpm install：本测试以它作为 token 的唯一事实来源。`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const clientEntry = manifest.exports['./client'].default;
  const entryPath = isAbsolute(clientEntry) ? clientEntry : join(dirname(manifestPath), clientEntry);
  // 浏览器端入口是内联了全部主题样式表的 bundle（exports 只导出 "."/"./client"/"./package.json"）。
  return readFileSync(entryPath, 'utf8');
}

/**
 * 递归收集 src 下全部 CSS Modules 文件。
 * @param dir - 起始目录。
 * @returns 全部 *.module.css 的绝对路径。
 */
function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.module.css') ? [full] : [];
  });
}

const SHEETS = cssFiles(SRC_DIR)
  .map(path => ({ path: path.slice(REPO_ROOT.length + 1), text: readFileSync(path, 'utf8') }));

/**
 * 样式表引用的全部主题变量名（含非主题前缀，交给用例判定），去重后保序。
 * @param text - 样式表文本。
 * @returns 变量名列表。
 */
function varsOf(text) {
  return [...new Set([...text.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1]))];
}

describe('样式契约', () => {
  const theme = themeText();

  it('收集到样式表与变量引用（防空跑）', () => {
    assert.ok(SHEETS.length >= 10, `只找到 ${SHEETS.length} 个 *.module.css`);
    const total = SHEETS.reduce((sum, sheet) => sum + varsOf(sheet.text).length, 0);
    assert.ok(total > 50, `全部样式表只引用了 ${total} 个变量`);
  });

  it('只引用主题声明过的变量', () => {
    const undeclared = [];
    for (const sheet of SHEETS) {
      for (const name of varsOf(sheet.text)) {
        if (!theme.includes(`${name}:`)) undeclared.push(`${sheet.path} → ${name}`);
      }
    }
    assert.deepEqual(undeclared, [], `以下变量主题未声明，声明会在计算值阶段失效（深色模式典型表现是白色色块）：\n${undeclared.join('\n')}`);
  });

  it('引用的变量名都在允许的前缀内', () => {
    const foreign = [];
    for (const sheet of SHEETS) {
      for (const name of varsOf(sheet.text)) {
        if (!VAR_PREFIX.test(name)) foreign.push(`${sheet.path} → ${name}`);
      }
    }
    assert.deepEqual(foreign, [], `只允许 --dsw-* / --ds-* 前缀的主题变量：\n${foreign.join('\n')}`);
  });
});
