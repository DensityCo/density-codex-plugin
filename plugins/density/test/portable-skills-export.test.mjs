import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { exportDensitySkills } from '../scripts/export-density-skills.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testDir, '..');

const exists = async (file) => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const callMcp = async (child, id, method, params = {}) => {
  const response = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`)), 5000);
    const onStdout = (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline === -1) return;
      child.stdout.off('data', onStdout);
      clearTimeout(timeout);
      resolve(JSON.parse(stdout.slice(0, newline)));
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const message = await response;
  if (message.error) throw new Error(message.error.message);
  return message.result;
};

test('exports a self-contained Claude skill bundle without Codex-only agent metadata', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'density-claude-skills-'));
  try {
    const result = await exportDensitySkills({ host: 'claude', outputRoot, pluginRoot });

    assert.equal(result.skillCount, 8);
    assert.match(await readFile(path.join(outputRoot, 'skills', 'density', 'SKILL.md'), 'utf8'), /# Density/);
    assert.match(
      await readFile(path.join(outputRoot, 'skills', 'benchmarking', 'references', 'darshan-benchmark-methodology.md'), 'utf8'),
      /Darshan Benchmark Methodology/,
    );
    assert.equal(await exists(path.join(outputRoot, 'skills', 'density', 'agents', 'openai.yaml')), false);
    assert.equal(await exists(path.join(outputRoot, 'assets', 'design.md')), true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('exports an executable Claude MCP runtime closure', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'density-claude-runtime-'));
  const relocatedRoot = `${outputRoot}-relocated`;
  let child;
  try {
    const result = await exportDensitySkills({ host: 'claude', outputRoot, pluginRoot });
    const mcpConfig = JSON.parse(await readFile(path.join(outputRoot, '.mcp.json'), 'utf8'));
    const server = mcpConfig.mcpServers.density;
    assert.equal(result.runtimeFileCount, 11);
    assert.equal(await exists(path.join(outputRoot, 'scripts', 'density-background-deep-sync.mjs')), true);
    assert.equal(await exists(path.join(outputRoot, 'scripts', 'density-demo-customer.mjs')), true);
    assert.equal(await exists(path.join(outputRoot, 'scripts', 'density-setup.mjs')), true);
    assert.equal(await exists(path.join(outputRoot, 'scripts', 'density-onboard-customer.mjs')), true);
    assert.equal(await exists(path.join(outputRoot, 'scripts', 'density-ask-chart.mjs')), true);
    assert.equal(await exists(path.join(outputRoot, 'assets', 'density-icon.png')), true);

    assert.equal(server.args[0], '${CLAUDE_PLUGIN_ROOT}/mcp-server/server.mjs');
    assert.equal(Object.hasOwn(server, 'cwd'), false);
    await rename(outputRoot, relocatedRoot);
    const hostArgs = server.args.map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', relocatedRoot));
    child = spawn(server.command, hostArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    const initialized = await callMcp(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'density-portable-export-test', version: '0.0.0' },
    });
    assert.equal(initialized.serverInfo.name, 'density');

    const listed = await callMcp(child, 2, 'tools/list');
    assert.equal(listed.tools.some((tool) => tool.name === 'storage_report'), true);

    const dataDir = path.join(relocatedRoot, 'read-only-data');
    const called = await callMcp(child, 3, 'tools/call', {
      name: 'storage_report',
      arguments: { dataDir },
    });
    const report = JSON.parse(called.content[0].text);
    assert.equal(report.dataDir, dataDir);
    assert.equal(report.duckdbBytes, 0);
    assert.equal(report.parquetBytes, 0);
    assert.equal(report.parquetReady, false);
  } finally {
    child?.kill('SIGTERM');
    await rm(outputRoot, { recursive: true, force: true });
    await rm(relocatedRoot, { recursive: true, force: true });
  }
});

test('exports Codex agent metadata when requested', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'density-codex-skills-'));
  try {
    await exportDensitySkills({ host: 'codex', outputRoot, pluginRoot });

    assert.equal(await exists(path.join(outputRoot, 'skills', 'density', 'agents', 'openai.yaml')), true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('exports a Codex MCP config rooted at the installed plugin', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'density-codex-runtime-'));
  let child;
  try {
    await exportDensitySkills({ host: 'codex', outputRoot, pluginRoot });
    const mcpConfig = JSON.parse(await readFile(path.join(outputRoot, '.mcp.json'), 'utf8'));
    const server = mcpConfig.mcpServers.density;

    assert.equal(server.command, 'node');
    assert.deepEqual(server.args, ['./mcp-server/server.mjs']);
    assert.equal(server.cwd, '.');
    assert.equal(await exists(path.resolve(outputRoot, server.cwd, server.args[0])), true);

    child = spawn(server.command, server.args, {
      cwd: path.resolve(outputRoot, server.cwd),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const initialized = await callMcp(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'density-codex-export-test', version: '0.0.0' },
    });
    assert.equal(initialized.serverInfo.name, 'density');
  } finally {
    child?.kill('SIGTERM');
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('refuses to export into the source plugin tree', async () => {
  await assert.rejects(
    exportDensitySkills({ host: 'claude', outputRoot: pluginRoot, pluginRoot }),
    /outside the Density plugin source tree/,
  );
});

test('refuses a symlinked export parent that resolves into the source plugin tree', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'density-export-link-'));
  const linkedParent = path.join(tempDir, 'linked-plugin');
  try {
    await symlink(pluginRoot, linkedParent);
    await assert.rejects(
      exportDensitySkills({ host: 'claude', outputRoot: path.join(linkedParent, 'bundle'), pluginRoot }),
      /outside the Density plugin source tree/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('refuses to overwrite a nonempty export destination', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'density-existing-skills-'));
  try {
    await writeFile(path.join(outputRoot, 'keep.txt'), 'keep me\n');

    await assert.rejects(
      exportDensitySkills({ host: 'claude', outputRoot, pluginRoot }),
      /destination must be empty/,
    );
    assert.equal(await readFile(path.join(outputRoot, 'keep.txt'), 'utf8'), 'keep me\n');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
