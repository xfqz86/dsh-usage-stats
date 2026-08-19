/**
 * CSS Modules 的类型声明（与 harness 的 ui-primitives 同款）：
 * `import css from './X.module.css'` 得到 scoped 类名映射。
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
