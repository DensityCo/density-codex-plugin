#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPluginRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const supportedHosts = new Set(['claude', 'codex']);

const usage = `Usage: node plugins/density/scripts/export-density-skills.mjs --host <claude|codex> --out <bundle-root> [options]

Exports a self-contained Density skill bundle with skills, assets, MCP configuration, and its runtime closure.
Claude exports omit Codex-only agents/openai.yaml metadata.

Claude options:
  --cli-bin <path>   Persist the Density CLI path in the generated MCP configuration.
  --data-dir <path>  Persist the Density data path in the generated MCP configuration.
`;

const runtimeFiles = [
  '.mcp.json',
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
    if (arg === '--cli-bin') {
      options.cliBin = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--data-dir') {
      options.dataDir = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!supportedHosts.has(options.host)) throw new Error('--host must be claude or codex');
  if (!options.outputRoot) throw new Error('--out is required');
  if (options.host !== 'claude' && (options.cliBin || options.dataDir)) {
    throw new Error('--cli-bin and --data-dir are Claude-only options');
  }
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

const claudeManifest = (manifest) => ({
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  author: manifest.author,
  homepage: manifest.homepage ?? manifest.website,
  license: manifest.license,
  keywords: manifest.keywords,
});

const definedEntries = (value) => Object.fromEntries(
  Object.entries(value).filter(([, entry]) => typeof entry === 'string' && entry.length > 0),
);

export const exportDensitySkills = async ({
  host,
  outputRoot,
  pluginRoot = defaultPluginRoot,
  claudeEnv = {},
}) => {
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
      const skillFile = path.join(destination, 'SKILL.md');
      const skill = await readFile(skillFile, 'utf8');
      await writeFile(skillFile, skill.replaceAll('../../guidance/design.md', '../../assets/design.md'), 'utf8');
    }

    await mkdir(path.join(stagingRoot, 'assets'), { recursive: true });
    await cp(path.join(pluginRoot, 'guidance', 'design.md'), path.join(stagingRoot, 'assets', 'design.md'), { force: true });

    for (const relativeFile of runtimeFiles) {
      const destination = path.join(stagingRoot, relativeFile);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(pluginRoot, relativeFile), destination, { force: true });
    }
    const mcpServer = host === 'claude'
      ? {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/mcp-server/server.mjs'],
          env: {
            DENSITY_PLUGIN_HOST: 'claude',
            ...definedEntries(claudeEnv),
          },
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
    if (host === 'claude') {
      const codexManifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
      await mkdir(path.join(stagingRoot, '.claude-plugin'), { recursive: true });
      await writeFile(
        path.join(stagingRoot, '.claude-plugin', 'plugin.json'),
        `${JSON.stringify(claudeManifest(codexManifest), null, 2)}\n`,
        'utf8',
      );
    }
    if (destinationExists) await rmdir(destinationRoot);
    await rename(stagingRoot, destinationRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    host,
    outputRoot: destinationRoot,
    skillCount: skillNames.length,
    runtimeFileCount: runtimeFiles.length + (host === 'claude' ? 1 : 0),
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  const result = await exportDensitySkills({
    host: options.host,
    outputRoot: options.outputRoot,
    claudeEnv: {
      DENSITY_CLI_BIN: options.cliBin,
      DENSITY_CLI_DATA_DIR: options.dataDir,
    },
  });
  console.log(`Exported ${result.skillCount} Density skills for ${result.host} to ${result.outputRoot}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
