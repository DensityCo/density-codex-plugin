import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  QUERY_DB_DEFAULT_TIMEOUT_MS,
  queryDb,
  validateQueryAnalysis,
} from '../scripts/density-core.mjs';

const fakeCli = `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[0];
if (command === 'capabilities') {
  console.log(JSON.stringify({ commands: { queryDb: true } }));
  process.exit(0);
}
if (command === 'query') {
  console.error('legacy query command is not part of the Modern MCP path');
  process.exit(1);
}
if (command === 'query-db') {
  const sql = args[args.indexOf('--sql') + 1] || '';
  const analysis = args[args.indexOf('--analysis') + 1] || '';
  if (!analysis || typeof JSON.parse(analysis) !== 'object') {
    console.error('analysis was not forwarded to query-db');
    process.exit(1);
  }
  if (/\\b(drop|delete|update|insert|alter|attach|pragma)\\b/i.test(sql)) {
    console.error('read-only SQL safety rejected the statement');
    process.exit(1);
  }
  console.log(JSON.stringify({
    columns: ['room_count'],
    rows: [{ room_count: 3 }],
  }));
  process.exit(0);
}
console.error('unsupported fake CLI command');
process.exit(1);
`;

const validAnalysis = {
  scope: 'Metro Tower',
  window: { start: '2026-08-01', end: '2026-08-07' },
  population: 'meeting rooms',
  metric: 'working hours used',
  denominator: 'available working hours',
  timezone: 'America/Toronto',
  question: 'Which meeting rooms were busiest? ',
};

const withFakeCli = async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-modern-mcp-query-envelope-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const dataDir = path.join(dir, 'data');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const previousBin = process.env.DENSITY_CLI_BIN;
  process.env.DENSITY_CLI_BIN = cli;
  t.after(async () => {
    if (previousBin === undefined) delete process.env.DENSITY_CLI_BIN;
    else process.env.DENSITY_CLI_BIN = previousBin;
    await rm(dir, { recursive: true, force: true });
  });
  return { dataDir };
};

test('query requests default to a 120-second timeout', () => {
  assert.equal(QUERY_DB_DEFAULT_TIMEOUT_MS, 120000);
});

test('valid analysis envelopes preserve the allowed user-meaning fields', () => {
  assert.deepEqual(validateQueryAnalysis(validAnalysis), validAnalysis);
  assert.deepEqual(validateQueryAnalysis({ scope: 'Metro Tower' }), { scope: 'Metro Tower' });
});

test('malformed analysis fields and dates fail clearly', () => {
  assert.throws(() => validateQueryAnalysis(null), /analysis must be an object/);
  assert.throws(() => validateQueryAnalysis({ scope: 42 }), /analysis\.scope must be a string/);
  assert.throws(() => validateQueryAnalysis({ question: ' ' }), /analysis\.question must not be empty/);
  assert.throws(() => validateQueryAnalysis({ extra: 'not allowed' }), /unsupported field.*extra/);
  assert.throws(
    () => validateQueryAnalysis({ window: { start: '2026-02-30', end: '2026-03-01' } }),
    /analysis\.window\.start must be a valid ISO date/,
  );
  assert.throws(
    () => validateQueryAnalysis({ window: { start: '2026-08-08', end: '2026-08-01' } }),
    /start must be on or before.*end/,
  );
  assert.throws(
    () => validateQueryAnalysis({ window: { start: '2026-08-01' } }),
    /window must contain only start and end ISO dates/,
  );
  assert.throws(
    () => validateQueryAnalysis({ metric: 'x'.repeat(201) }),
    /analysis\.metric must be 200 characters or fewer/,
  );
});

test('query response separates declared context from returned evidence', async (t) => {
  const { dataDir } = await withFakeCli(t);
  const response = await queryDb({
    dataDir,
    sql: 'SELECT 3 AS room_count',
    analysis: validAnalysis,
  });

  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response.performance), [
    'cliResolutionMs',
    'capabilityDiscoveryMs',
    'cliCommandMs',
    'totalMs',
  ]);
  assert.ok(Object.values(response.performance).every((value) => Number.isInteger(value) && value >= 0));
  assert.equal(
    response.performance.totalMs,
    response.performance.cliResolutionMs
      + response.performance.capabilityDiscoveryMs
      + response.performance.cliCommandMs,
  );
  assert.deepEqual(response.declaredAnalysisContext, validAnalysis);
  assert.deepEqual(response.result, {
    columns: ['room_count'],
    rows: [{ room_count: 3 }],
  });
  assert.ok(!Object.hasOwn(response.result, 'declaredAnalysisContext'));
});

test('query requests use the query-only CLI path', async (t) => {
  const { dataDir } = await withFakeCli(t);
  const response = await queryDb({
    dataDir,
    sql: 'SELECT 3 AS room_count',
    analysis: { scope: 'Metro Tower' },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    columns: ['room_count'],
    rows: [{ room_count: 3 }],
  });
});

test('existing SQL safety behavior remains unchanged', async (t) => {
  const { dataDir } = await withFakeCli(t);
  await assert.rejects(() => queryDb({ dataDir }), /sql is required/);

  const response = await queryDb({
    dataDir,
    sql: 'DROP TABLE density_atlas_local_metrics',
    analysis: { question: 'Do not execute this.' },
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /read-only SQL safety rejected/);
  assert.equal(response.sql, 'DROP TABLE density_atlas_local_metrics');
  assert.deepEqual(response.declaredAnalysisContext, { question: 'Do not execute this.' });
});
