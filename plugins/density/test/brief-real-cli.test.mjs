import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '..', '..', '..');
const cliPath = path.join(repositoryRoot, 'bin', 'density.mjs');
const storeUrl = pathToFileURL(path.join(repositoryRoot, 'dist', 'duckdb-store.js')).href;

const runNode = (args, env) => execFileAsync(process.execPath, args, {
  env,
  maxBuffer: 10 * 1024 * 1024,
});

test('the built CLI renders a Parquet query as a Brief slide', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-brief-real-cli-'));
  const env = {
    ...process.env,
    DENSITY_CLI_DATA_DIR: dataDir,
    DENSITY_INTERNAL_BRIEF_SLIDE: '0',
  };
  try {
    await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 2,
      baseUrl: 'https://api.density.io',
      identityBaseUrl: 'https://identity.density.io',
      organizationId: 'org_fixture',
      organizationName: 'Example Company',
      streams: {},
    }));
    const fixtureScript = `
      import { DuckDbStore } from ${JSON.stringify(storeUrl)};
      await new DuckDbStore().upsert('org_fixture', 'spaces', [
        { id: 'room_a', name: 'Room A', space_type: 'space', function: 'meeting_room', capacity: 12 },
        { id: 'room_b', name: 'Room B', space_type: 'space', function: 'meeting_room', capacity: 8 },
        { id: 'room_c', name: 'Room C', space_type: 'space', function: 'meeting_room', capacity: 4 }
      ]);
    `;
    await runNode(['--input-type=module', '--eval', fixtureScript], env);

    const queryRun = await runNode([
      cliPath,
      'query-db',
      '--sql',
      'SELECT name, capacity FROM density_atlas_spaces_flat ORDER BY capacity DESC',
      '--format',
      'json',
    ], env);
    const query = JSON.parse(queryRun.stdout);
    assert.equal(query.rowCount, 3);
    assert.match(query.evidence.id, /^qe_[a-f0-9]{64}$/u);

    const declaration = JSON.stringify({
      body: 'bars',
      columns: [
        { field: 'name', role: 'entity', label: 'Meeting room' },
        { field: 'capacity', role: 'measure', label: 'Capacity', unit: 'people' },
      ],
      title: 'Meeting-room capacity',
    });
    const renderRun = await runNode([
      cliPath,
      'render-chart',
      '--evidence',
      query.evidence.id,
      '--chart',
      declaration,
      '--format',
      'json',
    ], env);
    const rendered = JSON.parse(renderRun.stdout);
    assert.equal(rendered.chart.state, 'rendered');
    const html = await readFile(rendered.chart.artifacts.html, 'utf8');
    assert.match(html, /data-slide-design='brief'/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
