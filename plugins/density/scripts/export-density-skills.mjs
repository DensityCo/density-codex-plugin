#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPluginRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const supportedHosts = new Set(['claude', 'codex']);

const usage = `Usage: node plugins/density/scripts/export-density-skills.mjs --host <claude|codex> --out <bundle-root>

Exports a self-contained Density skill bundle with skills, assets, MCP configuration, and its runtime closure.
Claude exports omit Codex-only agents/openai.yaml metadata.
`;

const runtimeFiles = [
  '.mcp.json',
  '.codex-plugin/plugin.json',
  'assets/density-icon.png',
  'mcp-server/server.mjs',
  'scripts/density-ask-chart.mjs',
  'scripts/density-background-deep-sync.mjs',
  'scripts/density-core.mjs',
  'scripts/density-demo-customer.mjs',
  'scripts/density-lib.mjs',
  'scripts/density-onboard-customer.mjs',
  'scripts/density-setup.mjs',
];

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--host') {
      options.host = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--out') {
      options.outputRoot = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!supportedHosts.has(options.host)) throw new Error('--host must be claude or codex');
  if (!options.outputRoot) throw new Error('--out is required');
  return options;
};

const isDirectory = async (file) => (await stat(file)).isDirectory();

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

export const exportDensitySkills = async ({ host, outputRoot, pluginRoot = defaultPluginRoot }) => {
  if (!supportedHosts.has(host)) throw new Error(`Unsupported skill host: ${host}`);

  const sourceSkills = path.join(pluginRoot, 'skills');
  const destinationRoot = path.resolve(outputRoot);
  const [physicalPluginRoot, physicalDestinationRoot] = await Promise.all([
    realpath(pluginRoot),
    nearestPhysicalPath(destinationRoot),
  ]);
  const relativeDestination = path.relative(physicalPluginRoot, physicalDestinationRoot);
  if (relativeDestination === '' || (!relativeDestination.startsWith('..') && !path.isAbsolute(relativeDestination))) {
    throw new Error('Export destination must be outside the Density plugin source tree.');
  }
  let destinationExists = true;
  try {
    if ((await readdir(destinationRoot)).length > 0) {
      throw new Error('Export destination must be empty to avoid overwriting existing files.');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      destinationExists = false;
    } else {
      throw error;
    }
  }
  await mkdir(path.dirname(destinationRoot), { recursive: true });
  const stagingRoot = await mkdtemp(path.join(path.dirname(destinationRoot), '.density-export-'));
  const skillNames = [];

  for (const entry of await readdir(sourceSkills, { withFileTypes: true })) {
    if (entry.isDirectory()) skillNames.push(entry.name);
  }
  skillNames.sort();

  try {
    await mkdir(path.join(stagingRoot, 'skills'), { recursive: true });
    for (const skillName of skillNames) {
      const source = path.join(sourceSkills, skillName);
      const destination = path.join(stagingRoot, 'skills', skillName);
      if (!await isDirectory(source)) continue;
      await cp(source, destination, {
        recursive: true,
        force: true,
        filter: (candidate) => {
          if (host !== 'claude') return true;
          return !path.relative(source, candidate).split(path.sep).includes('agents');
        },
      });
    }

    await mkdir(path.join(stagingRoot, 'assets'), { recursive: true });
    await cp(path.join(pluginRoot, 'assets', 'design.md'), path.join(stagingRoot, 'assets', 'design.md'), { force: true });

    for (const relativeFile of runtimeFiles) {
      const destination = path.join(stagingRoot, relativeFile);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(pluginRoot, relativeFile), destination, { force: true });
    }
    const mcpServer = host === 'claude'
      ? {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/mcp-server/server.mjs'],
        }
      : {
          command: 'node',
          args: ['./mcp-server/server.mjs'],
          cwd: '.',
        };
    await writeFile(path.join(stagingRoot, '.mcp.json'), `${JSON.stringify({
      mcpServers: {
        density: mcpServer,
      },
    }, null, 2)}\n`, 'utf8');
    if (destinationExists) await rmdir(destinationRoot);
    await rename(stagingRoot, destinationRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return { host, outputRoot: destinationRoot, skillCount: skillNames.length, runtimeFileCount: runtimeFiles.length };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  const result = await exportDensitySkills(options);
  console.log(`Exported ${result.skillCount} Density skills for ${result.host} to ${result.outputRoot}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
