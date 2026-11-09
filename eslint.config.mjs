import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

// A lookup that skips pricing-overlay.ts also skips model-name normalization and custom
// aliases, so an ARN or gateway-named model prices at $0. Overridden per file block, so
// every `no-restricted-imports` block that matches src/ files must include these.
const PRICING_BOUNDARY_PATTERN = {
  regex: '(^|/)shared/(index|pricing)\\.js$',
  importNames: ['resolveModelPricing', 'calculateCost'],
  message: 'Price through calculateModelCost or priceModelUsage in src/metrics/pricing-overlay.ts.',
};

export default [
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', '.astro/'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/shared/**', 'src/metrics/pricing-overlay.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [PRICING_BOUNDARY_PATTERN] }],
    },
  },
  {
    // A raw append to a hook buffer that races a drain is lost. These files write buffers, so they
    // go through appendToHookBuffer in src/storage/hook-buffer.ts.
    files: [
      'src/hooks/collector-script.ts',
      'src/hooks/copilot-app-usage-watcher.ts',
      'src/hooks/copilot-usage-watcher.ts',
      'src/hooks/parent-transcript-watcher.ts',
      'src/hooks/subagent-watcher.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:fs',
              importNames: ['appendFileSync', 'appendFile'],
              message:
                'Append to a hook buffer with appendToHookBuffer (src/storage/hook-buffer.ts).',
            },
          ],
          patterns: [PRICING_BOUNDARY_PATTERN],
        },
      ],
    },
  },
  {
    // CLI scripts report to the terminal. The no-console rule protects the MCP server's
    // stdout, which is its stdio transport; these never run as part of that process.
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      // Pin instead of 'detect' — eslint-plugin-react@7.37 calls a removed
      // ESLint 10 context API during version detection.
      react: { version: '19.0' },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Modern React (17+) JSX transform — no need to import React in scope.
      'react/react-in-jsx-scope': 'off',
      // Vite/esbuild handle prop-types via TypeScript.
      'react/prop-types': 'off',
    },
  },
  prettierConfig,
];
