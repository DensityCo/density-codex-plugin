import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'mcp-server', 'server.mjs');

const fakeCliSource = `#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
const dataDir = process.env.DENSITY_CLI_DATA_DIR;
const log = process.env.DENSITY_TEST_HOT_LOG;
await appendFile(log, JSON.stringify(args) + '\\n');
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ version: '0.3.0', commands: {
    queryDb: true, refreshScope: true, onboardingScope: true, freshnessStatus: true,
    freshnessScope: process.env.DENSITY_TEST_FRESHNESS_SCOPE !== '0',
    refreshIntraday: true,
    wayfindingLiveAvailability: true, liveScopeQueries: true,
  } }));
} else if (args[0] === 'freshness-status') {
  const stored = await readFile(process.env.DENSITY_TEST_HOT_FRESHNESS, 'utf8').catch(() => 'stale');
  const scopeId = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : undefined;
  let state = stored.trim();
  try {
    const byScope = JSON.parse(stored);
    state = byScope[scopeId] ?? 'stale';
  } catch {}
  console.log(JSON.stringify({ kind: 'density.freshness.v1', streams: [{
    name: 'metrics', maxAgeMs: 172800000,
    observedAt: state === 'fresh' ? '2026-09-01T11:59:00.000Z' : '2026-08-20T00:00:00.000Z',
    ageMs: state === 'fresh' ? 60000 : 1080000000,
    stale: state !== 'fresh',
  }] }));
} else if (args[0] === 'query-db') {
  const analysis = args.includes('--analysis') ? JSON.parse(args[args.indexOf('--analysis') + 1]) : {};
  const resolvedScope = analysis.scope === 'Roxanne'
    ? { id: 'spc_roxanne', name: 'Roxanne', type: 'building' }
    : undefined;
  console.log(JSON.stringify({
    kind: 'density.query-db.v1', organizationId: 'org_fixture', rows: [], rowCount: 0,
    coverage: { scope: resolvedScope ? 'building' : 'organization', requestedScope: analysis.scope ?? null, buildingCount: 1 },
    ...(resolvedScope ? { resolvedScope } : {}),
    derivedDataset: { name: 'local_metrics', state: 'current', reason: 'current' },
  }));
} else if (args[0] === 'live') {
  console.log(JSON.stringify({
    kind: 'density.live-answer.v1', organizationId: 'org_fixture', availabilityMode: 'live',
    query: args.includes('--floor-query')
      ? { floorId: 'spc_roxanne_floor_5', buildingId: 'spc_roxanne' }
      : { buildingId: 'spc_roxanne' },
    checkedSpaceCount: 1, checkedFloorCount: 1, candidates: [], unavailableMatches: [],
    counts: { available: 0, occupied: 0, unavailable: 0, unknown: 1, stale: 0 },
  }));
} else if (args[0] === 'onboard') {
  const scopeId = args[2];
  const type = args.includes('--scope-type') ? args[args.indexOf('--scope-type') + 1] : 'building';
  console.log(JSON.stringify({ ok: true, scope: { id: scopeId, name: scopeId, type } }));
} else if (args[0] === 'refresh') {
  const scopeId = args[args.indexOf('--scope') + 1];
  const stored = await readFile(process.env.DENSITY_TEST_HOT_FRESHNESS, 'utf8').catch(() => 'stale');
  try {
    const byScope = JSON.parse(stored);
    byScope[scopeId] = 'fresh';
    await writeFile(process.env.DENSITY_TEST_HOT_FRESHNESS, JSON.stringify(byScope));
  } catch {
    await writeFile(process.env.DENSITY_TEST_HOT_FRESHNESS, 'fresh');
  }
  const jobId = 'refresh-' + scopeId;
  const jobDir = path.join(dataDir, 'background-jobs');
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, jobId + '.json'), JSON.stringify({
    kind: 'density.scope-refresh.v1', jobId, state: 'running',
    scope: { id: scopeId, name: scopeId, type: args[args.indexOf('--scope-type') + 1] },
    streams: ['metrics'], window: { since: '2026-08-30', until: '2026-09-01' },
    rows: 0, seconds: 0, startedAt: new Date().toISOString(),
  }));
} else {
  console.error('Unexpected command: ' + args.join(' '));
  process.exitCode = 1;
}
`;

