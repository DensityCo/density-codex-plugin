import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testDir, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const skillsDir = path.join(pluginRoot, 'skills');

const EXPECTED_SKILLS = [
  'benchmarking',
  'data-health',
  'density',
  'floorplan',
  'sensor-health',
  'setup',
  'utilization',
  'wayfinding',
];

const EXPECTED_MCP_TOOLS = [
  'setup',
  'install_managed_cli',
  'auth_login',
  'onboard_customer',
  'historical_export',
  'create_demo_customer',
  'ask_chart',
  'local_utilization_query',
  'floor_usage_report',
  'local_data_profile',
  'available_buildings',
  'data_health_report',
  'live_wayfinding_status',
  'benchmark_compare',
  'sensor_health_report',
  'storage_report',
  'starter_questions',
  'repair_fast_questions',
];

test('Density package exposes exactly the expected skills', async () => {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const actualSkills = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(actualSkills, EXPECTED_SKILLS);
});

test('Density skills have valid packaging metadata and shared contracts', async () => {
  for (const skillName of EXPECTED_SKILLS) {
    const skillDir = path.join(skillsDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const skillText = await readFile(skillFile, 'utf8');
    const frontmatter = parseFrontmatter(skillText, skillFile);

    assert.equal(frontmatter.name, skillName, `${skillName} frontmatter name must match its folder`);
    assert.match(skillText, /^## Interaction Contract$/m, `${skillName} is missing ## Interaction Contract`);
    assert.match(skillText, /^## Progress Update Contract$/m, `${skillName} is missing ## Progress Update Contract`);

    const agentFile = path.join(skillDir, 'agents', 'openai.yaml');
    if (await exists(agentFile)) {
      const agentText = await readFile(agentFile, 'utf8');
      assert.match(agentText, new RegExp(`\\$${escapeRegExp(skillName)}(?![A-Za-z0-9_-])`), `${skillName} agents/openai.yaml must invoke $${skillName}`);
    }

    for (const reference of referencedReferenceFiles(skillText)) {
      const referencePath = path.join(skillDir, reference);
      assert.ok(await exists(referencePath), `${skillName} references missing file: ${reference}`);
    }
  }
});

test('Density package files are tracked by git', async () => {
  const pathspecs = [
    'plugins/density/skills',
    'plugins/density/assets',
    'plugins/density/scripts',
    'plugins/density/.codex-plugin',
    'plugins/density/.mcp.json',
    'plugins/density/mcp-server',
  ];
  const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '--', ...pathspecs], { cwd: repoRoot });
  const untracked = stdout.split(/\r?\n/).filter(Boolean).sort();

  assert.equal(
    untracked.length,
    0,
    `Density package files must be tracked by git. Untracked files:\n${untracked.join('\n')}`,
  );
});

test('Density design contract preserves Broadsheet/Tufte chart requirements', async () => {
  const design = await readFile(path.join(pluginRoot, 'assets', 'design.md'), 'utf8');

  assert.match(design, /Broadsheet\/Tufte/, 'design contract should name the intended analytical aesthetic');
  assert.match(design, /high signal-to-ink ratio/, 'design contract should retain the Tufte-style signal discipline');
  assert.match(design, /generic dashboard chrome/, 'design contract should reject generic dashboard styling');
  assert.match(design, /must never overlap the title, marks, axes, or each other/, 'design contract should prohibit title/legend/chart collisions');
  assert.match(design, /Density CLI or plugin chart contract/, 'design contract should prefer plugin artifacts over one-off chart scripts');
});

test('Density skills preserve building lifecycle and go-live analysis rules', async () => {
  const density = await readFile(path.join(skillsDir, 'density', 'SKILL.md'), 'utf8');
  const utilization = await readFile(path.join(skillsDir, 'utilization', 'SKILL.md'), 'utf8');
  const wayfinding = await readFile(path.join(skillsDir, 'wayfinding', 'SKILL.md'), 'utf8');

  assert.match(density, /available_buildings/, 'parent skill should name the lifecycle readiness tool');
  assert.match(density, /status\/go-live readiness/, 'parent skill should require status/go-live awareness');
  assert.match(utilization, /chartQueryable/, 'utilization skill should use chart queryability before artifacts');
  assert.match(utilization, /planning, retired, inactive, future go-live, or unknown go-live/, 'utilization skill should disclose non-live or uncertain lifecycle states');
  assert.match(wayfinding, /liveWayfindingEligible/, 'wayfinding skill should require live wayfinding eligibility');
});

test('Density MCP server version and tool list match the plugin package', async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.website, 'https://density.io/');
  assert.equal(manifest.homepage, 'https://density.io/');
  assert.equal(manifest.interface?.website, 'https://density.io/');
  const client = await JsonRpcProcess.start();

  try {
    const initialized = await client.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'density-packaging-test', version: '0.0.0' },
    });
    assert.equal(initialized.serverInfo?.version, manifest.version);

    const listed = await client.call('tools/list', {});
    const toolNames = (listed.tools ?? []).map((tool) => tool.name).sort();
    const missingTools = EXPECTED_MCP_TOOLS.filter((tool) => !toolNames.includes(tool));

    assert.deepEqual(missingTools, [], `MCP tools/list is missing expected tools:\n${missingTools.join('\n')}`);
  } finally {
    await client.close();
  }
});

function parseFrontmatter(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, `${file} is missing frontmatter`);

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    fields[field[1]] = field[2].replace(/^['"]|['"]$/g, '');
  }
  return fields;
}

function referencedReferenceFiles(text) {
  const references = new Set();
  const patterns = [
    /`(references\/[^`\s]+)`/g,
    /(?:^|\s)(references\/[A-Za-z0-9._/-]+\.md)(?=[\s).,;:]|$)/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      references.add(match[1]);
    }
  }
  return [...references].sort();
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class JsonRpcProcess {
  static async start() {
    const child = spawn(process.execPath, ['mcp-server/server.mjs'], {
      cwd: pluginRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new JsonRpcProcess(child);
  }

  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';
    this.pending = new Map();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    child.on('exit', (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server exited before responding: code=${code} signal=${signal} stderr=${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  call(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr=${this.stderr}`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;

    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
