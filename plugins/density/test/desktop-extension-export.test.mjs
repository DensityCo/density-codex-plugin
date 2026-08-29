import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  densityDesktopToolNames,
  exportDensityDesktopExtension,
} from '../scripts/export-density-desktop-extension.mjs';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testDir, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const mcpbCli = path.join(repoRoot, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');

const exists = async (file) => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const fakeRuntime = async (root) => {
  const files = [
    'bin/density.mjs',
    'dist/cli.js',
    'dist-ui/index.html',
    'package.json',
    'runtime/node',
  ];
  for (const relativeFile of files) {
    const file = path.join(root, relativeFile);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, relativeFile === 'package.json' ? '{}\n' : `${relativeFile}\n`);
  }
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
};

test('exports a schema-valid relocatable Claude Desktop extension', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'density-desktop-extension-'));
  const runtimeRoot = path.join(tempRoot, 'source-runtime');
  const outputRoot = path.join(tempRoot, 'extension');
  try {
    await fakeRuntime(runtimeRoot);
    const result = await exportDensityDesktopExtension({ outputRoot, runtimeRoot, pluginRoot });
    const manifest = JSON.parse(await readFile(path.join(outputRoot, 'manifest.json'), 'utf8'));
    const canonicalManifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));

    assert.equal(result.version, canonicalManifest.version);
    assert.equal(manifest.manifest_version, '0.4');
    assert.equal(manifest.version, canonicalManifest.version);
    assert.equal(manifest.server.mcp_config.args[0], '${__dirname}/mcp-server/server.mjs');
    assert.deepEqual(manifest.server.mcp_config.env, {
      DENSITY_PLUGIN_HOST: 'claude-desktop',
      DENSITY_CLI_NODE: '${__dirname}/runtime/runtime/node',
      DENSITY_CLI_BIN: '${__dirname}/runtime/bin/density.mjs',
      DENSITY_CLI_DATA_DIR: '${user_config.data_dir}',
    });
    assert.deepEqual(manifest.tools.map((tool) => tool.name), densityDesktopToolNames);
    assert.equal(manifest.prompts_generated, true);
    assert.equal(await exists(path.join(outputRoot, 'skills', 'density', 'SKILL.md')), true);
    assert.equal(
      await readFile(path.join(outputRoot, 'guidance', 'density-system-prompt.md'), 'utf8'),
      await readFile(path.join(pluginRoot, 'guidance', 'density-system-prompt.md'), 'utf8'),
    );
    assert.equal(
      await readFile(path.join(outputRoot, 'assets', 'design.md'), 'utf8'),
      await readFile(path.join(pluginRoot, 'guidance', 'design.md'), 'utf8'),
    );
    assert.equal(await exists(path.join(outputRoot, '.mcp.json')), false);
    assert.equal(await exists(path.join(outputRoot, '.claude-plugin')), false);
    assert.equal(await exists(path.join(outputRoot, 'runtime', 'runtime', 'node')), true);
    assert.doesNotMatch(JSON.stringify(manifest), /Users\/afar|\.token|refresh-token/);

    await execFileAsync(process.execPath, [mcpbCli, 'validate', path.join(outputRoot, 'manifest.json')]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('refuses an incomplete Density runtime bundle', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'density-desktop-incomplete-'));
  try {
    await assert.rejects(
      exportDensityDesktopExtension({
        outputRoot: path.join(tempRoot, 'extension'),
        runtimeRoot: path.join(tempRoot, 'runtime'),
        pluginRoot,
      }),
      /runtime bundle is missing/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('desktop tool inventory matches the canonical MCP server', async () => {
  const server = await readFile(path.join(pluginRoot, 'mcp-server', 'server.mjs'), 'utf8');
  const names = [...server.matchAll(/\btool\('([^']+)'/g)]
    .map((match) => match[1]);
  assert.deepEqual(names, densityDesktopToolNames);
});
