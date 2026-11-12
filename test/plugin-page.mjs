/**
 * 插件页资源单测：locale 元信息、分语言详情文档、文档图片与发布清单保持一致。
 * 运行 `node test/plugin-page.mjs`。
 *
 * 为什么单独测：这些文件不经过构建，也不参与运行时逻辑，缺文件或路径写错时
 * 只有插件页（以及发版包）才看得出来；普通单测与 tsc 都不会报错。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 文档里的相对图片引用；绝对地址与远程图片不参与包内校验。 */
function imagePaths(markdown) {
  return [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((path) => !/^[a-z][a-z0-9+.-]*:/i.test(path));
}

describe('插件页：locale 元信息', () => {
  it('exports 暴露 locale 通配符，files 覆盖页面资源', () => {
    assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
    for (const path of ['locale', 'docs/DETAIL.md', 'docs/DETAIL.en.md', 'docs/screenshot/01-overview.png', 'docs/screenshot/04-models.png']) {
      assert.ok(manifest.files.includes(path), `package.json files 缺 ${path}`);
    }
  });

  for (const [language, file, detail] of [
    ['en', 'locale/en.json', 'docs/DETAIL.en.md'],
    ['zh', 'locale/zh.json', 'docs/DETAIL.md'],
  ]) {
    it(`${language} 标题、简介与详情路径完整`, () => {
      const { meta } = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
      assert.ok(typeof meta.title === 'string' && meta.title.trim() !== '', 'meta.title 不能为空');
      assert.ok(typeof meta.description === 'string' && meta.description.trim() !== '', 'meta.description 不能为空');
      assert.equal(meta.detail, detail);
      assert.ok(manifest.files.includes(meta.detail), `package.json files 缺详情文档 ${meta.detail}`);
      assert.ok(existsSync(join(ROOT, meta.detail)), `详情文档不存在：${meta.detail}`);
    });
  }
});

describe('插件页：详情文档', () => {
  for (const file of ['docs/DETAIL.md', 'docs/DETAIL.en.md']) {
    it(`${file} 的图片都在包内`, () => {
      const markdown = readFileSync(join(ROOT, file), 'utf8');
      assert.ok(markdown.trim().length > 0, '文档不能为空');
      const images = imagePaths(markdown);
      assert.ok(images.length > 0, '至少引用一张截图');
      for (const image of images) {
        const target = resolve(ROOT, dirname(file), image);
        const path = relative(ROOT, target);
        assert.ok(!path.startsWith('..') && path.startsWith('docs/'), `图片越出 docs/：${image}`);
        assert.ok(manifest.files.includes(path), `package.json files 缺图片 ${path}`);
        assert.ok(existsSync(target), `图片不存在：${image}`);
      }
    });
  }
});
