#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const defaultPluginRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultReleaseRepo = 'DensityCo/density-codex-plugin';

const usage = `Usage: node plugins/density/scripts/update-managed-cli-runtime.mjs --runtime-manifest <path-or-url> [options]

Updates plugins/density/.codex-plugin/plugin.json to pin a published Density CLI runtime.
When the runtime pin changes, also advances the plugin patch version so installed caches can detect it.

Options:
  --runtime-manifest <path-or-url>  Runtime manifest JSON produced by density-cli package:runtime:archive.
  --plugin-root <dir>               Density plugin root. Defaults to plugins/density.
  --release-repo <owner/repo>       Runtime release repo. Defaults to DensityCo/density-codex-plugin.
  --allow-prerelease                Allow SemVer prerelease runtime versions.
  --help                            Show this help.
`;

export const parseArgs = (argv) => {
  const options = {
    allowPrerelease: false,
    pluginRoot: defaultPluginRoot,
    releaseRepo: defaultReleaseRepo,
    runtimeManifest: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { ...options, help: true };
    }
    if (arg === '--allow-prerelease') {
      options.allowPrerelease = true;
      continue;
    }
    if (arg === '--runtime-manifest') {
      const value = argv[index + 1];
      if (!value) throw new Error('--runtime-manifest requires a path or URL');
      options.runtimeManifest = value;
      index += 1;
      continue;
    }
    if (arg === '--plugin-root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--plugin-root requires a directory');
      options.pluginRoot = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--release-repo') {
      const value = argv[index + 1];
      if (!value) throw new Error('--release-repo requires owner/repo');
      options.releaseRepo = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.runtimeManifest) {
    throw new Error('--runtime-manifest is required');
  }
  return options;
};

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

const readManifest = async (source) => {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to download runtime manifest ${source}: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  }
  return await readJson(path.resolve(source));
};

const assertString = (object, key) => {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Runtime manifest is missing ${key}`);
  }
  return value;
};

export const normalizeRuntimeManifest = (manifest, options = {}) => {
  const cliVersion = assertString(manifest, 'cliVersion');
  const platform = assertString(manifest, 'platform');
  const arch = assertString(manifest, 'arch');
  const assetName = assertString(manifest, 'assetName');
  const sha256 = assertString(manifest, 'sha256').toLowerCase();

  const parsedVersion = semver.parse(cliVersion, { loose: false });
  if (!parsedVersion || parsedVersion.raw !== cliVersion) {
    throw new Error(`Runtime manifest cliVersion '${cliVersion}' is not strict SemVer.`);
  }
  if (parsedVersion.build.length > 0) {
    throw new Error(`Runtime manifest cliVersion '${cliVersion}' uses build metadata, which is not supported for pinned runtime assets.`);
  }
  if (parsedVersion.prerelease.length > 0 && !options.allowPrerelease) {
    throw new Error(`Runtime manifest cliVersion '${cliVersion}' is a prerelease. Pass --allow-prerelease only for explicit test branches.`);
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Runtime manifest sha256 '${manifest.sha256}' is not a lowercase SHA-256 hex digest.`);
  }

  const platformKey = `${platform}-${arch}`;
  const runtimeName = assetName.startsWith('density-mcp-') ? 'density-mcp' : 'density-cli';
  const expectedAssetName = `${runtimeName}-v${cliVersion}-${platformKey}.tar.gz`;
  if (assetName !== expectedAssetName) {
    throw new Error(`Runtime manifest assetName '${assetName}' does not match expected asset '${expectedAssetName}'.`);
  }

  return {
    assetName,
    cliVersion,
    platformKey,
    prerelease: parsedVersion.prerelease.length > 0,
    runtimeName,
    sha256,
  };
};

export const runtimeAssetUrl = (runtime, releaseRepo = defaultReleaseRepo) =>
  `https://github.com/${releaseRepo}/releases/download/${runtime.runtimeName}-runtime-v${runtime.cliVersion}/${runtime.assetName}`;

export const updateManagedCliRuntime = async (options) => {
  const manifest = await readManifest(options.runtimeManifest);
  const runtime = normalizeRuntimeManifest(manifest, { allowPrerelease: options.allowPrerelease });
  const pluginRoot = path.resolve(options.pluginRoot ?? defaultPluginRoot);
  const pluginManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const pluginManifest = await readJson(pluginManifestPath);

  const nextAsset = {
    url: runtimeAssetUrl(runtime, options.releaseRepo ?? defaultReleaseRepo),
    sha256: runtime.sha256,
  };
  const currentAsset = pluginManifest.managedCli?.assets?.[runtime.platformKey];
  const runtimeChanged = pluginManifest.managedCli?.version !== runtime.cliVersion
    || currentAsset?.url !== nextAsset.url
    || currentAsset?.sha256 !== nextAsset.sha256;

  if (runtimeChanged) {
    const currentPluginVersion = pluginManifest.version;
    const parsedPluginVersion = semver.parse(currentPluginVersion, { loose: false });
    if (!parsedPluginVersion || parsedPluginVersion.raw !== currentPluginVersion || parsedPluginVersion.build.length > 0) {
      throw new Error(`Plugin manifest version '${currentPluginVersion}' is not strict SemVer without build metadata.`);
    }
    pluginManifest.version = semver.inc(currentPluginVersion, 'patch');
  }

  pluginManifest.managedCli ??= {};
  pluginManifest.managedCli.enabled = true;
  pluginManifest.managedCli.version = runtime.cliVersion;
  pluginManifest.managedCli.assets ??= {};
  pluginManifest.managedCli.assets[runtime.platformKey] = nextAsset;

  await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);
  return {
    manifestPath: pluginManifestPath,
    pluginVersion: pluginManifest.version,
    pluginVersionChanged: runtimeChanged,
    runtime,
    url: pluginManifest.managedCli.assets[runtime.platformKey].url,
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  const result = await updateManagedCliRuntime(options);
  console.log(`Updated ${path.relative(process.cwd(), result.manifestPath)} to Density CLI ${result.runtime.cliVersion}`);
  console.log(`${result.pluginVersionChanged ? 'Bumped' : 'Kept'} Density plugin version ${result.pluginVersion}`);
  console.log(`Pinned ${result.runtime.platformKey}: ${result.url}`);
  console.log(`sha256 ${result.runtime.sha256}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
