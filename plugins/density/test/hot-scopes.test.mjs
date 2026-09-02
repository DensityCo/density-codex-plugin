import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createHotScopeManager,
  DEFAULT_HOT_REFRESH_INTERVAL_MS,
  DEFAULT_HOT_SCOPES_MAX,
  DEFAULT_HOT_SCOPES_MAX_AGE_MS,
  readHotScopes,
  resolveHotScopeSettings,
  writeHotScope,
} from '../mcp-server/hot-scopes.mjs';

test('hot scope settings use one validated default for each policy value', () => {
  assert.deepEqual(resolveHotScopeSettings({}), {
    maxScopes: DEFAULT_HOT_SCOPES_MAX,
    maxAgeMs: DEFAULT_HOT_SCOPES_MAX_AGE_MS,
    refreshIntervalMs: DEFAULT_HOT_REFRESH_INTERVAL_MS,
    disabled: false,
  });
  assert.deepEqual(resolveHotScopeSettings({
    DENSITY_HOT_SCOPES_MAX: '3',
    DENSITY_HOT_SCOPES_MAX_AGE_MS: '4000',
    DENSITY_HOT_REFRESH_INTERVAL_MS: '5000',
    DENSITY_DISABLE_BACKGROUND_REFRESH: '1',
  }), {
    maxScopes: 3,
    maxAgeMs: 4000,
    refreshIntervalMs: 5000,
    disabled: true,
  });
  assert.throws(() => resolveHotScopeSettings({ DENSITY_HOT_SCOPES_MAX: '0' }), /positive integer/u);
});

test('hot scopes keep one entry, enforce the cap, decay old entries, and reject organizations', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-hot-scopes-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const environment = { DENSITY_HOT_SCOPES_MAX: '2', DENSITY_HOT_SCOPES_MAX_AGE_MS: '1000' };

  assert.equal(await writeHotScope(dataDir, { scopeId: 'org_fixture', type: 'organization' }, {
    environment,
    now: new Date('2026-09-01T00:00:00.000Z'),
  }), false);
  await writeHotScope(dataDir, { scopeId: 'spc_a', type: 'building' }, {
    environment,
    now: new Date('2026-09-01T00:00:00.000Z'),
  });
  await writeHotScope(dataDir, { scopeId: 'spc_a', type: 'building' }, {
    environment,
    now: new Date('2026-09-01T00:00:00.100Z'),
  });
  await writeHotScope(dataDir, { scopeId: 'spc_b', type: 'floor' }, {
    environment,
    now: new Date('2026-09-01T00:00:00.200Z'),
  });
  await writeHotScope(dataDir, { scopeId: 'spc_c', type: 'space' }, {
    environment,
    now: new Date('2026-09-01T00:00:00.300Z'),
  });
  assert.deepEqual(await readHotScopes(dataDir, {
    environment,
    now: new Date('2026-09-01T00:00:00.400Z'),
  }), [
    { scopeId: 'spc_c', type: 'space', lastAskedAt: '2026-09-01T00:00:00.300Z', count: 1 },
    { scopeId: 'spc_b', type: 'floor', lastAskedAt: '2026-09-01T00:00:00.200Z', count: 1 },
  ]);
  assert.deepEqual(await readHotScopes(dataDir, {
    environment,
    now: new Date('2026-09-01T00:00:01.301Z'),
  }), []);
});

