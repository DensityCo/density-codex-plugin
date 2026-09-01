import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { status } from '../scripts/density-core.mjs';

test('status reads sync bookkeeping from sync-state.json and keeps newer entries from state.json', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-status-sync-state-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    organizationId: 'org_1',
    organizationName: 'One',
    streams: {
      'org:org_1:metrics:all-spaces:1h': { rowsSynced: 50, fullSyncCompleted: true, lastSyncAt: '2026-06-02T00:00:00.000Z', updatedSince: '2026-06-01T12:00:00.000Z' },
    },
  }));
  await writeFile(path.join(dataDir, 'sync-state.json'), JSON.stringify({
    version: 1,
    streams: {
      'org:org_1:spaces': { rowsSynced: 2, fullSyncCompleted: true, lastSyncAt: '2026-06-01T00:00:00.000Z', updatedSince: '2026-06-01T00:00:00.000Z' },
      'org:org_1:metrics:all-spaces:1h': { rowsSynced: 40, fullSyncCompleted: true, lastSyncAt: '2026-05-02T00:00:00.000Z', updatedSince: '2026-05-01T12:00:00.000Z' },
      'org:org_1:metrics:spc_1:1h': { rowsSynced: 4, fullSyncCompleted: true, lastSyncAt: '2026-05-03T00:00:00.000Z', updatedSince: '2026-05-02T00:00:00.000Z' },
    },
  }));

  const report = await status({ dataDir });

  assert.equal(report.ok, true);
  assert.equal(report.sync.latestSyncAt, '2026-06-02T00:00:00.000Z');
  assert.deepEqual(report.sync.streams, [
    { name: 'metrics', stateEntries: 2, scopes: ['all_spaces', 'selected_spaces'], latestSyncAt: '2026-06-02T00:00:00.000Z', coverageThrough: '2026-06-01T12:00:00.000Z' },
    { name: 'spaces', stateEntries: 1, scopes: ['organization'], latestSyncAt: '2026-06-01T00:00:00.000Z', coverageThrough: '2026-06-01T00:00:00.000Z' },
  ]);
});

test('status reports no streams when neither file has sync bookkeeping', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-status-no-streams-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ organizationId: 'org_1' }));

  const report = await status({ dataDir });

  assert.deepEqual(report.sync.streams, []);
  assert.equal(report.sync.latestSyncAt, undefined);
});
