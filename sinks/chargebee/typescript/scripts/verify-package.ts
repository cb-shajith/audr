/**
 * Pack this package and the core it plugs into, install both tarballs into an empty
 * project, and prove that only they and their declared runtime dependencies are installed
 * and that a batch reaches `fetch` through a `Client`, loaded through both `import` and
 * `require`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const core = join(root, '../../../adapters/core/typescript');
const dependencies = (dir: string): string[] => {
  const { dependencies = {} } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(dependencies);
};
const expected = [
  ...new Set(['audr', 'audr-sink-chargebee', ...dependencies(core), ...dependencies(root)]),
].sort();
const project = mkdtempSync(join(tmpdir(), 'audr-sink-chargebee-verify-'));
const run = (command: string, args: string[], cwd = project): string =>
  execFileSync(command, args, { cwd, encoding: 'utf8' });

const ESM_SMOKE = `
import { Client } from 'audr';
import { makeRecord } from 'audr/testing';
import { ChargebeeSink } from 'audr-sink-chargebee';

const requests = [];
const fetch = async (url, init) => {
  requests.push({ url, events: JSON.parse(init.body).events });
  return new Response(null, { status: 202 });
};
const sink = new ChargebeeSink({ site: 'acme', apiKey: 'test_key', fetch });
const client = new Client(sink, { logger: { warn() {}, error() {} } });
const record = makeRecord({ attribution: { environment: 'test', subscription_id: 'sub_1' } });
if (!client.record(record).queued) throw new Error('record was not queued');
await client.shutdown();
const [request] = requests;
if (request?.url !== 'https://acme.ingest.chargebee.com/api/v2/batch/usage_events') {
  throw new Error('batch did not reach the ingest endpoint');
}
if (request.events[0].deduplication_id !== record.record_id || client.stats.sent !== 1) {
  throw new Error('record was not delivered');
}
`;

const CJS_SMOKE = `
const { ChargebeeSink, VERSION } = require('audr-sink-chargebee');
if (typeof ChargebeeSink !== 'function' || typeof VERSION !== 'string') throw new Error('smoke failed');
`;

const pack = (dir: string): string =>
  join(project, run('npm', ['pack', '--silent', '--pack-destination', project], dir).trim());

try {
  const tarballs = [pack(core), pack(root)];
  writeFileSync(join(project, 'package.json'), '{ "private": true, "type": "module" }\n');
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', ...tarballs]);

  const installed = readdirSync(join(project, 'node_modules'))
    .filter((name) => !name.startsWith('.'))
    .sort();
  if (installed.join() !== expected.join()) {
    throw new Error(`expected ${expected.join(', ')}, found: ${installed.join(', ')}`);
  }

  writeFileSync(join(project, 'smoke.mjs'), ESM_SMOKE);
  writeFileSync(join(project, 'smoke.cjs'), CJS_SMOKE);
  run('node', ['smoke.mjs']);
  run('node', ['smoke.cjs']);
  console.log(`  installs ${expected.join(', ')} and delivers via import and require`);
} finally {
  rmSync(project, { recursive: true, force: true });
}
