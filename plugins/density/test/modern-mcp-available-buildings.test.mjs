import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { availableBuildings } from '../scripts/density-core.mjs';

const fakeCli = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ commands: { availableBuildings: true } }));
  process.exit(0);
}
if (args[0] === 'available-buildings') {
  const includeMetrics = args.includes('--include-metrics');
  console.log(JSON.stringify({
    kind: 'density.available-buildings',
    organizationId: 'org_fixture',
    organizationName: 'Fixture',
    buildingCount: 2,
    buildings: [{
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
    }],
  }));
  process.exit(0);
}
console.error('unsupported fake CLI command');
process.exit(1);
`;

test('available_buildings includes stored metric coverage', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-available-buildings-'));
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

  const response = await availableBuildings({ dataDir });

  assert.equal(response.ok, true);
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
