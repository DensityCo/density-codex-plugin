import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sensorHealthReport } from '../scripts/density-core.mjs';

const fakeCli = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.DENSITY_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ commands: { sensorHealthCurrent: true, sensorHealthHistory: true } }));
  process.exit(0);
}
if (args[0] === 'sensor-health' && args[1] === 'current') {
  console.log(JSON.stringify({ contract: 'density.sensor-health-report.v1', organization: { id: 'org-2' }, complete: true }));
  process.exit(0);
}
if (args[0] === 'sensor-health' && args[1] === 'history') {
  console.log(JSON.stringify({ contract: 'density.sensor-health-history-report.v1', organization: { id: 'org-2' }, chart: { png: '/tmp/chart.png' }, complete: true }));
  process.exit(0);
}
process.exit(1);
`;

test('sensorHealthReport forwards typed filters to the direct CLI command', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-sensor-health-mcp-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const calls = path.join(dir, 'calls.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const priorBin = process.env.DENSITY_CLI_BIN;
  const priorCalls = process.env.DENSITY_TEST_CALLS;
  process.env.DENSITY_CLI_BIN = cli;
  process.env.DENSITY_TEST_CALLS = calls;
  t.after(async () => {
    if (priorBin === undefined) delete process.env.DENSITY_CLI_BIN;
    else process.env.DENSITY_CLI_BIN = priorBin;
    if (priorCalls === undefined) delete process.env.DENSITY_TEST_CALLS;
    else process.env.DENSITY_TEST_CALLS = priorCalls;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await sensorHealthReport({
    dataDir: path.join(dir, 'data'),
    building: 'Main',
    status: ['offline', 'error'],
    sensor: ['A'],
    includeSensors: true,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.report.contract, 'density.sensor-health-report.v1');
  const invocations = (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(invocations.map(([command]) => command), ['capabilities', 'sensor-health']);
  assert.deepEqual(invocations[1], [
    'sensor-health', 'current',
    '--building', 'Main',
    '--status', 'offline',
    '--status', 'error',
    '--sensor', 'A',
    '--include-sensors',
    '--format', 'json',
  ]);
});

test('sensorHealthReport rejects unknown mode without substituting current data', async () => {
  const response = await sensorHealthReport({ mode: 'uptime' });
  assert.equal(response.ok, false);
  assert.equal(response.unsupported, true);
});

test('sensorHealthReport rejects filters that history mode cannot preserve', async () => {
  const response = await sensorHealthReport({
    mode: 'history',
    building: 'Main',
    floor: 'Floor 1',
    start: '2026-08-01T07:00:00Z',
    end: '2026-08-02T07:00:00Z',
  });
  assert.equal(response.ok, false);
  assert.equal(response.invalid, true);
  assert.match(response.message, /without floor/i);
});

test('sensorHealthReport forwards historical scope, window, and chart request', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-sensor-health-history-mcp-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const calls = path.join(dir, 'calls.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const priorBin = process.env.DENSITY_CLI_BIN;
  const priorCalls = process.env.DENSITY_TEST_CALLS;
  process.env.DENSITY_CLI_BIN = cli;
  process.env.DENSITY_TEST_CALLS = calls;
  t.after(async () => {
    if (priorBin === undefined) delete process.env.DENSITY_CLI_BIN;
    else process.env.DENSITY_CLI_BIN = priorBin;
    if (priorCalls === undefined) delete process.env.DENSITY_TEST_CALLS;
    else process.env.DENSITY_TEST_CALLS = priorCalls;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await sensorHealthReport({
    mode: 'history',
    building: 'Main',
    start: '2026-08-01T07:00:00Z',
    end: '2026-08-02T07:00:00Z',
    includeChart: true,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.report.contract, 'density.sensor-health-history-report.v1');
  assert.equal(response.report.chart.png, '/tmp/chart.png');
  const invocations = (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(invocations[1], [
    'sensor-health', 'history',
    '--building', 'Main',
    '--start', '2026-08-01T07:00:00Z',
    '--end', '2026-08-02T07:00:00Z',
    '--interval', 'day',
    '--chart',
    '--format', 'json',
  ]);
});
