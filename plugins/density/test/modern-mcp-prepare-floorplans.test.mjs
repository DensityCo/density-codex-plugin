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
  console.log(JSON.stringify({ commands: { availableBuildings: true } }));
  process.exit(0);
}
if (args[0] === 'sync') {
  console.log('synced');
  process.exit(0);
}
if (args[0] === 'available-buildings') {
  console.log(JSON.stringify({
    kind: 'density.available-buildings',
    organizationId: 'org_fixture',
    organizationName: 'Fixture',
    buildings: [{ id: 'b1', name: 'B1', geometry: { hasGeometry: true }, liveWayfindingEligible: true, caveats: [] }],
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

test('prepareFloorplans scopes map preparation without historical sync', async (t) => {
  const { commands, response } = await prepareWithFakeCli(t, { buildingId: 'b1' });

  assert.equal(response.ok, true);
  assert.deepEqual(response.scope, { type: 'building', id: 'b1' });
  assert.equal(response.mapReadiness.summary.liveWayfindingEligible, 1);
  assert.equal(response.textLiveChanged, false);
  assert.equal(response.historicalDataChanged, false);
  assert.deepEqual(commands.filter(([command]) => command === 'sync'), [
    ['sync', '--stream', 'floorplans', '--building', 'b1'],
  ]);
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
  assert.deepEqual(commands.filter(([command]) => command === 'sync'), [
    ['sync', '--stream', 'floorplans', '--floor', 'f1'],
  ]);
});

test('prepareFloorplans requires one exact map scope', async () => {
  assert.equal((await prepareFloorplans({})).ok, false);
  assert.equal((await prepareFloorplans({ buildingId: 'b1', floorId: 'f1' })).ok, false);
});
