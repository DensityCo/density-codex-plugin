import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dataHealthReport, queryDb, status } from '../scripts/density-core.mjs';

const fakeCli = `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
await appendFile(process.env.DENSITY_TEST_LOG, JSON.stringify(args) + '\\n');
const derivedDataset = {
  name: 'local_metrics',
  state: 'missing',
  reason: 'The local_metrics manifest is missing, so reads use the dynamic join view.',
  nextAction: { id: 'maintain_local_metrics', label: 'Rebuild the local_metrics dataset.', command: 'density maintain local-metrics --format json' },
};
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({
    commands: {
      queryDb: true,
      maintainLocalMetrics: true,
      freshnessStatus: process.env.DENSITY_TEST_FRESHNESS_STATUS !== '0',
    },
  }));
  process.exit(0);
}
if (args[0] === 'maintain') {
  console.log(JSON.stringify({ kind: 'density.maintain.local-metrics.v1', check: args.includes('--check'), before: derivedDataset, rebuilt: false, after: derivedDataset }));
  process.exit(0);
}
if (args[0] === 'freshness-status') {
  console.log(JSON.stringify({
    kind: 'density.freshness.v1',
    policy: { streams: { metrics: { maxAgeMs: 172800000 } } },
    streams: [{ name: 'metrics', maxAgeMs: 172800000, observedAt: '2026-08-30T00:00:00.000Z', ageMs: 172800000, stale: false }],
  }));
  process.exit(0);
}
if (args[0] === 'query-db') {
  console.log(JSON.stringify({ kind: 'density.query-db.v1', organizationId: 'org_fixture', rows: [], rowCount: 0, derivedDataset }));
  process.exit(0);
}
console.error('unsupported fake CLI command');
process.exit(1);
`;

const withFakeCli = async (t, env = {}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-derived-dataset-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const log = path.join(dir, 'commands.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  await writeFile(log, '');
  const previous = new Map();
  for (const [name, value] of Object.entries({ DENSITY_CLI_BIN: cli, DENSITY_TEST_LOG: log, ...env })) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  t.after(async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const commands = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { dataDir: path.join(dir, 'data'), commands };
};

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

test('status and data_health_report expose the derived dataset state from the CLI check', async (t) => {
  const { dataDir, commands } = await withFakeCli(t);

  const report = await status({ dataDir });
  assert.equal(report.derivedDataset.name, 'local_metrics');
  assert.equal(report.derivedDataset.state, 'missing');
  assert.equal(report.derivedDataset.nextAction.command, 'density maintain local-metrics --format json');
  assert.equal(report.freshness.streams[0].ageMs, 172800000);
  assert.equal(report.freshness.streams[0].stale, false);

  const health = await dataHealthReport({ dataDir });
  assert.equal(health.derivedDataset.state, 'missing');
  assert.equal(health.freshness.streams[0].ageMs, 172800000);
  assert.equal(health.freshness.streams[0].stale, false);
  assert.deepEqual(health.checks.find((check) => check.name === 'derived local_metrics dataset current'), {
    name: 'derived local_metrics dataset current',
    ok: false,
    detail: 'The local_metrics manifest is missing, so reads use the dynamic join view.',
  });
  const maintainCommands = (await commands()).filter(([command]) => command === 'maintain');
  assert.equal(maintainCommands.length, 2);
  assert.ok(maintainCommands.every((args) => args.includes('--check')));
});

test('query_db starts one detached repair per data directory when the dataset is not current', async (t) => {
  const { dataDir, commands } = await withFakeCli(t);

  const first = await queryDb({ dataDir, sql: 'SELECT 1' });
  assert.equal(first.ok, true);
  assert.equal(first.derivedDatasetRepair.started, true);
  assert.equal(first.derivedDatasetRepair.command, 'density maintain local-metrics --format json');
  assert.ok(await waitFor(async () => (await commands()).some((args) => args[0] === 'maintain' && !args.includes('--check'))));

  const second = await queryDb({ dataDir, sql: 'SELECT 1' });
  assert.equal(second.derivedDatasetRepair.started, false);
  assert.match(second.derivedDatasetRepair.reason, /already started/);
  const repairs = (await commands()).filter((args) => args[0] === 'maintain' && !args.includes('--check'));
  assert.equal(repairs.length, 1);
});

test('DENSITY_DISABLE_BACKGROUND_REFRESH skips the repair', async (t) => {
  const { dataDir, commands } = await withFakeCli(t, { DENSITY_DISABLE_BACKGROUND_REFRESH: '1' });

  const response = await queryDb({ dataDir, sql: 'SELECT 1' });
  assert.equal(response.ok, true);
  assert.deepEqual(response.derivedDatasetRepair, {
    started: false,
    reason: 'DENSITY_DISABLE_BACKGROUND_REFRESH=1 disables the background repair.',
  });
  assert.equal((await commands()).some((args) => args[0] === 'maintain'), false);
});

test('an older runtime does not receive the freshness-status command', async (t) => {
  const { dataDir, commands } = await withFakeCli(t, { DENSITY_TEST_FRESHNESS_STATUS: '0' });

  const report = await status({ dataDir });
  assert.deepEqual(report.freshness, {
    state: 'unavailable',
    policy: { streams: {} },
    streams: [],
  });
  assert.equal((await commands()).some(([command]) => command === 'freshness-status'), false);
});
