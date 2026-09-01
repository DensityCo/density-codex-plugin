import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = `${process.platform}-${os.arch()}`;

const manifest = (assetPath) => JSON.stringify({
  version: '9.9.9',
  assets: { [platform]: { file: assetPath, sha256: '0'.repeat(64) } },
});

// Each case runs in a child process so env and the once-per-process install memo start clean.
const resolveInChild = async (env) => {
  const code = `
    const { resolveDensityCli } = await import(${JSON.stringify(path.join(pluginRoot, 'scripts', 'density-lib.mjs'))});
    const { requireCli } = await import(${JSON.stringify(path.join(pluginRoot, 'scripts', 'density-core.mjs'))});
    const resolved = await resolveDensityCli();
    let failure;
    try {
      await requireCli();
    } catch (error) {
      failure = { message: error.message, nextAction: error.nextAction };
    }
    console.log(JSON.stringify({ resolved, failure }));
  `;
  const childEnv = { ...process.env, ...env };
  for (const key of ['DENSITY_CLI_COMMAND', 'DENSITY_CLI_BIN', 'DENSITY_CLI_REPO']) {
    if (!(key in env)) delete childEnv[key];
  }
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', code], { env: childEnv });
  return JSON.parse(stdout);
};

const withFixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'density-managed-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const pathDensity = path.join(binDir, 'density');
  await writeFile(pathDensity, '#!/bin/sh\necho fake density\n');
  await chmod(pathDensity, 0o755);
  const runtimeRoot = path.join(root, 'plugin-runtime');
  await mkdir(runtimeRoot, { recursive: true });
  return {
    root,
    pathDensity,
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      DENSITY_PLUGIN_RUNTIME_DIR: runtimeRoot,
      DENSITY_MANAGED_CLI_MANIFEST: manifest(path.join(root, 'missing-runtime.tgz')),
    },
  };
};

test('resolveDensityCli marks the PATH fallback when the pinned runtime is missing and autoinstall is off', async (t) => {
  const { pathDensity, env } = await withFixture(t);

  const { resolved, failure } = await resolveInChild({ ...env, DENSITY_MANAGED_CLI_AUTOINSTALL: '0' });

  assert.equal(resolved.source, 'PATH');
  assert.equal(resolved.path, pathDensity);
  assert.equal(resolved.managedMissing.version, '9.9.9');
  assert.match(resolved.managedMissing.reason, /DENSITY_MANAGED_CLI_AUTOINSTALL=0/);
  assert.match(failure.message, /Density CLI 9\.9\.9/);
  assert.match(failure.message, /install_managed_cli/);
  assert.equal(failure.nextAction.id, 'install_managed_cli');
  assert.equal(failure.nextAction.tool, 'install_managed_cli');
});

test('resolveDensityCli records the install failure when the automatic install cannot fetch the asset', async (t) => {
  const { env } = await withFixture(t);

  const { resolved, failure } = await resolveInChild(env);

  assert.equal(resolved.source, 'PATH');
  assert.equal(resolved.managedMissing.version, '9.9.9');
  assert.match(resolved.managedMissing.reason, /missing-runtime\.tgz|ENOENT/);
  assert.equal(failure.nextAction.id, 'install_managed_cli');
});

test('resolveDensityCli keeps explicit overrides unchanged when the pinned runtime is missing', async (t) => {
  const { root, env } = await withFixture(t);
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'bin'), { recursive: true });
  await writeFile(path.join(repo, 'bin', 'density.mjs'), '#!/usr/bin/env node\n');
  const explicitBin = path.join(root, 'explicit-density.mjs');
  await writeFile(explicitBin, '#!/usr/bin/env node\n');

  const viaRepo = await resolveInChild({ ...env, DENSITY_CLI_REPO: repo });
  assert.equal(viaRepo.resolved.source, repo);
  assert.equal(viaRepo.resolved.managedMissing, undefined);
  assert.equal(viaRepo.failure, undefined);

  const viaBin = await resolveInChild({ ...env, DENSITY_CLI_BIN: explicitBin });
  assert.equal(viaBin.resolved.source, 'DENSITY_CLI_BIN');
  assert.equal(viaBin.resolved.managedMissing, undefined);
  assert.equal(viaBin.failure, undefined);
});
