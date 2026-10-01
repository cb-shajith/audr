/**
 * Pins the runtime exports. Adding a name is a public API change: make it deliberately and
 * update this test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { expect, it } from 'vitest';

import * as root from '../src/index.js';

const SRC = join(import.meta.dirname, '../src');

function emitted(file: string): string {
  return ts.transpileModule(readFileSync(join(SRC, file), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
    },
    fileName: file,
  }).outputText;
}

it('pins the root exports', () => {
  expect(Object.keys(root).sort()).toEqual(['TOOL_ERROR_CODE', 'VERSION', 'audrTelemetry']);
  expect(root.TOOL_ERROR_CODE).toBe('VERCEL_AI_TOOL_ERROR');
});

it('keeps VERSION equal to the package version', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
    version: string;
  };
  expect(root.VERSION).toBe(pkg.version);
});

it('emits no runtime import of ai, and node: only from runs.ts', () => {
  const files = readdirSync(SRC).filter((file) => file.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const js = emitted(file);
    expect(js, file).not.toMatch(/from ['"]ai(\/[^'"]*)?['"]|require\(['"]ai|import\(['"]ai/);
    const nodeImports = [...js.matchAll(/from ['"](node:[^'"]+)['"]/g)].map((m) => m[1]);
    expect(nodeImports, file).toEqual(file === 'runs.ts' ? ['node:async_hooks'] : []);
  }
});

it('the returned integration implements the Telemetry hooks it needs', () => {
  const integration = root.audrTelemetry({
    client: { record: () => ({ outcome: 'queued', queued: true, issues: [] }) } as never,
  });
  for (const hook of [
    'onStart',
    'onLanguageModelCallEnd',
    'onToolExecutionStart',
    'onToolExecutionEnd',
    'onEmbedStart',
    'onEmbedEnd',
    'onRerankStart',
    'onRerankEnd',
    'onEnd',
    'onAbort',
    'onError',
    'executeTool',
  ] as const) {
    expect(typeof integration[hook], hook).toBe('function');
  }
  expect(integration.executeLanguageModelCall).toBeUndefined();
});
