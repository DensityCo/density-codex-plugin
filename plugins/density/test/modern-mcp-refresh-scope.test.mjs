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
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
const command = args[0];
const dataDir = process.env.DENSITY_CLI_DATA_DIR;
const log = process.env.DENSITY_TEST_REFRESH_LOG;
if (log) await appendFile(log, JSON.stringify(args) + '\\n');
if (command === 'capabilities') {
  const commands = process.env.DENSITY_TEST_REFRESH_CAPABILITY === '0' ? {} : {
    refreshScope: true,
    onboardingScope: true,
    ...(process.env.DENSITY_TEST_INTRADAY_CAPABILITY === '0' ? {} : { refreshIntraday: true }),
  };
  console.log(JSON.stringify({ version: '0.3.0', commands }));
} else if (command === 'onboard') {
  const requested = args[2];
  console.log(JSON.stringify({ ok: true, scope: { id: requested === 'Roxanne' ? 'spc_roxanne' : requested, name: 'Roxanne', type: 'building' } }));
  if (process.env.DENSITY_TEST_DELETE_AFTER_ONBOARD === '1') await rm(process.argv[1], { force: true });
} else if (command === 'refresh') {
  const scopeId = args[args.indexOf('--scope') + 1];
  const jobId = 'refresh-' + scopeId;
  const file = path.join(dataDir, 'background-jobs', jobId + '.json');
  await mkdir(path.dirname(file), { recursive: true });
  const lockFile = path.join(dataDir, 'background-jobs', jobId + '.fake-lock');
  let lock;
  try {
    lock = await open(lockFile, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') process.exit(0);
    throw error;
  }
  if (log) await appendFile(log, JSON.stringify(['sync-start', scopeId]) + '\\n');
  const intraday = args.includes('--intraday');
  const running = { kind: 'density.scope-refresh.v1', jobId, state: 'running', phase: 'syncing', scope: { id: scopeId, name: 'Roxanne', type: 'building' }, streams: ['metrics'], window: { since: '2026-08-29T00:00:00.000Z', until: '2026-08-31T00:00:00.000Z' }, ...(intraday ? { intraday: true } : {}), rows: 0, seconds: 0, etaSeconds: 7, startedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(running));
  if (process.env.DENSITY_TEST_REFRESH_MODE === 'complete') {
    await new Promise((resolve) => setTimeout(resolve, 40));
    await writeFile(file, JSON.stringify({ ...running, state: 'complete', phase: undefined, coverage: { coverageFrom: running.window.since, coverageThrough: running.window.until, streams: [] }, ...(intraday ? { provisionalThrough: running.window.until } : {}), rows: 42, seconds: 0.04, etaSeconds: undefined, completedAt: '2026-09-01T00:00:00.040Z' }));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await lock.close();
  await rm(lockFile, { force: true });
} else if (command === 'refresh-status') {
  const jobId = args[args.indexOf('--job') + 1];
  try {
    console.log(await readFile(path.join(dataDir, 'background-jobs', jobId + '.json'), 'utf8'));
  } catch {
    console.error('Refresh job not found.');
    process.exitCode = 1;
  }
} else {
  console.error('Unexpected command: ' + args.join(' '));
  process.exitCode = 1;
}
`;

function callMcp(child, id, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
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
}

const withServer = async (t, mode, callback, options = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'density-mcp-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'density-fake.mjs');
  const dataDir = path.join(root, 'data');
  const log = path.join(root, 'commands.jsonl');
  await writeFile(cli, fakeCliSource);
  await chmod(cli, 0o755);
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ organizationId: 'org_fixture' }));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DENSITY_CLI_BIN: cli,
      ...(options.cliCommand ? { DENSITY_CLI_COMMAND: cli } : {}),
      DENSITY_CLI_DATA_DIR: dataDir,
      DENSITY_TEST_REFRESH_LOG: log,
      DENSITY_TEST_REFRESH_MODE: mode,
      DENSITY_TEST_REFRESH_CAPABILITY: options.capability === false ? '0' : '1',
      DENSITY_TEST_INTRADAY_CAPABILITY: options.intradayCapability === false ? '0' : '1',
      DENSITY_TEST_DELETE_AFTER_ONBOARD: options.deleteAfterOnboard ? '1' : '0',
      DENSITY_INTRADAY_REFRESH: options.intradayEnabled ? '1' : '0',
      DENSITY_DISABLE_BACKGROUND_REFRESH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await callMcp(child, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'refresh-test', version: '0.0.0' },
  });
  return callback({ child, dataDir, log });
};

test('refresh tools expose hosted-compatible schemas and annotations', async (t) => {
  await withServer(t, 'running', async ({ child }) => {
    const listed = await callMcp(child, 2, 'tools/list');
    const refresh = listed.tools.find((tool) => tool.name === 'refresh_scope');
    const status = listed.tools.find((tool) => tool.name === 'refresh_status');
    assert.deepEqual(Object.keys(refresh.inputSchema.properties), ['scope', 'scopeType', 'streams', 'since', 'until', 'intraday', 'budgetMs', 'wait']);
    assert.deepEqual(refresh.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    assert.deepEqual(status.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });
});

test('refresh_scope rejects intraday before it starts the CLI when the feature is disabled', async (t) => {
  await withServer(t, 'running', async ({ child, log }) => {
    const response = await callMcp(child, 2, 'tools/call', {
      name: 'refresh_scope',
      arguments: { scope: 'Roxanne', intraday: true },
    });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
    assert.match(result.error, /DENSITY_INTRADAY_REFRESH=1/u);
    assert.equal(await readFile(log, 'utf8').catch(() => ''), '');
  });
});

test('refresh_scope passes enabled intraday to a capable scoped CLI', async (t) => {
  await withServer(t, 'complete', async ({ child, log }) => {
    const response = await callMcp(child, 2, 'tools/call', {
      name: 'refresh_scope',
      arguments: { scope: 'Roxanne', scopeType: 'building', intraday: true, budgetMs: 2000 },
    });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.state, 'complete');
    assert.equal(result.intraday, true);
    assert.equal(result.provisionalThrough, '2026-08-31T00:00:00.000Z');
    const commands = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    const refresh = commands.find(([command]) => command === 'refresh');
    assert.equal(refresh.includes('--intraday'), true);
    assert.equal(refresh.includes('--all-spaces'), false);
  }, { intradayEnabled: true });
});

test('refresh_scope gates an older CLI without intraday support before scope resolution', async (t) => {
  await withServer(t, 'running', async ({ child, log }) => {
    const response = await callMcp(child, 2, 'tools/call', {
      name: 'refresh_scope',
      arguments: { scope: 'Roxanne', intraday: true },
    });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
    assert.match(result.error, /does not support intraday/u);
    const commands = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(commands.every(([command]) => command === 'capabilities'), true);
  }, { intradayEnabled: true, intradayCapability: false });
});

test('refresh_scope returns completed scoped coverage inside its budget', async (t) => {
  await withServer(t, 'complete', async ({ child }) => {
    const response = await callMcp(child, 2, 'tools/call', {
      name: 'refresh_scope',
      arguments: { scope: 'Roxanne', scopeType: 'building', streams: ['metrics'], budgetMs: 2000 },
    });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.state, 'complete');
    assert.equal(result.rows, 42);
    assert.equal(result.coverage.coverageThrough, '2026-08-31T00:00:00.000Z');
  });
});

test('refresh_scope returns one stable running job and refresh_status reads it', async (t) => {
  await withServer(t, 'running', async ({ child, log }) => {
    const first = await callMcp(child, 2, 'tools/call', {
      name: 'refresh_scope',
      arguments: { scope: 'Roxanne', budgetMs: 20 },
    });
    const second = await callMcp(child, 3, 'tools/call', {
      name: 'refresh_scope',
      arguments: { scope: 'Roxanne', wait: false },
    });
    const firstResult = JSON.parse(first.content[0].text);
    const secondResult = JSON.parse(second.content[0].text);
    assert.equal(firstResult.state, 'running');
    assert.equal(firstResult.jobId, 'refresh-spc_roxanne');
    assert.equal(Number.isFinite(firstResult.etaSeconds), true);
    assert.equal(secondResult.jobId, firstResult.jobId);

    const status = await callMcp(child, 4, 'tools/call', {
      name: 'refresh_status',
      arguments: { jobId: firstResult.jobId },
    });
    assert.equal(JSON.parse(status.content[0].text).state, 'running');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const commands = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(commands.some((args) => args.includes('--all-spaces')), false);
    assert.equal(commands.filter(([command]) => command === 'refresh').length, 2);
    assert.equal(commands.filter(([command]) => command === 'sync-start').length, 1);
  });
});

test('refresh_scope gates older runtimes before scope resolution or refresh', async (t) => {
  await withServer(t, 'running', async ({ child, log }) => {
    const response = await callMcp(child, 2, 'tools/call', {
      name: 'refresh_scope',
      arguments: { scope: 'Roxanne' },
    });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
    const commands = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(commands.every(([command]) => command === 'capabilities'), true);
  }, { capability: false });
});

test('refresh_scope rejects a window over the configured cap before scope resolution', async (t) => {
  await withServer(t, 'running', async ({ child, log }) => {
    const response = await callMcp(child, 2, 'tools/call', {
      name: 'refresh_scope',
      arguments: {
        scope: 'Roxanne',
        since: '2026-07-31T23:59:59Z',
        until: '2026-09-01T00:00:00Z',
      },
    });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /more than 31 days/iu);
    const commands = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(commands.every(([command]) => command === 'capabilities'), true);
  });
});

test('refresh_scope rejects an organization scope before it starts the CLI', async (t) => {
  await withServer(t, 'running', async ({ child, log }) => {
    const response = await callMcp(child, 2, 'tools/call', {
      name: 'refresh_scope',
      arguments: { scope: 'org_fixture', scopeType: 'organization' },
    });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /scopeType|organization/iu);
    const commands = await readFile(log, 'utf8').catch(() => '');
    assert.equal(commands.includes('"refresh"'), false);
  });
});

test('refresh_scope reports a detached spawn failure instead of a running job', async (t) => {
  await withServer(t, 'running', async ({ child }) => {
    const response = await callMcp(child, 2, 'tools/call', {
      name: 'refresh_scope',
      arguments: { scope: 'Roxanne', wait: false },
    });
    assert.equal(response.isError, true);
    assert.doesNotMatch(response.content[0].text, /"state":"running"/u);
  }, { cliCommand: true, deleteAfterOnboard: true });
});
