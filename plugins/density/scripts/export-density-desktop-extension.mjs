#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPluginRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const desktopRuntimeFiles = [
  '.codex-plugin/plugin.json',
  'assets/density-icon.png',
  'guidance/density-system-prompt.md',
  'mcp-server/agent-response-envelope.mjs',
  'mcp-server/artifact-content.mjs',
  'mcp-server/hot-scopes.mjs',
  'mcp-server/query-response-envelope.mjs',
  'mcp-server/server.mjs',
  'mcp-server/state-file.mjs',
  'scripts/density-background-deep-sync.mjs',
  'scripts/density-core.mjs',
  'scripts/density-demo-customer.mjs',
  'scripts/density-lib.mjs',
  'skills/density/SKILL.md',
];

export const densityDesktopToolNames = [
  'setup',
  'install_managed_cli',
  'auth_login',
  'onboard_customer',
  'onboarding_status',
  'prepare_floorplans',
  'status',
  'historical_export',
  'create_demo_customer',
  'query_db',
  'render_chart',
  'refresh_scope',
  'refresh_status',
  'configure_brand',
  'floor_usage_report',
  'local_data_profile',
  'available_buildings',
  'data_health_report',
  'live_wayfinding_status',
  'benchmark_compare',
  'sensor_health_report',
  'storage_report',
];

const requiredRuntimePaths = [
  'bin/density.mjs',
  'dist/cli.js',
  'dist-ui/index.html',
  'node_modules',
  'package.json',
  'runtime/node',
];

const usage = `Usage: node plugins/density/scripts/export-density-desktop-extension.mjs --runtime-root <path> --out <extension-root>

Exports a relocatable Claude Desktop MCPB directory from the canonical Density plugin source.
The runtime root must be an unpacked bundle from scripts/package-runtime.mjs.
`;

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === '--runtime-root') options.runtimeRoot = value;
    else if (arg === '--out') options.outputRoot = value;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  if (!options.runtimeRoot) throw new Error('--runtime-root is required');
  if (!options.outputRoot) throw new Error('--out is required');
  return options;
};

const nearestPhysicalPath = async (target) => {
  let existing = target;
  while (true) {
    try {
      const physical = await realpath(existing);
      return path.join(physical, path.relative(existing, target));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
};

const assertDirectoryIsEmpty = async (destinationRoot) => {
  try {
    if ((await readdir(destinationRoot)).length > 0) {
      throw new Error('Export destination must be empty to avoid overwriting existing files.');
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const assertRuntimeBundle = async (runtimeRoot) => {
  for (const relativePath of requiredRuntimePaths) {
    try {
      await stat(path.join(runtimeRoot, relativePath));
    } catch {
      throw new Error(`Density runtime bundle is missing ${relativePath}.`);
    }
  }
};

const desktopManifest = (pluginManifest) => ({
  $schema: 'https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json',
  manifest_version: '0.4',
  name: pluginManifest.name,
  display_name: 'Density',
  version: pluginManifest.version,
  description: 'Local-first Density workplace analytics and governed charts.',
  long_description: pluginManifest.description,
  author: {
    name: pluginManifest.author?.name ?? 'Density',
    url: pluginManifest.website ?? pluginManifest.homepage ?? 'https://density.io/',
  },
  repository: {
    type: 'git',
    url: 'https://github.com/DensityCo/density-mcp',
  },
  homepage: pluginManifest.homepage ?? pluginManifest.website ?? 'https://density.io/',
  icon: 'assets/density-icon.png',
  server: {
    type: 'node',
    entry_point: 'mcp-server/server.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/mcp-server/server.mjs'],
      env: {
        DENSITY_PLUGIN_HOST: 'claude-desktop',
        DENSITY_CLI_NODE: '${__dirname}/runtime/runtime/node',
        DENSITY_CLI_BIN: '${__dirname}/runtime/bin/density.mjs',
        DENSITY_CLI_DATA_DIR: '${user_config.data_dir}',
      },
    },
  },
  tools: densityDesktopToolNames.map((name) => ({ name })),
  tools_generated: false,
  prompts_generated: true,
  keywords: pluginManifest.keywords,
  license: pluginManifest.license,
  compatibility: {
    claude_desktop: '>=1.0.0',
    platforms: ['darwin'],
    runtimes: { node: '>=20' },
  },
  user_config: {
    data_dir: {
      type: 'directory',
      title: 'Density data folder',
      description: 'Select the folder that contains Density state and Parquet data.',
      required: true,
      default: '${HOME}/.density-cli',
    },
  },
});

export const exportDensityDesktopExtension = async ({
  outputRoot,
  runtimeRoot,
  pluginRoot = defaultPluginRoot,
}) => {
  const destinationRoot = path.resolve(outputRoot);
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  await assertRuntimeBundle(resolvedRuntimeRoot);
  const [physicalPluginRoot, physicalDestinationRoot] = await Promise.all([
    realpath(pluginRoot),
    nearestPhysicalPath(destinationRoot),
  ]);
  const relativeDestination = path.relative(physicalPluginRoot, physicalDestinationRoot);
  if (relativeDestination === '' || (!relativeDestination.startsWith('..') && !path.isAbsolute(relativeDestination))) {
    throw new Error('Export destination must be outside the Density plugin source tree.');
  }
  const destinationExists = await assertDirectoryIsEmpty(destinationRoot);
  await mkdir(path.dirname(destinationRoot), { recursive: true });
  const stagingRoot = await mkdtemp(path.join(path.dirname(destinationRoot), '.density-desktop-export-'));

  try {
    for (const relativeFile of desktopRuntimeFiles) {
      const destination = path.join(stagingRoot, relativeFile);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(pluginRoot, relativeFile), destination, { force: true });
    }
    await cp(path.join(pluginRoot, 'guidance', 'design.md'), path.join(stagingRoot, 'assets', 'design.md'), { force: true });
    await cp(resolvedRuntimeRoot, path.join(stagingRoot, 'runtime'), { recursive: true, force: true });
    const pluginManifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    const manifest = desktopManifest(pluginManifest);
    await writeFile(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (destinationExists) await rmdir(destinationRoot);
    await rename(stagingRoot, destinationRoot);
    return {
      outputRoot: destinationRoot,
      version: manifest.version,
      toolCount: densityDesktopToolNames.length,
      runtimeFileCount: desktopRuntimeFiles.length,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  const result = await exportDensityDesktopExtension(options);
  console.log(`Exported Density ${result.version} for Claude Desktop to ${result.outputRoot}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
