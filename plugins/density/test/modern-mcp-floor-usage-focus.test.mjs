import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { floorUsageReport, liveWayfindingStatus } from '../scripts/density-core.mjs';

const fakeCli = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.DENSITY_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ commands: { viz: true } }));
  process.exit(0);
}
if (args[0] === 'viz') {
  console.log(JSON.stringify({ report: 'floor-usage', artifact: { html: '/tmp/floor-usage.html' } }));
  process.exit(0);
}
if (args[0] === 'live') {
  if (process.env.DENSITY_TEST_LEGACY_LIVE === '1') {
    console.log(JSON.stringify({
      availabilityMode: 'live',
      candidates: [{ spaceId: 'legacy_room_1', name: 'Legacy Room 1', available: true }],
      unavailableMatches: [{ spaceId: 'legacy_room_2', name: 'Legacy Room 2', available: false }],
    }));
    process.exit(0);
  }
  if (process.env.DENSITY_TEST_EMPTY_MATCHED === '1') {
    console.log(JSON.stringify({
      availabilityMode: 'live',
      matchedSpaceIds: [],
      candidates: [{ spaceId: 'fallback_room_1', name: 'Fallback Room 1', available: true }],
      unavailableMatches: [{ spaceId: 'fallback_room_2', name: 'Fallback Room 2', available: false }],
    }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    availabilityMode: 'live',
    matchedSpaceIds: ['room_1', 'room_2', 'room_3'],
    candidates: [{ spaceId: 'room_1', name: 'Room 1', available: true }],
  }));
  process.exit(0);
}
if (args[0] === 'wayfinding' && args[1] === 'floorplan') {
  console.log(JSON.stringify({
    artifact: { html: '/tmp/wayfinding-floorplan.html' },
    panelTarget: { kind: 'local-file', path: '/tmp/wayfinding-floorplan.html' },
  }));
  process.exit(0);
}
process.exit(1);
`;

test('floorUsageReport passes one floor and repeated focus spaces to the CLI', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-floor-focus-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const calls = path.join(dir, 'calls.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const previousBin = process.env.DENSITY_CLI_BIN;
  const previousCalls = process.env.DENSITY_TEST_CALLS;
  process.env.DENSITY_CLI_BIN = cli;
  process.env.DENSITY_TEST_CALLS = calls;
  t.after(async () => {
    if (previousBin === undefined) delete process.env.DENSITY_CLI_BIN;
    else process.env.DENSITY_CLI_BIN = previousBin;
    if (previousCalls === undefined) delete process.env.DENSITY_TEST_CALLS;
    else process.env.DENSITY_TEST_CALLS = previousCalls;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await floorUsageReport({
    dataDir: path.join(dir, 'data'),
    floorId: 'floor_1',
    focusSpaceIds: ['room_1', 'room_2'],
  });
  assert.equal(response.ok, true);

  const invocations = (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  const viz = invocations.find(([command]) => command === 'viz');
  assert.ok(viz);
  assert.equal(viz[viz.indexOf('--floor') + 1], 'floor_1');
  assert.deepEqual(viz.flatMap((value, index) => value === '--focus-space' ? [viz[index + 1]] : []), ['room_1', 'room_2']);
});

test('liveWayfindingStatus falls back when matchedSpaceIds is empty', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-live-floor-empty-focus-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const calls = path.join(dir, 'calls.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const previousBin = process.env.DENSITY_CLI_BIN;
  const previousCalls = process.env.DENSITY_TEST_CALLS;
  const previousEmptyMatched = process.env.DENSITY_TEST_EMPTY_MATCHED;
  process.env.DENSITY_CLI_BIN = cli;
  process.env.DENSITY_TEST_CALLS = calls;
  process.env.DENSITY_TEST_EMPTY_MATCHED = '1';
  t.after(async () => {
    if (previousBin === undefined) delete process.env.DENSITY_CLI_BIN;
    else process.env.DENSITY_CLI_BIN = previousBin;
    if (previousCalls === undefined) delete process.env.DENSITY_TEST_CALLS;
    else process.env.DENSITY_TEST_CALLS = previousCalls;
    if (previousEmptyMatched === undefined) delete process.env.DENSITY_TEST_EMPTY_MATCHED;
    else process.env.DENSITY_TEST_EMPTY_MATCHED = previousEmptyMatched;
    await rm(dir, { recursive: true, force: true });
  });

  await liveWayfindingStatus({
    query: 'room for two',
    floorId: 'floor_1',
    includeFloorplan: true,
  });
  const invocations = (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  const wayfinding = invocations.find(([command, subcommand]) => command === 'wayfinding' && subcommand === 'floorplan');
  assert.deepEqual(wayfinding, [
    'wayfinding', 'floorplan', '--floor', 'floor_1', '--format', 'json',
    '--focus-space', 'fallback_room_1',
    '--focus-space', 'fallback_room_2',
  ]);
});

test('floorUsageReport rejects an invalid focus list before running the CLI report', async () => {
  await assert.rejects(
    () => floorUsageReport({ focusSpaceIds: 'room_1' }),
    /must be an array/i,
  );
  await assert.rejects(
    () => floorUsageReport({ focusSpaceIds: ['room_1', 'room_1'] }),
    /must not contain duplicate/i,
  );
});

test('liveWayfindingStatus requests and returns a separate focused live floorplan', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-live-floor-focus-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const calls = path.join(dir, 'calls.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const previousBin = process.env.DENSITY_CLI_BIN;
  const previousCalls = process.env.DENSITY_TEST_CALLS;
  process.env.DENSITY_CLI_BIN = cli;
  process.env.DENSITY_TEST_CALLS = calls;
  t.after(async () => {
    if (previousBin === undefined) delete process.env.DENSITY_CLI_BIN;
    else process.env.DENSITY_CLI_BIN = previousBin;
    if (previousCalls === undefined) delete process.env.DENSITY_TEST_CALLS;
    else process.env.DENSITY_TEST_CALLS = previousCalls;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await liveWayfindingStatus({
    query: 'room for two',
    floorId: 'floor_1',
    includeFloorplan: true,
  });
  assert.equal(response.liveAvailable, true);
  assert.equal(response.floorplanHtml, '/tmp/wayfinding-floorplan.html');
  const invocations = (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  const wayfinding = invocations.find(([command, subcommand]) => command === 'wayfinding' && subcommand === 'floorplan');
  assert.deepEqual(wayfinding, [
    'wayfinding', 'floorplan', '--floor', 'floor_1', '--format', 'json',
    '--focus-space', 'room_1',
    '--focus-space', 'room_2',
    '--focus-space', 'room_3',
  ]);
});

test('liveWayfindingStatus falls back to candidate IDs from an older CLI', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-live-floor-legacy-focus-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const calls = path.join(dir, 'calls.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const previousBin = process.env.DENSITY_CLI_BIN;
  const previousCalls = process.env.DENSITY_TEST_CALLS;
  const previousLegacy = process.env.DENSITY_TEST_LEGACY_LIVE;
  process.env.DENSITY_CLI_BIN = cli;
  process.env.DENSITY_TEST_CALLS = calls;
  process.env.DENSITY_TEST_LEGACY_LIVE = '1';
  t.after(async () => {
    if (previousBin === undefined) delete process.env.DENSITY_CLI_BIN;
    else process.env.DENSITY_CLI_BIN = previousBin;
    if (previousCalls === undefined) delete process.env.DENSITY_TEST_CALLS;
    else process.env.DENSITY_TEST_CALLS = previousCalls;
    if (previousLegacy === undefined) delete process.env.DENSITY_TEST_LEGACY_LIVE;
    else process.env.DENSITY_TEST_LEGACY_LIVE = previousLegacy;
    await rm(dir, { recursive: true, force: true });
  });

  await liveWayfindingStatus({
    query: 'room for two',
    floorId: 'floor_1',
    includeFloorplan: true,
  });
  const invocations = (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  const wayfinding = invocations.find(([command, subcommand]) => command === 'wayfinding' && subcommand === 'floorplan');
  assert.deepEqual(wayfinding, [
    'wayfinding', 'floorplan', '--floor', 'floor_1', '--format', 'json',
    '--focus-space', 'legacy_room_1',
    '--focus-space', 'legacy_room_2',
  ]);
});
