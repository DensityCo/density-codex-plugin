import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readStateFile } from '../mcp-server/state-file.mjs';

const makeDataDir = async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-state-file-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
};

test('readStateFile returns the cached object when mtime and size are unchanged', async (t) => {
  const dataDir = await makeDataDir(t);
  const filePath = path.join(dataDir, 'state.json');
  await writeFile(filePath, JSON.stringify({ demoMode: true, tag: 'AAAA' }));
  const first = await readStateFile(dataDir);
  assert.deepEqual(first, { demoMode: true, tag: 'AAAA' });

  // The file on disk is untouched, so its mtime and size are unchanged.
  // JSON.parse always builds a fresh object, so reference equality here
  // proves the second call returned the cached object instead of re-parsing.
  const second = await readStateFile(dataDir);
  assert.equal(second, first, 'expected the cached object, not a fresh parse');
});

test('readStateFile re-reads after the mtime changes', async (t) => {
  const dataDir = await makeDataDir(t);
  const filePath = path.join(dataDir, 'state.json');
  await writeFile(filePath, JSON.stringify({ demoMode: true, tag: 'AAAA' }));
  const first = await readStateFile(dataDir);

  const stats = await stat(filePath);
  const future = new Date(stats.mtime.getTime() + 5000);
  await writeFile(filePath, JSON.stringify({ demoMode: true, tag: 'BBBB' }));
  await utimes(filePath, future, future);

  const second = await readStateFile(dataDir);
  assert.notEqual(second, first);
  assert.deepEqual(second, { demoMode: true, tag: 'BBBB' });
});

test('readStateFile returns undefined when state.json is missing', async (t) => {
  const dataDir = await makeDataDir(t);
  assert.equal(await readStateFile(dataDir), undefined);
});

test('readStateFile throws on invalid JSON', async (t) => {
  const dataDir = await makeDataDir(t);
  await writeFile(path.join(dataDir, 'state.json'), '{not valid json');
  await assert.rejects(() => readStateFile(dataDir));
});
