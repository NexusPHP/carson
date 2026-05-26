import tsEslint, { type ConfigArray } from 'typescript-eslint';
import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';

const config: ConfigArray = tsEslint.config(
  eslint.configs.recommended,
  tsEslint.configs.strict,
  tsEslint.configs.stylistic,
  stylistic.configs.customize({
    arrowParens: true,
    blockSpacing: true,
    braceStyle: '1tbs',
    indent: 2,
    jsx: false,
    quoteProps: 'consistent-as-needed',
    quotes: 'single',
    semi: true,
  }),
  {
    name: 'additional-rules',
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'sort-imports': ['error', {
        ignoreCase: true,
        ignoreDeclarationSort: false,
        memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
        allowSeparatedGroups: false,
      }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-exports': ['error', {
        fixMixedExportsWithInlineTypeSpecifier: true,
      }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/explicit-member-accessibility': 'error',
      '@typescript-eslint/method-signature-style': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'all',
        argsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      '@typescript-eslint/prefer-find': 'error',
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-regexp-exec': 'error',
      '@typescript-eslint/prefer-return-this-type': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
    },
  },
);

export default config;
