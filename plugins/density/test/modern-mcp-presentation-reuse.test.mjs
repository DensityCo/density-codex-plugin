import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { renderChart } from '../scripts/density-core.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'mcp-server', 'server.mjs');
const evidenceId = `qe_${'a'.repeat(64)}`;
const chart = {
  body: 'bars',
  columns: [
    { field: 'room', role: 'entity', label: 'Room' },
    { field: 'used_hours', role: 'measure', unit: 'hours', label: 'Used hours' },
  ],
  title: 'Used hours by room',
};

const fakeCli = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.DENSITY_TEST_CALLS, JSON.stringify(args) + '\\n');
const command = args[0];
if (command === 'capabilities') {
  console.log(JSON.stringify({ commands: { renderChart: true } }));
  process.exit(0);
}
if (command === 'query-db') {
  console.error('presentation-only rendering must not execute query-db');
  process.exit(1);
}
if (command === 'render-chart') {
  const evidence = args[args.indexOf('--evidence') + 1];
  const declaration = JSON.parse(args[args.indexOf('--chart') + 1]);
  console.log(JSON.stringify({ kind: 'density.render-chart.v1', evidenceId: evidence, declaration }));
  process.exit(0);
}
console.error('unsupported fake CLI command');
process.exit(1);
`;

const withFakeCli = async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-modern-mcp-presentation-reuse-'));
  const cli = path.join(dir, 'density-fake.mjs');
  const calls = path.join(dir, 'calls.jsonl');
  const dataDir = path.join(dir, 'data');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const previousBin = process.env.DENSITY_CLI_BIN;
  const previousCalls = process.env.DENSITY_TEST_CALLS;
  process.env.DENSITY_CLI_BIN = cli;
  process.env.DENSITY_TEST_CALLS = calls;
  t.after(async () => {
    if (previousBin === undefined) delete process.env.DENSITY_CLI_BIN;
    else process.env.DENSITY_CLI_BIN = previousBin;
    if (previousCalls === undefined) delete process.env.DENSITY_TEST_CALLS;
    else process.env.DENSITY_TEST_CALLS = previousCalls;
    await rm(dir, { recursive: true, force: true });
  });
  return { calls, dataDir };
};

const readCalls = async (file) => (await readFile(file, 'utf8'))
  .trim()
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

test('renderChart invokes render-chart with stored evidence and no SQL command', async (t) => {
  const { calls, dataDir } = await withFakeCli(t);
  const response = await renderChart({ evidenceId, chart, dataDir });

  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    kind: 'density.render-chart.v1',
    evidenceId,
    declaration: chart,
  });

  const invocations = await readCalls(calls);
  assert.deepEqual(invocations.map(([command]) => command), ['capabilities', 'render-chart']);
  const renderInvocation = invocations[1];
  assert.equal(renderInvocation[renderInvocation.indexOf('--evidence') + 1], evidenceId);
  assert.deepEqual(JSON.parse(renderInvocation[renderInvocation.indexOf('--chart') + 1]), chart);
  assert.equal(renderInvocation.includes('--sql'), false);
  assert.equal(invocations.some(([command]) => command === 'query-db'), false);
});

test('renderChart rejects malformed evidence ids before invoking the CLI', async () => {
  for (const invalid of ['', 'qe_short', `QE_${'a'.repeat(64)}`, '../evidence.json']) {
    await assert.rejects(
      () => renderChart({ evidenceId: invalid, chart }),
      /valid evidenceId is required/i,
    );
  }
});

function startServer() {
  return spawn(process.execPath, [serverPath], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function callMcp(child, id, method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`)), timeoutMs);
    const onStdout = (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline === -1) return;
      child.stdout.off('data', onStdout);
      clearTimeout(timeout);
      const message = JSON.parse(stdout.slice(0, newline));
      resolve(message.error ? message : message.result);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

test('Modern MCP declares the presentation-only render_chart contract', async () => {
  const child = startServer();
  try {
    await callMcp(child, 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'presentation-reuse-test', version: '0.0.0' },
    });
    const listed = await callMcp(child, 2, 'tools/list');
    const tool = listed.tools.find(({ name }) => name === 'render_chart');

    assert.ok(tool, 'render_chart should be model-visible');
    assert.match(tool.description, /without executing DuckDB again/i);
    assert.deepEqual(tool.inputSchema.required, ['evidenceId', 'chart']);
    assert.deepEqual(tool.inputSchema.properties.evidenceId, {
      type: 'string',
      pattern: '^qe_[a-f0-9]{64}$',
    });
    assert.deepEqual(tool.inputSchema.properties.chart.required, ['body', 'columns', 'title']);
    assert.equal(
      tool.inputSchema.properties.chart.properties.body.description,
      'The requested chart family. For tiles, use one row with three or four defining scalar measures. Put the semantic lead measure first.',
    );
    assert.equal(tool.inputSchema.properties.chart.properties.columns.minItems, 1);
    assert.deepEqual(tool.inputSchema.properties.chart.properties.columns.items.properties.sparklineField, {
      type: 'string',
      minLength: 1,
      description: 'Exact returned alias containing 2–366 ordered {x,value} weekly point objects. Use only on tile measures, and declare it on every tile measure or none.',
    });
    assert.deepEqual(tool.inputSchema.properties.chart.properties.columns.items.properties.decimals, {
      type: 'integer',
      minimum: 0,
      maximum: 6,
      description: 'Optional fixed display decimals for a numeric table measure. Omit it to preserve natural number formatting.',
    });
    assert.deepEqual(tool.inputSchema.properties.chart.properties.scopeLabel, {
      type: 'string',
      minLength: 1,
      description: 'The exact requested building, floor, or space for this chart.',
    });
    assert.deepEqual(tool.inputSchema.properties.chart.properties.display, {
      type: 'object',
      description: 'Set top for one readable bars or table subset. Set scaleMax to 100 for a percentage bar measure.',
      properties: {
        top: { type: 'integer', minimum: 1 },
        scaleMax: { type: 'number', enum: [100] },
      },
      minProperties: 1,
      additionalProperties: false,
    });
    assert.deepEqual(tool.inputSchema.properties.chart.properties.population, {
      type: 'object',
      description: 'Optional evidence aliases for constant eligible and measured counts. Every returned row must contain each declared alias.',
      properties: {
        eligibleField: { type: 'string', minLength: 1 },
        measuredField: { type: 'string', minLength: 1 },
      },
      minProperties: 1,
      additionalProperties: false,
    });
    assert.match(tool.description, /do not add a SQL limit/i);
    assert.equal(tool.inputSchema.properties.chart.additionalProperties, false);
  } finally {
    child.kill('SIGTERM');
  }
});
