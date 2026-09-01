import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { availableBuildings } from '../scripts/density-core.mjs';

const fakeCli = (commands) => `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
await appendFile(process.env.DENSITY_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ commands: ${JSON.stringify(commands)} }));
  process.exit(0);
}
if (args[0] === 'available-buildings') {
  const includeMetrics = args.includes('--include-metrics');
  const building = args.includes('--building') ? args[args.indexOf('--building') + 1] : undefined;
  const rows = [{
    id: 'b1',
    name: 'B1',
    metricCoverage: includeMetrics
      ? { rows: 2478354, spaces: 59, firstDay: '2025-01-01', lastDay: '2026-08-26' }
      : { rows: 0, spaces: 0 },
    chartQueryable: includeMetrics,
    liveWayfindingEligible: false,
    caveats: [],
  }, {
    id: 'empty',
    name: 'Empty Building',
    metricCoverage: { rows: 0, spaces: 0 },
    chartQueryable: false,
    liveWayfindingEligible: false,
    caveats: [],
  }];
  const buildings = building ? rows.filter((row) => row.id === building || row.name === building) : rows;
  console.log(JSON.stringify({
    kind: 'density.available-buildings',
    dataDir: process.env.DENSITY_CLI_DATA_DIR,
    organizationId: 'org_fixture',
    organizationName: 'Fixture',
    ...(building ? { scope: { query: building, ok: buildings.length === 1, id: buildings[0]?.id, name: buildings[0]?.name } } : {}),
    buildingCount: buildings.length,
    metricCoverageIncluded: includeMetrics,
    buildings,
    derivedDataset: { name: 'local_metrics', state: 'current', reason: 'The local_metrics dataset matches its inputs.' },
  }));
  process.exit(0);
}
console.error('unsupported fake CLI command');
process.exit(1);
`;

const withFakeCli = async (t, commands = { availableBuildings: true, availableBuildingsScope: true }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-available-buildings-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const log = path.join(dir, 'commands.jsonl');
  await writeFile(cli, fakeCli(commands));
  await chmod(cli, 0o755);
  await writeFile(log, '');
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
  const commandArgs = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(([command]) => command === 'available-buildings');
  return { dataDir: path.join(dir, 'data'), commandArgs };
};

test('available_buildings skips metric coverage by default and drops duplicated reasons', async (t) => {
  const { dataDir, commandArgs } = await withFakeCli(t);

  const response = await availableBuildings({ dataDir });

  assert.equal(response.ok, true);
  assert.deepEqual(await commandArgs(), [['available-buildings', '--format', 'json']]);
  assert.equal(response.metricCoverageIncluded, false);
  assert.equal(response.buildingCount, 2);
  assert.deepEqual(response.buildings[0].metricCoverage, { rows: 0, spaces: 0 });
  assert.equal(response.buildings.some((building) => Object.hasOwn(building, 'reasons')), false);
  assert.equal(response.summary.chartQueryable, 0);
  assert.equal(response.contract.queryNonLiveAllowed, true);
  assert.equal(response.derivedDataset.state, 'current');
  assert.equal(Object.hasOwn(response, 'derivedDatasetRepair'), false);
});

test('available_buildings includes stored metric coverage on request', async (t) => {
  const { dataDir, commandArgs } = await withFakeCli(t);

  const response = await availableBuildings({ dataDir, includeMetrics: true });

  assert.equal(response.ok, true);
  assert.deepEqual(await commandArgs(), [['available-buildings', '--include-metrics', '--format', 'json']]);
  assert.equal(response.metricCoverageIncluded, true);
  assert.deepEqual(response.buildings[0].metricCoverage, {
    rows: 2478354,
    spaces: 59,
    firstDay: '2025-01-01',
    lastDay: '2026-08-26',
  });
  assert.equal(response.buildings[0].chartQueryable, true);
  assert.deepEqual(response.buildings[1].metricCoverage, { rows: 0, spaces: 0 });
  assert.equal(response.buildings[1].chartQueryable, false);
});

test('available_buildings returns one building for a building filter', async (t) => {
  const { dataDir, commandArgs } = await withFakeCli(t);

  const response = await availableBuildings({ dataDir, building: 'B1' });

  assert.equal(response.ok, true);
  assert.deepEqual(await commandArgs(), [['available-buildings', '--building', 'B1', '--format', 'json']]);
  assert.deepEqual(response.scope, { query: 'B1', ok: true, id: 'b1', name: 'B1' });
  assert.equal(response.buildingCount, 1);
  assert.deepEqual(response.buildings.map((building) => building.id), ['b1']);
});

test('available_buildings reports an unsupported building filter on an older CLI', async (t) => {
  const { dataDir, commandArgs } = await withFakeCli(t, { availableBuildings: true });

  const response = await availableBuildings({ dataDir, building: 'B1' });

  assert.equal(response.ok, false);
  assert.equal(response.unsupported, true);
  assert.match(response.message, /building filter/);
  assert.deepEqual(await commandArgs(), []);
});
