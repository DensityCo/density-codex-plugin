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
  const commands = process.env.DENSITY_TEST_OLD_CLI === '1'
    ? { wayfindingLiveAvailability: true }
    : { wayfindingLiveAvailability: true, liveScopeQueries: true, liveFloorplan: true };
  console.log(JSON.stringify({ version: '0.3.0', commands }));
  process.exit(0);
}
if (args[0] === 'live') {
  const profile = { dataDir: '/tmp/density-data', organizationId: 'org_fixture', organizationName: 'Fixture' };
  if (args.includes('Ambiguous Floor')) {
    console.log(JSON.stringify({
      kind: 'density.live-error.v1',
      ...profile,
      error: { code: 'live_feed_unavailable', message: 'The floor name is ambiguous: Floor 03: SEA37, Floor 03: JFK27' },
      clarification: {
        question: 'Which floor do you mean?',
        reason: 'ambiguous-floor',
        suggestions: [
          { kind: 'floor', id: 'floor_3_roxanne', name: 'Floor 03: SEA37', buildingId: 'spc_roxanne' },
          { kind: 'floor', id: 'floor_3_jfk27', name: 'Floor 03: JFK27', buildingId: 'spc_jfk27' },
        ],
      },
    }));
    process.exit(0);
  }
  if (!args.includes('--building-query') && !args.includes('--floor-query') && !args.includes('--floor')) {
    console.log(JSON.stringify({
      kind: 'density.live-answer.v1',
      ...profile,
      availabilityMode: 'needs-scope',
      checkedSpaceCount: 0,
      checkedFloorCount: 0,
      candidates: [],
      unavailableMatches: [],
      counts: { available: 0, occupied: 0, unavailable: 0, unknown: 0, stale: 0 },
      clarification: { question: 'Which building or floor should I check for live availability?', reason: 'needs-scope', suggestions: [] },
    }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    kind: 'density.live-answer.v1',
    ...profile,
    availabilityMode: 'live',
    elapsedMs: 412,
    checkedSpaceCount: 6,
    checkedFloorCount: 1,
    query: { floorId: args.includes('--floor-query') ? 'floor_3_roxanne' : undefined },
    counts: { available: 1, occupied: 1, unavailable: 1, unknown: 0, stale: 3 },
    candidates: [{ name: 'Juniper', floorName: 'Floor 03: SEA37', buildingName: 'SEA37 - Roxanne', available: true, occupied: false, availabilityStatus: 'available' }],
    unavailableMatches: [
      { name: 'Cedar', available: false, occupied: true, availabilityStatus: 'occupied' },
      { name: 'Birch', available: false, occupied: false, availabilityStatus: 'stale', observedAt: '2026-06-23T15:00:00.000Z', receivedAt: '2026-06-23T18:00:00.000Z', healthStatus: 'healthy' },
      { name: 'Maple', available: false, occupied: false, availabilityStatus: 'unavailable', healthStatus: 'offline' },
      { name: 'Oak', available: false, occupied: false, availabilityStatus: 'stale' },
      { name: 'Pine', available: false, occupied: false, availabilityStatus: 'stale' },
    ],
    ...(args.includes('--floorplan')
      ? {
          floorplanArtifact: { html: '/tmp/live-floorplan.html' },
          floorplanPanelTarget: { kind: 'local-html', path: '/tmp/live-floorplan.html' },
        }
      : {}),
  }));
  process.exit(0);
}
process.exit(1);
`;

const withFakeCli = async (t, env = {}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-live-wayfinding-mcp-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const calls = path.join(dir, 'calls.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const overrides = { DENSITY_CLI_BIN: cli, DENSITY_TEST_CALLS: calls, ...env };
  const prior = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(async () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dataDir: path.join(dir, 'data'),
    invocations: async () => (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse)
      .filter(([command]) => command !== 'capabilities'),
  };
};

test('liveWayfindingStatus resolves a building name and calls density live', async (t) => {
  const { dataDir, invocations } = await withFakeCli(t);

  const response = await liveWayfindingStatus({
    query: 'which conference rooms are available right now?',
    building: 'Roxanne',
    dataDir,
  });

  assert.equal(response.ok, true);
  assert.equal(response.liveAvailable, true);
  assert.equal(response.walkableRecommendation, true);
  assert.equal(response.organizationId, 'org_fixture');
  assert.equal(response.organizationName, 'Fixture');
  assert.equal(response.summary.spacesChecked, 6);
  assert.equal(response.summary.floorsChecked, 1);
  assert.equal(response.summary.elapsedMs, 412);
  assert.equal(response.summary.spaces[0].floorName, 'Floor 03: SEA37');
  assert.deepEqual(response.summary.counts, { available: 1, occupied: 1, unavailable: 1, unknown: 0, stale: 3 });
  assert.deepEqual(response.summary.spaces.map(({ name, state }) => ({ name, state })), [
    { name: 'Juniper', state: 'available' },
    { name: 'Cedar', state: 'occupied' },
    { name: 'Birch', state: 'stale' },
    { name: 'Maple', state: 'unavailable' },
    { name: 'Oak', state: 'stale' },
    { name: 'Pine', state: 'stale' },
  ]);
  const calls = await invocations();
  assert.deepEqual(calls, [[
    'live', 'which conference rooms are available right now?', '--format', 'json',
    '--building-query', 'Roxanne', '--live-timeout-ms', '30000', '--max-age-seconds', '30',
  ]]);
});

test('liveWayfindingStatus returns floor clarification without listing the portfolio', async (t) => {
  const { dataDir, invocations } = await withFakeCli(t);

  const response = await liveWayfindingStatus({
    query: 'how many phone booths are available?',
    floor: 'Ambiguous Floor',
    dataDir,
  });

  assert.equal(response.ok, false);
  assert.equal(response.needsInput, true);
  assert.equal(response.liveAvailable, false);
  assert.match(response.error, /floor name is ambiguous/);
  assert.equal(response.nextAction.id, 'choose_scope');
  assert.match(response.nextAction.label, /floorId/);
  assert.equal(response.clarification.reason, 'ambiguous-floor');
  assert.deepEqual(response.clarification.suggestions.map(({ id, name }) => ({ id, name })), [
    { id: 'floor_3_roxanne', name: 'Floor 03: SEA37' },
    { id: 'floor_3_jfk27', name: 'Floor 03: JFK27' },
  ]);
  const calls = await invocations();
  assert.deepEqual(calls, [[
    'live', 'how many phone booths are available?', '--format', 'json',
    '--floor-query', 'Ambiguous Floor', '--live-timeout-ms', '30000', '--max-age-seconds', '30',
  ]]);
});

test('liveWayfindingStatus resolves a floor within a building in one CLI call', async (t) => {
  const { dataDir, invocations } = await withFakeCli(t);

  const response = await liveWayfindingStatus({
    query: 'open phone booths',
    building: 'Roxanne',
    floor: '3rd floor',
    dataDir,
  });

  assert.equal(response.ok, true);
  assert.equal(response.summary.floorsChecked, 1);
  const calls = await invocations();
  assert.deepEqual(calls, [[
    'live', 'open phone booths', '--format', 'json', '--building-query', 'Roxanne',
    '--floor-query', '3rd floor', '--live-timeout-ms', '30000', '--max-age-seconds', '30',
  ]]);
});

test('liveWayfindingStatus asks for input when the CLI needs a scope', async (t) => {
  const { dataDir } = await withFakeCli(t);

  const response = await liveWayfindingStatus({
    query: 'how many phone booths are available right now?',
    dataDir,
  });

  assert.equal(response.ok, false);
  assert.equal(response.needsInput, true);
  assert.equal(response.liveAvailable, false);
  assert.equal(response.availabilityMode, 'needs-scope');
  assert.deepEqual(response.clarification, {
    question: 'Which building or floor should I check for live availability?',
    reason: 'needs-scope',
    suggestions: [],
  });
  assert.equal(response.nextAction.id, 'choose_scope');
  assert.match(response.nextAction.label, /building or floor name/);
  assert.equal(response.summary, undefined);
  assert.equal(response.explanation, undefined);
});

test('liveWayfindingStatus refuses to forward scope names to a CLI without liveScopeQueries', async (t) => {
  const { dataDir, invocations } = await withFakeCli(t, { DENSITY_TEST_OLD_CLI: '1' });

  const response = await liveWayfindingStatus({
    query: 'phone booths',
    building: 'Roxanne',
    floor: '3',
    dataDir,
  });

  assert.equal(response.ok, false);
  assert.equal(response.liveAvailable, false);
  assert.equal(response.error, 'Density CLI 0.3.0 cannot resolve building or floor names.');
  assert.deepEqual(response.nextAction, {
    id: 'install_managed_cli',
    tool: 'install_managed_cli',
    label: 'Install the plugin-managed Density runtime.',
  });
  assert.deepEqual(await invocations(), []);
});

test('liveWayfindingStatus gets the floorplan from the single live process when the CLI supports it', async (t) => {
  const { dataDir, invocations } = await withFakeCli(t);

  const response = await liveWayfindingStatus({
    query: 'phone booths',
    floorId: 'floor_3_roxanne',
    includeFloorplan: true,
    dataDir,
  });

  assert.equal(response.ok, true);
  assert.equal(response.floorplanHtml, '/tmp/live-floorplan.html');
  assert.equal(response.floorplanPanelTarget.path, '/tmp/live-floorplan.html');
  const calls = await invocations();
  assert.deepEqual(calls, [[
    'live', 'phone booths', '--format', 'json', '--floor', 'floor_3_roxanne',
    '--live-timeout-ms', '30000', '--max-age-seconds', '30', '--floorplan',
  ]]);
});
