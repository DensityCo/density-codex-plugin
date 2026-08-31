import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'mcp-server', 'server.mjs');
const schemaUri = 'density://schema';
const privateCanary = 'ACME-PRIVATE-CANARY';

const fakeCli = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.DEMO_STATE_FILE, 'utf8'));
appendFileSync(process.env.DEMO_LOG_FILE, args.join(' ') + '\\n');
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ commands: { demoMode: true, getDbSchema: true, queryDb: true, renderChart: true, sensorHealthCurrent: true, sensorHealthHistory: true } }));
  process.exit(0);
}
if (args[0] === 'demo' && args[1] === 'status') {
  if (state.invalidStatus) {
    console.error('${privateCanary} /private/customer/status');
    process.exit(1);
  }
  console.log(JSON.stringify({
    enabled: state.enabled,
    generation: state.generation,
    ...(state.enabled ? { organizationId: 'demo_org' } : {}),
  }));
  process.exit(0);
}
if (args[0] === 'get-db-schema') {
  if (state.failSchema) {
    console.error('${privateCanary} /private/customer/schema');
    process.exit(1);
  }
  console.log(JSON.stringify({
    kind: 'density.db-schema.v1',
    organizationId: 'demo_org',
    generation: state.generation,
    tables: [{ name: 'density_local_metrics' }],
  }));
  process.exit(0);
}
if (args[0] === 'query-db') {
  const sql = args[args.indexOf('--sql') + 1] || '';
  if (sql.includes('FAIL')) {
    console.error('${privateCanary} /private/customer/query');
    process.exit(1);
  }
  console.log(JSON.stringify({
    kind: 'density.query-db.v1',
    organizationId: 'demo_org',
    sql,
    executedSql: "SELECT '${privateCanary}' FROM '/private/customer/query.parquet'",
    rowCount: 1,
    rows: [{ room: 'Meeting Room 1', occupancy: 12 }],
    evidence: {
      id: 'qe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      artifact: '/private/customer/evidence.json',
    },
  }));
  process.exit(0);
}
if (args[0] === 'render-chart') {
  console.log(JSON.stringify({ kind: 'density.render-chart.v1', organizationId: 'demo_org' }));
  process.exit(0);
}
if (args[0] === 'sensor-health' && args[1] === 'current') {
  if (state.malformedSensorHealth) {
    console.log(JSON.stringify({ contract: 'density.sensor-health-report.v1', organization: { id: '${privateCanary}' }, complete: true }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    contract: 'density.sensor-health-report.v1',
    mode: 'current',
    organization: { id: 'demo_org', name: 'Demo Organization' },
    scope: { type: 'organization', ids: ['demo_org'], label: 'Demo Organization' },
    fetchedAt: '2026-08-31T12:00:00.000Z',
    totals: { cloud: 2, eligible: 2, excluded: 0 },
    statusCounts: [{ state: 'online', rawStatuses: ['healthy'], count: 2 }],
    locations: [{ buildingId: 'demo_building_001', buildingName: 'Building 1', floorId: 'demo_floor_001', floorName: 'Floor 1', sensorCount: 2, statusCounts: [{ state: 'online', count: 2 }] }],
    exclusions: [],
    ...(args.includes('--include-sensors') ? { sensors: [{ serialNumber: 'demo_sensor_001', sensorType: null, state: 'online', rawStatus: 'healthy', buildingId: 'demo_building_001', buildingName: 'Building 1', floorId: 'demo_floor_001', floorName: 'Floor 1', lastStatusChange: '2026-08-31T11:00:00.000Z' }] } : {}),
    complete: true,
    caveats: ['This report contains current cloud sensor health.'],
    demo: { generation: String(state.generation) },
    source: 'cloud',
  }));
  process.exit(0);
}
if (args[0] === 'sensor-health' && args[1] === 'history') {
  console.log(JSON.stringify({
    contract: 'density.sensor-health-history-report.v1', mode: 'history',
    organization: { id: 'demo_org', name: 'Demo Organization' },
    scope: { type: 'building', ids: ['demo_building_001'], label: 'Building 1', timeZone: 'America/Los_Angeles' },
    window: { start: '2026-08-30T07:00:00.000Z', end: '2026-08-31T07:00:00.000Z' },
    timezone: 'America/Los_Angeles', cohort: { definition: 'currently_assigned', eligible: 2, excluded: 0 },
    daily: [{ day: '2026-08-30', averageOnlineSensors: 1.5, averageKnownSensors: 2, averageUnknownSensors: 0, uptimePercent: 75, eligibleSensors: 2 }],
    complete: true, caveats: ['Cloud sensor health.'], demo: { generation: String(state.generation) }, source: 'cloud',
  }));
  process.exit(0);
}
console.error('${privateCanary} /private/customer/unexpected ' + args.join(' '));
process.exit(1);
`;

const callMcp = (child, id, method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`)), timeoutMs);
  const onStdout = (chunk) => {
    stdout += chunk;
    const newline = stdout.indexOf('\n');
    if (newline === -1) return;
    child.stdout.off('data', onStdout);
    clearTimeout(timeout);
    const message = JSON.parse(stdout.slice(0, newline));
    resolve(message.error ? message : message.result);
  };
  child.stdout.on('data', onStdout);
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

