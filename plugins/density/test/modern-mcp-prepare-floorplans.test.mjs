import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareFloorplans } from '../scripts/density-core.mjs';

const fakeCli = `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
await appendFile(process.env.DENSITY_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ commands: { availableBuildings: true, onboardingScopeReadiness: true } }));
  process.exit(0);
}
if (args[0] === 'sync') {
  console.log('synced');
  process.exit(0);
}
if (args[0] === 'onboard' && args[1] === 'scope') {
  const id = args[2];
  const type = args[args.indexOf('--scope-type') + 1];
  if (id === 'missing') {
    console.log(JSON.stringify({ kind: 'density.onboarding.scope-resolution', ok: false, query: id, reason: 'not_found', suggestions: [], sourceViews: [] }));
    process.exit(0);
  }
  const floors = type === 'building'
    ? [{ id: 'f1', name: 'Floor 1', liveEligible: true }, { id: 'f2', name: 'Floor 2', liveEligible: false }]
    : [{ id, name: 'Floor 1', liveEligible: true }];
  console.log(JSON.stringify({
    kind: 'density.onboarding.scope-resolution',
    ok: true,
    query: id,
    requestedType: type,
    dataDir: process.env.DENSITY_CLI_DATA_DIR,
    organizationId: 'org_fixture',
    organizationName: 'Fixture',
    scope: { id, name: type === 'building' ? 'B1' : 'Floor 1', type, status: 'live', matchedBy: 'id', descendantSpaceCount: 3, rootSpaceIds: [id], spaceIds: [id] },
    readiness: {
      organizationId: 'org_fixture',
      scope: { id, name: type === 'building' ? 'B1' : 'Floor 1', type, status: 'live', matchedBy: 'id' },
      goLive: { goLiveState: 'complete', totalFloorplans: 2, goLiveFloorplans: 2, liveFloorplans: 2, futureFloorplans: 0 },
      metrics: { rows: 0, spaces: 0 },
      geometry: { mappedSpaces: 12, floorplans: 2, hasGeometry: true },
      chartQueryable: false,
      metadataOnly: true,
      liveWayfindingEligible: true,
      caveats: [],
      sourceViews: ['atlas_spaces_flat'],
    },
    floors,
    sourceViews: ['spaces'],
  }));
  process.exit(0);
}
console.error('unsupported fake CLI command');
process.exit(1);
`;

const prepareWithFakeCli = async (t, scope) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-prepare-floorplans-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const log = path.join(dir, 'commands.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const previousBin = process.env.DENSITY_CLI_BIN;
  const previousLog = process.env.DENSITY_TEST_LOG;
  process.env.DENSITY_CLI_BIN = cli;
  process.env.DENSITY_TEST_LOG = log;
  t.after(async () => {
    if (previousBin === undefined) delete process.env.DENSITY_CLI_BIN;
    else process.env.DENSITY_CLI_BIN = previousBin;
    if (previousLog === undefined) delete process.env.DENSITY_TEST_LOG;
    else process.env.DENSITY_TEST_LOG = previousLog;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await prepareFloorplans({ dataDir: path.join(dir, 'data'), ...scope });
  const commands = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  return { commands, response };
};

test('prepareFloorplans returns scoped readiness and floors without a portfolio scan', async (t) => {
  const { commands, response } = await prepareWithFakeCli(t, { buildingId: 'b1' });

  assert.equal(response.ok, true);
  assert.deepEqual(response.scope, { type: 'building', id: 'b1' });
  assert.equal(response.mapReadiness.ok, true);
  assert.equal(response.mapReadiness.liveWayfindingEligible, true);
  assert.deepEqual(response.mapReadiness.scope, { id: 'b1', name: 'B1', type: 'building', status: 'live', matchedBy: 'id' });
  assert.deepEqual(response.floors, [
    { id: 'f1', name: 'Floor 1', liveEligible: true },
    { id: 'f2', name: 'Floor 2', liveEligible: false },
  ]);
  assert.equal(response.textLiveChanged, false);
  assert.equal(response.historicalDataChanged, false);
  assert.deepEqual(commands.filter(([command]) => command === 'sync'), [
    ['sync', '--stream', 'floorplans', '--building', 'b1'],
  ]);
  assert.deepEqual(commands.filter(([command]) => command === 'onboard'), [
    ['onboard', 'scope', 'b1', '--scope-type', 'building', '--include-readiness', '--format', 'json'],
  ]);
  assert.equal(commands.some(([command]) => command === 'available-buildings'), false);
  assert.equal(commands.some((args) =>
    args.includes('spaces')
    || args.includes('metrics')
    || args.includes('occupancy')
    || args[0] === 'export'), false);
});

test('prepareFloorplans fetches only one requested floor', async (t) => {
  const { commands, response } = await prepareWithFakeCli(t, { floorId: 'f1' });

  assert.equal(response.ok, true);
  assert.deepEqual(response.scope, { type: 'floor', id: 'f1' });
  assert.deepEqual(response.floors, [{ id: 'f1', name: 'Floor 1', liveEligible: true }]);
  assert.deepEqual(commands.filter(([command]) => command === 'sync'), [
    ['sync', '--stream', 'floorplans', '--floor', 'f1'],
  ]);
  assert.deepEqual(commands.filter(([command]) => command === 'onboard'), [
    ['onboard', 'scope', 'f1', '--scope-type', 'floor', '--include-readiness', '--format', 'json'],
  ]);
});

test('prepareFloorplans reports an unresolved scope after the sync', async (t) => {
  const { response } = await prepareWithFakeCli(t, { buildingId: 'missing' });

  assert.equal(response.ok, false);
  assert.equal(response.mapReadiness.ok, false);
  assert.match(response.mapReadiness.error, /not found/);
  assert.deepEqual(response.floors, []);
  assert.equal(response.steps[0].ok, true);
});

test('prepareFloorplans requires one exact map scope', async () => {
  assert.equal((await prepareFloorplans({})).ok, false);
  assert.equal((await prepareFloorplans({ buildingId: 'b1', floorId: 'f1' })).ok, false);
});
