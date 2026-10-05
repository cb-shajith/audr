import { defineConfig } from 'eslint/config';
import { workspaceConfig } from '../../../eslint.base.mjs';

const NODE_GLOBALS = [
  'Buffer',
  'process',
  'global',
  'require',
  'module',
  '__dirname',
  '__filename',
  'setImmediate',
  'clearImmediate',
];

const MASTRA_TYPE_ONLY = [
  { name: '@mastra/core', message: 'Import only types from @mastra/core.', allowTypeImports: true },
  {
    name: '@mastra/core/observability',
    message: 'Import only types from @mastra/core/observability.',
    allowTypeImports: true,
  },
  {
    name: '@mastra/core/logger',
    message: 'Import only types from @mastra/core/logger.',
    allowTypeImports: true,
  },
  {
    name: '@mastra/observability',
    message: 'Import only types from @mastra/observability.',
    allowTypeImports: true,
  },
];

export default defineConfig(workspaceConfig(import.meta.dirname), {
  files: ['src/**/*.ts'],
  rules: {
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        paths: MASTRA_TYPE_ONLY,
        patterns: [
          {
            regex: '^@mastra/',
            message: 'Import only types from @mastra/* packages.',
          },
          {
            regex: '^node:',
            message: 'This package must not import node: modules.',
          },
        ],
      },
    ],
    'no-restricted-globals': ['error', ...NODE_GLOBALS],
  },
});