const fixture = async (t, initialState = { enabled: true, generation: 1 }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'density-modern-mcp-demo-'));
  const cli = path.join(root, 'density-fake.mjs');
  const dataDir = path.join(root, 'data');
  const stateFile = path.join(root, 'demo-state.json');
  const logFile = path.join(root, 'commands.log');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ demoMode: {} }));
  await writeFile(stateFile, JSON.stringify(initialState));
  await writeFile(logFile, '');
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    stateFile,
    logFile,
    writeState: async (state) => writeFile(stateFile, JSON.stringify(state)),
    startServer: () => spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        DENSITY_CLI_BIN: cli,
        DENSITY_CLI_DATA_DIR: dataDir,
        DEMO_STATE_FILE: stateFile,
        DEMO_LOG_FILE: logFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  };
};

const initialize = async (child, protocolVersion = '2025-06-18') => callMcp(child, 1, 'initialize', {
  protocolVersion,
  capabilities: {},
  clientInfo: { name: 'modern-mcp-demo-test', version: '0.0.0' },
});

test('Demo mode exposes only query, chart, and Demo-safe sensor health tools', async (t) => {
  const context = await fixture(t);
  const child = context.startServer();
  t.after(() => child.kill('SIGTERM'));
  await initialize(child);

  const listed = await callMcp(child, 2, 'tools/list');
  assert.deepEqual(listed.tools.map(({ name }) => name), ['query_db', 'render_chart', 'sensor_health_report']);

  const blocked = await callMcp(child, 3, 'tools/call', { name: 'status', arguments: {} });
  assert.equal(blocked.isError, true);
  assert.deepEqual(JSON.parse(blocked.content[0].text), blocked.structuredContent);
  assert.equal(blocked.structuredContent.kind, 'density.demo-error.v1');
  assert.match(blocked.structuredContent.error, /only historical queries, chart rendering, and Demo-safe sensor health/i);

  const alternateProfile = await callMcp(child, 4, 'tools/call', {
    name: 'query_db',
    arguments: { sql: 'SELECT 1', dataDir: '/private/other-profile' },
  });
  assert.equal(alternateProfile.isError, true);
  assert.match(alternateProfile.structuredContent.error, /host-selected local profile/i);

  const query = await callMcp(child, 5, 'tools/call', {
    name: 'query_db',
    arguments: { sql: 'SELECT 12 AS occupancy' },
  });
  assert.deepEqual(JSON.parse(query.content[0].text), query.structuredContent);
  assert.equal(query.structuredContent.result.rows[0].occupancy, 12);
  const serialized = JSON.stringify(query);
  assert.doesNotMatch(serialized, new RegExp(privateCanary));
  assert.doesNotMatch(serialized, /private\/customer|density-fake\.mjs|executedSql|dataDir/);

  const failed = await callMcp(child, 6, 'tools/call', {
    name: 'query_db',
    arguments: { sql: 'SELECT FAIL' },
  });
  assert.equal(failed.isError, true);
  assert.deepEqual(JSON.parse(failed.content[0].text), failed.structuredContent);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(`${privateCanary}|private/customer`));

  const commands = (await readFile(context.logFile, 'utf8')).trim().split('\n');
  assert.equal(commands.some((command) => command === 'status'), false);
  assert.equal(commands.filter((command) => command.startsWith('query-db ')).length, 2);
});