test('the manager starts stale scopes serially, gates intraday, and releases its timer', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-hot-manager-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let current = new Date('2026-09-01T12:00:00.000Z');
  const calls = [];
  let intervalCallback;
  let unrefCalled = false;
  let stopped;
  const manager = createHotScopeManager({
    dataDir,
    environment: {
      DENSITY_HOT_REFRESH_INTERVAL_MS: '25',
    },
    intradayEnabled: () => true,
    now: () => current,
    freshness: async () => ({ streams: [{ name: 'metrics', stale: true, observedAt: '2026-08-29T00:00:00.000Z' }] }),
    refreshScope: async (args) => {
      calls.push(args);
      return { state: 'running' };
    },
    startInterval: (callback, milliseconds) => {
      assert.equal(milliseconds, 25);
      intervalCallback = callback;
      return { unref: () => { unrefCalled = true; } };
    },
    stopInterval: (timer) => { stopped = timer; },
  });
  await manager.record({ scopeId: 'spc_roxanne', type: 'building' });
  current = new Date('2026-08-31T12:00:00.000Z');
  await manager.record({ scopeId: 'spc_old_today', type: 'floor' });
  current = new Date('2026-09-01T12:00:00.000Z');
  await manager.start();

  assert.equal(unrefCalled, true);
  assert.deepEqual(calls.map(({ scope, intraday }) => ({ scope, intraday })), [
    { scope: 'spc_roxanne', intraday: true },
    { scope: 'spc_old_today', intraday: undefined },
  ]);
  assert.equal(calls.every(({ scopeType, streams, wait }) => (
    ['building', 'floor'].includes(scopeType)
      && streams.length === 1 && streams[0] === 'metrics' && wait === false
  )), true);
  intervalCallback();
  await manager.run();
  assert.equal(calls.length >= 4, true);
  manager.stop();
  assert.ok(stopped);
});

test('fresh and disabled managers do not start refresh work', async (t) => {
  const roots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), 'density-hot-fresh-')),
    mkdtemp(path.join(os.tmpdir(), 'density-hot-disabled-')),
  ]);
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  let calls = 0;
  const fresh = createHotScopeManager({
    dataDir: roots[0],
    environment: {},
    freshness: async () => ({ streams: [{ name: 'metrics', stale: false, observedAt: '2026-09-01T00:00:00.000Z' }] }),
    refreshScope: async () => { calls += 1; },
  });
  await fresh.record({ scopeId: 'spc_fresh', type: 'building' });
  await fresh.run();
  assert.deepEqual(fresh.status().scopes, [{
    scopeId: 'spc_fresh',
    state: 'fresh',
    coveredThrough: '2026-09-01T00:00:00.000Z',
  }]);

  const disabled = createHotScopeManager({
    dataDir: roots[1],
    environment: { DENSITY_DISABLE_BACKGROUND_REFRESH: '1' },
    freshness: async () => ({ streams: [{ name: 'metrics', stale: true }] }),
    refreshScope: async () => { calls += 1; },
  });
  assert.equal(await disabled.record({ scopeId: 'spc_disabled', type: 'building' }), false);
  await disabled.start();
  assert.equal(calls, 0);
  assert.equal(disabled.status().lastRunAt, null);
  await assert.rejects(readFile(path.join(roots[1], 'hot-scopes.json')), { code: 'ENOENT' });
});

test('the manager checks freshness for each exact hot scope', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-hot-exact-freshness-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const refreshed = [];
  const manager = createHotScopeManager({
    dataDir,
    environment: {},
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    freshness: async ({ scopeId }) => ({
      streams: [{
        name: 'metrics',
        observedAt: scopeId === 'spc_fresh' ? '2026-09-01T11:00:00.000Z' : '2026-08-28T00:00:00.000Z',
        stale: scopeId !== 'spc_fresh',
      }],
    }),
    refreshScope: async ({ scope }) => {
      refreshed.push(scope);
      return { state: 'running' };
    },
  });
  await manager.record({ scopeId: 'spc_fresh', type: 'building' });
  await manager.record({ scopeId: 'spc_stale', type: 'building' });
  await manager.run();
  assert.deepEqual(refreshed, ['spc_stale']);
  assert.deepEqual(manager.status().scopes.map(({ scopeId, state }) => ({ scopeId, state })), [
    { scopeId: 'spc_fresh', state: 'fresh' },
    { scopeId: 'spc_stale', state: 'running' },
  ]);
});
