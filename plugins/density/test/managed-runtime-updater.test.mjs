import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  normalizeRuntimeManifest,
  runtimeAssetUrl,
  updateManagedCliRuntime,
} from '../scripts/update-managed-cli-runtime.mjs';

const stableManifest = {
  cliVersion: '0.1.2',
  platform: 'darwin',
  arch: 'arm64',
  assetName: 'density-cli-v0.1.2-darwin-arm64.tar.gz',
  sha256: 'a'.repeat(64),
};

const makePluginRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'density-plugin-runtime-'));
  const manifestDir = path.join(root, '.codex-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(path.join(manifestDir, 'plugin.json'), `${JSON.stringify({
    name: 'density',
    version: '0.1.8',
    managedCli: {
      enabled: true,
      version: '0.1.0',
      assets: {
        'darwin-arm64': {
          url: 'https://example.invalid/old.tgz',
          sha256: '0'.repeat(64),
        },
      },
    },
  }, null, 2)}\n`);
  return root;
};

test('normalizeRuntimeManifest accepts stable SemVer runtime manifests', () => {
  const runtime = normalizeRuntimeManifest(stableManifest);
  assert.deepEqual(runtime, {
    assetName: 'density-cli-v0.1.2-darwin-arm64.tar.gz',
    cliVersion: '0.1.2',
    platformKey: 'darwin-arm64',
    prerelease: false,
    sha256: 'a'.repeat(64),
  });
  assert.equal(
    runtimeAssetUrl(runtime),
    'https://github.com/DensityCo/density-codex-plugin/releases/download/density-cli-runtime-v0.1.2/density-cli-v0.1.2-darwin-arm64.tar.gz'
  );
});

test('normalizeRuntimeManifest rejects prereleases unless explicitly allowed', () => {
  const manifest = {
    ...stableManifest,
    cliVersion: '0.1.2-beta.1',
    assetName: 'density-cli-v0.1.2-beta.1-darwin-arm64.tar.gz',
  };

  assert.throws(() => normalizeRuntimeManifest(manifest), /is a prerelease/);
  assert.equal(normalizeRuntimeManifest(manifest, { allowPrerelease: true }).prerelease, true);
});

test('normalizeRuntimeManifest rejects mismatched asset names', () => {
  assert.throws(
    () => normalizeRuntimeManifest({ ...stableManifest, assetName: 'density-cli-v0.1.3-darwin-arm64.tar.gz' }),
    /does not match expected asset/
  );
});

test('updateManagedCliRuntime pins the plugin manifest to the runtime artifact', async () => {
  const pluginRoot = await makePluginRoot();
  const manifestPath = path.join(pluginRoot, 'runtime.json');
  await writeFile(manifestPath, `${JSON.stringify(stableManifest, null, 2)}\n`);

  await updateManagedCliRuntime({ pluginRoot, runtimeManifest: manifestPath });

  const pluginManifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pluginManifest.managedCli.version, '0.1.2');
  assert.deepEqual(pluginManifest.managedCli.assets['darwin-arm64'], {
    url: 'https://github.com/DensityCo/density-codex-plugin/releases/download/density-cli-runtime-v0.1.2/density-cli-v0.1.2-darwin-arm64.tar.gz',
    sha256: 'a'.repeat(64),
  });
});