const callMcp = (child, id, method, params = {}, timeoutMs = 10000) => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}. ${stderr}`)), timeoutMs);
  const onStdout = (chunk) => {
    stdout += chunk;
    const newline = stdout.indexOf('\n');
    if (newline < 0) return;
    child.stdout.off('data', onStdout);
    clearTimeout(timer);
    const message = JSON.parse(stdout.slice(0, newline));
    resolve(message.error ? message : message.result);
  };
  child.stdout.on('data', onStdout);
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

const commands = async (log) => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

const withServer = async (t, callback, options = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'density-mcp-hot-'));
  const cli = path.join(root, 'density-fake.mjs');
  const dataDir = path.join(root, 'data');
  const log = path.join(root, 'commands.jsonl');
  const freshness = path.join(root, 'freshness.txt');
  await mkdir(dataDir);
  await writeFile(cli, fakeCliSource);
  await chmod(cli, 0o755);
  await writeFile(log, '');
  await writeFile(freshness, options.freshness ?? 'fresh');
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ organizationId: 'org_fixture' }));
  if (options.hotScopes) {
    await writeFile(path.join(dataDir, 'hot-scopes.json'), JSON.stringify({
      kind: 'density.hot-scopes.v1',
      scopes: options.hotScopes,
    }));
  }
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DENSITY_CLI_BIN: cli,
      DENSITY_CLI_DATA_DIR: dataDir,
      DENSITY_TEST_HOT_LOG: log,
      DENSITY_TEST_HOT_FRESHNESS: freshness,
      DENSITY_TEST_FRESHNESS_SCOPE: options.scopeCapability === false ? '0' : '1',
      DENSITY_HOT_REFRESH_INTERVAL_MS: String(options.intervalMs ?? 3600000),
      DENSITY_DISABLE_BACKGROUND_REFRESH: options.disabled ? '1' : '0',
      DENSITY_INTRADAY_REFRESH: options.intradayEnabled ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  });
  await callMcp(child, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'hot-scope-test', version: '0.0.0' },
  });
  return callback({ child, dataDir, log, freshness });
};

test('query and live calls persist only their exact resolved scopes', async (t) => {
  await withServer(t, async ({ child, dataDir }) => {
    await callMcp(child, 2, 'tools/call', {
      name: 'query_db',
      arguments: { sql: 'SELECT 1', analysis: { scope: 'Roxanne' } },
    });
    await callMcp(child, 3, 'tools/call', {
      name: 'query_db',
      arguments: { sql: 'SELECT 1', analysis: { scope: 'The organization' } },
    });
    await callMcp(child, 4, 'tools/call', {
      name: 'live_wayfinding_status',
      arguments: { query: 'What is open?', building: 'Roxanne', floor: 'Floor 5' },
    });
    const hot = JSON.parse(await readFile(path.join(dataDir, 'hot-scopes.json'), 'utf8'));
    assert.deepEqual(hot.scopes.map(({ scopeId, type, count }) => ({ scopeId, type, count })), [
      { scopeId: 'spc_roxanne_floor_5', type: 'floor', count: 1 },
      { scopeId: 'spc_roxanne', type: 'building', count: 1 },
    ]);
    assert.equal(JSON.stringify(hot).includes('org_fixture'), false);
  });
});

test('server start refreshes one stale exact scope and reports the pass', async (t) => {
  await withServer(t, async ({ child, log }) => {
    assert.equal(await waitFor(async () => (await commands(log)).some(([command]) => command === 'refresh')), true);
    const refreshes = (await commands(log)).filter(([command]) => command === 'refresh');
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0][refreshes[0].indexOf('--scope') + 1], 'spc_roxanne');
    assert.equal(refreshes[0].includes('--all-spaces'), false);
    assert.equal(refreshes[0].includes('--intraday'), false);

    assert.equal(await waitFor(async () => {
      const response = await callMcp(child, 20, 'tools/call', { name: 'status', arguments: {} });
      return JSON.parse(response.content[0].text).backgroundRefresh.lastRunAt !== null;
    }), true);
    const statusResponse = await callMcp(child, 5, 'tools/call', { name: 'status', arguments: {} });
    const status = JSON.parse(statusResponse.content[0].text);
    assert.deepEqual(status.backgroundRefresh.scopes.map(({ scopeId, state }) => ({ scopeId, state })), [
      { scopeId: 'spc_roxanne', state: 'running' },
    ]);
    const healthResponse = await callMcp(child, 6, 'tools/call', { name: 'data_health_report', arguments: {} });
    const health = JSON.parse(healthResponse.content[0].text);
    assert.equal(health.backgroundRefresh.scopes[0].scopeId, 'spc_roxanne');
    assert.equal(health.checks.at(-1).name, 'hot scope background refresh');
  }, {
    freshness: 'stale',
    hotScopes: [{ scopeId: 'spc_roxanne', type: 'building', lastAskedAt: new Date().toISOString(), count: 1 }],
  });
});

test('intraday refresh requires the flag and a scope asked about today', async (t) => {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  await withServer(t, async ({ log }) => {
    assert.equal(await waitFor(async () => (
      await commands(log)
    ).filter(([command]) => command === 'refresh').length === 2), true);
    const refreshes = (await commands(log)).filter(([command]) => command === 'refresh');
    const byScope = Object.fromEntries(refreshes.map((args) => [
      args[args.indexOf('--scope') + 1],
      args,
    ]));
    assert.equal(byScope.spc_today.includes('--intraday'), true);
    assert.equal(byScope.spc_yesterday.includes('--intraday'), false);
  }, {
    freshness: JSON.stringify({ spc_today: 'stale', spc_yesterday: 'stale' }),
    hotScopes: [
      { scopeId: 'spc_today', type: 'building', lastAskedAt: today.toISOString(), count: 1 },
      { scopeId: 'spc_yesterday', type: 'floor', lastAskedAt: yesterday.toISOString(), count: 1 },
    ],
    intradayEnabled: true,
  });
});

test('server start refreshes only the stale scope when another hot scope is fresh', async (t) => {
  await withServer(t, async ({ log }) => {
    assert.equal(await waitFor(async () => (await commands(log)).some(([command]) => command === 'refresh')), true);
    const refreshes = (await commands(log)).filter(([command]) => command === 'refresh');
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0][refreshes[0].indexOf('--scope') + 1], 'spc_stale');
    const freshnessChecks = (await commands(log)).filter(([command]) => command === 'freshness-status');
    assert.deepEqual(freshnessChecks.map((args) => args[args.indexOf('--scope') + 1]).sort(), [
      'spc_fresh',
      'spc_stale',
    ]);
  }, {
    freshness: JSON.stringify({ spc_fresh: 'fresh', spc_stale: 'stale' }),
    hotScopes: [
      { scopeId: 'spc_fresh', type: 'building', lastAskedAt: new Date().toISOString(), count: 1 },
      { scopeId: 'spc_stale', type: 'floor', lastAskedAt: new Date(Date.now() - 1000).toISOString(), count: 1 },
    ],
  });
});

test('an older runtime never receives scoped freshness flags', async (t) => {
  await withServer(t, async ({ log }) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const calls = await commands(log);
    assert.equal(calls.some(([command]) => command === 'freshness-status'), false);
    assert.equal(calls.some(([command]) => command === 'refresh'), false);
  }, {
    freshness: 'stale',
    hotScopes: [{ scopeId: 'spc_roxanne', type: 'building', lastAskedAt: new Date().toISOString(), count: 1 }],
    scopeCapability: false,
  });
});

test('the interval refreshes a scope that becomes stale after a fresh catch-up', async (t) => {
  await withServer(t, async ({ log, freshness }) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await commands(log)).some(([command]) => command === 'refresh'), false);
    await writeFile(freshness, 'stale');
    assert.equal(await waitFor(async () => (await commands(log)).some(([command]) => command === 'refresh')), true);
    const refreshes = (await commands(log)).filter(([command]) => command === 'refresh');
    assert.equal(refreshes.length, 1);
  }, {
    freshness: 'fresh',
    intervalMs: 120,
    hotScopes: [{ scopeId: 'spc_roxanne', type: 'building', lastAskedAt: new Date().toISOString(), count: 1 }],
  });
});

test('fresh and disabled server starts do not refresh hot scopes', async (t) => {
  const hotScopes = [{ scopeId: 'spc_roxanne', type: 'building', lastAskedAt: new Date().toISOString(), count: 1 }];
  await withServer(t, async ({ log }) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await commands(log)).some(([command]) => command === 'refresh'), false);
  }, { freshness: 'fresh', intervalMs: 50, hotScopes });
  await withServer(t, async ({ child, dataDir, log }) => {
    const file = path.join(dataDir, 'hot-scopes.json');
    const before = await readFile(file, 'utf8');
    await callMcp(child, 9, 'tools/call', {
      name: 'query_db',
      arguments: { sql: 'SELECT 1', analysis: { scope: 'Roxanne' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await commands(log)).some(([command]) => command === 'refresh'), false);
    assert.equal(await readFile(file, 'utf8'), before);
  }, { freshness: 'stale', intervalMs: 50, hotScopes, disabled: true });
});
