/**
 * 构建期资源导入的类型声明：带 raw 后缀的 SVG 得到文件文本（由 scripts/svg-raw.mjs 编译）。
 */
declare module '*.svg?raw' {
  const content: string;
  export default content;
}
