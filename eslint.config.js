const tsParser = require('@typescript-eslint/parser')
const tsPlugin = require('@typescript-eslint/eslint-plugin')
const prettierPlugin = require('eslint-plugin-prettier')
const prettierConfig = require('eslint-config-prettier')

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'example/**', 'coverage/**', '*.tsbuildinfo'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
]
