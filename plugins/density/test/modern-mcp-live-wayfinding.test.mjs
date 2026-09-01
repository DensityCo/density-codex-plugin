import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { liveWayfindingStatus } from '../scripts/density-core.mjs';

const fakeCli = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.DENSITY_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ commands: { wayfindingLiveAvailability: true } }));
  process.exit(0);
}
if (args[0] === 'onboard' && args[1] === 'scope') {
  if (args[2] === 'Ambiguous Floor') {
    console.log(JSON.stringify({
      ok: false,
      reason: 'ambiguous',
      suggestions: [
        { id: 'floor_3_roxanne', name: 'Floor 03: SEA37', type: 'floor' },
        { id: 'floor_3_jfk27', name: 'Floor 03: JFK27', type: 'floor' },
      ],
    }));
    process.exit(0);
  }
  console.log(JSON.stringify({ ok: true, scope: { id: 'spc_roxanne', name: 'SEA37 - Roxanne', type: 'building' } }));
  process.exit(0);
}
if (args[0] === 'live') {
  console.log(JSON.stringify({
    kind: 'density.live-answer.v1',
    availabilityMode: 'live',
    checkedSpaceCount: 4,
    counts: { available: 1, occupied: 1, unavailable: 1, unknown: 0, stale: 1 },
    candidates: [{ name: 'Juniper', available: true, occupied: false, availabilityStatus: 'available' }],
    unavailableMatches: [
      { name: 'Cedar', available: false, occupied: true, availabilityStatus: 'occupied' },
      { name: 'Birch', available: false, occupied: false, availabilityStatus: 'stale', observedAt: '2026-06-23T15:00:00.000Z', receivedAt: '2026-06-23T18:00:00.000Z', healthStatus: 'healthy' },
      { name: 'Maple', available: false, occupied: false, availabilityStatus: 'unavailable', healthStatus: 'offline' },
    ],
  }));
  process.exit(0);
}
process.exit(1);
`;

test('liveWayfindingStatus resolves a building name and calls density live', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-live-wayfinding-mcp-'));
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

  const response = await liveWayfindingStatus({
    query: 'which conference rooms are available right now?',
    building: 'Roxanne',
    dataDir: path.join(dir, 'data'),
  });

  assert.equal(response.ok, true);
  assert.equal(response.liveAvailable, true);
  assert.equal(response.walkableRecommendation, true);
  assert.equal(response.summary.spacesChecked, 4);
  assert.deepEqual(response.summary.counts, { available: 1, occupied: 1, unavailable: 1, unknown: 0, stale: 1 });
  assert.deepEqual(response.summary.spaces.map(({ name, state }) => ({ name, state })), [
    { name: 'Juniper', state: 'available' },
    { name: 'Cedar', state: 'occupied' },
    { name: 'Birch', state: 'stale' },
    { name: 'Maple', state: 'unavailable' },
  ]);
  const invocations = (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(invocations.find(([command]) => command === 'onboard'), [
    'onboard', 'scope', 'Roxanne', '--scope-type', 'building', '--format', 'json',
  ]);
  assert.deepEqual(invocations.find(([command]) => command === 'live'), [
    'live', 'which conference rooms are available right now?', '--format', 'json',
    '--building', 'spc_roxanne', '--live-timeout-ms', '5000', '--max-age-seconds', '30',
  ]);
  assert.equal(invocations.some(([command]) => command === 'available-buildings'), false);
});

test('liveWayfindingStatus returns floor clarification without listing the portfolio', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-live-wayfinding-mcp-'));
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

  const response = await liveWayfindingStatus({
    query: 'how many phone booths are available?',
    floor: 'Ambiguous Floor',
    dataDir: path.join(dir, 'data'),
  });

  assert.equal(response.ok, false);
  assert.equal(response.liveAvailable, false);
  assert.match(response.error, /floor name is ambiguous/);
  assert.deepEqual(response.clarification.map(({ name }) => name), [
    'Floor 03: SEA37',
    'Floor 03: JFK27',
  ]);
  const invocations = (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(invocations.find(([command]) => command === 'onboard'), [
    'onboard', 'scope', 'Ambiguous Floor', '--scope-type', 'floor', '--format', 'json',
  ]);
  assert.equal(invocations.some(([command]) => command === 'live'), false);
  assert.equal(invocations.some(([command]) => command === 'available-buildings'), false);
});
