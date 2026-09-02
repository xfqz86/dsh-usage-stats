/**
 * @fileoverview ESLint flat config — Google TypeScript Style Guide 落地
 * 覆盖 host（Node ESM）/ client（Browser CJS）/ scripts（Node ESM mjs）三类环境，
 * 基于 eslint 9 + typescript-eslint 8 + eslint-plugin-import-x + @stylistic。
 */

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

export default tseslint.config(
  // 全局忽略（产物与非代码）
  {
    ignores: [
      'lib/**',
      'node_modules/**',
      '.pnpm-store/**',
      '.agent-teams/**',
      'test/session-events.jsonl',
      'docs/STRUCTURE.md',
      'dist/**',
      'coverage/**',
    ],
  },

  // 基础：eslint 推荐（适用于所有 JS/TS）
  eslint.configs.recommended,

  // 类型感知规则仅对 TS/TSX 生效（避免 .mjs 触发 projectService 解析失败）
  ...tseslint.configs.recommendedTypeChecked.map((cfg) => ({
    ...cfg,
    files: ['**/*.{ts,tsx}'],
  })),
  ...tseslint.configs.stylisticTypeChecked.map((cfg) => ({
    ...cfg,
    files: ['**/*.{ts,tsx}'],
  })),

  // 全量 TS/TSX 共享规则（Google 风格子集）
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // 复用 tsconfig.json 的 projectService（tsconfig 含 src + tsdown.config.ts）
        projectService: true,
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      'import-x': importX,
      '@stylistic': stylistic,
    },
    rules: {
      // ——— error（阻断，存量需清零） ———
      'no-var': 'error',
      'prefer-const': 'error',
      'one-var': ['error', 'never'],
      curly: ['error', 'multi-line'],
      eqeqeq: ['error', 'smart'],
      'no-throw-literal': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {prefer: 'type-imports', fixStyle: 'inline-type-imports'},
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {assertionStyle: 'as', objectLiteralTypeAssertions: 'never'},
      ],
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
            'object',
            'type',
          ],
          'newlines-between': 'always',
          alphabetize: {order: 'asc', caseInsensitive: true},
        },
      ],
      'import-x/no-duplicates': 'error',
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/indent': ['error', 2, {SwitchCase: 1}],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/comma-spacing': ['error', {before: false, after: true}],
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      // ——— warn（需手工收敛，t5 前清零或达到阈值） ———
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'max-len': [
        'warn',
        {
          code: 180,
          tabWidth: 2,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignorePattern: '^import\\s',
        },
      ],
      'no-nested-ternary': 'warn',
      'use-isnan': 'warn',
      'no-restricted-globals': ['warn', 'isNaN', 'isFinite'],
      'no-console': ['warn', {allow: ['warn', 'error']}],
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
          filter: {regex: '^NS$', match: false},
        },
        {
          selector: 'variable',
          format: null,
          filter: {regex: '^NS$', match: true},
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['PascalCase'],
        },
      ],
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use union type instead of enum',
        },
      ],
      '@typescript-eslint/prefer-readonly': 'warn',
      '@typescript-eslint/no-inferrable-types': 'warn',
      // ——— off（与本仓库强约束冲突，永久豁免；及额外严格规则未在 Google 核心子集内，避免存量大面积误报） ———
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'import-x/no-unresolved': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/prefer-includes': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-empty': ['error', {allowEmptyCatch: true}],
    },
  },

  // host / 共享 模块：Node 环境
  {
    files: ['src/host/**/*.{ts,tsx}', 'src/types.ts', 'src/utils.ts', 'src/css-modules.d.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // client 模块：Browser 环境 + JSX
  {
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {...globals.browser, ...globals.es2022},
      parserOptions: {jsx: true},
    },
    rules: {
      // react-jsx 无需 import React，关闭相关误报
      'no-console': ['warn', {allow: ['warn', 'error']}],
    },
  },

  // scripts、测试与构建配置：Node ESM，关闭类型感知规则（.mjs 非 TS）
  {
    files: [
      'scripts/**/*.{mjs,cjs,js}',
      'test/**/*.{mjs,cjs,js}',
      '.github/**/*.{mjs,cjs,js}',
      'tsdown.config.ts',
      'eslint.config.mjs',
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {sourceType: 'module', ecmaVersion: 2022},
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
      'no-empty': ['error', {allowEmptyCatch: true}],
      // 以下规则依赖类型信息，对 JS 文件关闭
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/prefer-readonly': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/only-throw-error': 'off',
    },
  },

  // css-modules.d.ts 特例：允许 default 导出
  {
    files: ['src/css-modules.d.ts'],
    rules: {
      'import-x/no-default-export': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