test('Demo sensor health preserves cloud measurements and masks every identity', async (t) => {
  const context = await fixture(t);
  const child = context.startServer();
  t.after(() => child.kill('SIGTERM'));
  await initialize(child);

  const aggregate = await callMcp(child, 2, 'tools/call', { name: 'sensor_health_report', arguments: {} });
  assert.equal(aggregate.structuredContent.report.totals.cloud, 2);
  assert.equal(aggregate.structuredContent.report.source, 'cloud');
  assert.equal(aggregate.structuredContent.report.sensors, undefined);

  const sensors = await callMcp(child, 3, 'tools/call', { name: 'sensor_health_report', arguments: { includeSensors: true } });
  assert.equal(sensors.structuredContent.report.sensors[0].serialNumber, 'demo_sensor_001');
  assert.doesNotMatch(JSON.stringify(sensors), new RegExp(`${privateCanary}|private/customer|serial_number|org-2`));

  const history = await callMcp(child, 4, 'tools/call', {
    name: 'sensor_health_report',
    arguments: { mode: 'history', building: 'Building 1', start: '2026-08-30T07:00:00Z', end: '2026-08-31T07:00:00Z' },
  });
  assert.equal(history.structuredContent.report.daily[0].uptimePercent, 75);
  assert.equal(history.structuredContent.report.source, 'cloud');
  assert.doesNotMatch(JSON.stringify(history), new RegExp(`${privateCanary}|private/customer|org-2`));
});

test('Demo sensor health fails closed for malformed output and generation changes', async (t) => {
  const context = await fixture(t, { enabled: true, generation: 1, malformedSensorHealth: true });
  const child = context.startServer();
  t.after(() => child.kill('SIGTERM'));
  await initialize(child);

  const malformed = await callMcp(child, 2, 'tools/call', { name: 'sensor_health_report', arguments: {} });
  assert.equal(malformed.isError, true);
  assert.doesNotMatch(JSON.stringify(malformed), new RegExp(privateCanary));

  await context.writeState({ enabled: true, generation: 2 });
  const changed = await callMcp(child, 3, 'tools/call', { name: 'sensor_health_report', arguments: {} });
  assert.equal(changed.isError, true);
  assert.match(changed.structuredContent.error, /status is unavailable/i);
});

test('Demo schema stays cached and mode changes require a fresh task', async (t) => {
  const context = await fixture(t);
  const child = context.startServer();
  t.after(() => child.kill('SIGTERM'));
  await initialize(child);

  const first = await callMcp(child, 2, 'resources/read', { uri: schemaUri });
  const repeated = await callMcp(child, 3, 'resources/read', { uri: schemaUri });
  assert.equal(JSON.parse(first.contents[0].text).generation, 1);
  assert.equal(repeated.contents[0].text, first.contents[0].text);

  await context.writeState({ enabled: true, generation: 2 });
  const refreshed = await callMcp(child, 4, 'resources/read', { uri: schemaUri });
  assert.deepEqual(JSON.parse(refreshed.contents[0].text), {
    ok: false,
    error: 'Demo mode could not provide the schema.',
  });
  assert.doesNotMatch(refreshed.contents[0].text, new RegExp(`${privateCanary}|private/customer|dataDir`));

  const commands = await readFile(context.logFile, 'utf8');
  assert.equal(commands.match(/^get-db-schema\b/gm)?.length, 1);
});

test('Demo errors stay generic for legacy text-only MCP clients', async (t) => {
  const context = await fixture(t);
  const child = context.startServer();
  t.after(() => child.kill('SIGTERM'));
  await initialize(child, '2024-11-05');

  const failed = await callMcp(child, 2, 'tools/call', {
    name: 'query_db',
    arguments: { sql: 'SELECT FAIL' },
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent, undefined);
  assert.deepEqual(JSON.parse(failed.content[0].text), {
    kind: 'density.demo-error.v1',
    ok: false,
    error: 'Demo mode could not complete this request.',
  });
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(`${privateCanary}|private/customer`));
});

test('Demo status failures hide the tool surface and block calls', async (t) => {
  const context = await fixture(t, { enabled: true, generation: 1, invalidStatus: true });
  const child = context.startServer();
  t.after(() => child.kill('SIGTERM'));
  await initialize(child);

  const listed = await callMcp(child, 2, 'tools/list');
  assert.deepEqual(listed.tools, []);
  const failed = await callMcp(child, 3, 'tools/call', { name: 'query_db', arguments: { sql: 'SELECT 1' } });
  assert.equal(failed.isError, true);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(`${privateCanary}|private/customer`));
  assert.match(failed.structuredContent.error, /status is unavailable/i);
});

test('Demo prompts do not repeat caller identity text', async (t) => {
  const context = await fixture(t);
  const child = context.startServer();
  t.after(() => child.kill('SIGTERM'));
  await initialize(child);

  const prompt = await callMcp(child, 2, 'prompts/get', {
    name: 'density',
    arguments: { question: `Show ${privateCanary} at the private customer building.` },
  });
  const text = prompt.messages[0].content.text;
  assert.match(text, /Demo mode is on/u);
  assert.doesNotMatch(text, new RegExp(`${privateCanary}|private customer building`, 'iu'));
});
