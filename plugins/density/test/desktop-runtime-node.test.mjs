import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('uses the bundled Node runtime for a Desktop JavaScript CLI', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'density-desktop-node-'));
  const cliBin = path.join(tempRoot, 'density.mjs');
  try {
    await writeFile(cliBin, '#!/usr/bin/env node\n');
    const code = `
      const { resolveDensityCli } = await import(${JSON.stringify(path.join(pluginRoot, 'scripts', 'density-lib.mjs'))});
      console.log(JSON.stringify(await resolveDensityCli()));
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
      env: {
        ...process.env,
        DENSITY_CLI_BIN: cliBin,
        DENSITY_CLI_NODE: '/bundle/runtime/node',
      },
    });
    const resolved = JSON.parse(stdout);
    assert.equal(resolved.command, '/bundle/runtime/node');
    assert.deepEqual(resolved.args, [cliBin]);
    assert.equal(resolved.source, 'DENSITY_CLI_BIN');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
