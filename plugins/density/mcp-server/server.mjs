#!/usr/bin/env node
import { pluginVersion, storageReport } from '../scripts/density-lib.mjs';
import { askChart, authLogin, boundedGenericDays, onboardCustomer, repairFastQuestions, resolveDataDir, setup, starterQuestions } from '../scripts/density-core.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const tools = [
  tool('setup', 'Check Density readiness: CLI discovery/build, renderer tools, auth/status, and Parquet-first storage.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string', description: 'Density local data dir. Defaults to DENSITY_CLI_DATA_DIR or ~/.density-cli.' },
    },
    additionalProperties: false,
  }),
  tool('auth_login', 'Start Density browser auth through the underlying CLI.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
    },
    additionalProperties: false,
  }),
  tool('onboard_customer', 'Prepare local customer data with staged setup by default; full metrics sync requires explicit fullSync.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      orgId: { type: 'string', description: 'Optional organization id to select before syncing.' },
      days: { type: 'number', minimum: 1, maximum: 14, description: 'Metrics preload window. Defaults to 14 days; windows over 7 days use hourly metrics.' },
      fullSync: { type: 'boolean', description: 'Run long metrics/occupancy/export phases. Defaults false.' },
      prewarmQuestions: { type: 'boolean', description: 'After full sync, precompute starter-question answers and chart artifacts when supported. Defaults true.' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 600, description: 'Per-command timeout for explicit full sync.' },
    },
    additionalProperties: false,
  }),
  tool('create_demo_customer', 'Create a fresh Parquet-first demo customer data dir from an existing local Density data dir.', {
    type: 'object',
    properties: {
      sourceDir: { type: 'string', description: 'Existing Density data dir with parquet files.' },
      outDir: { type: 'string', description: 'Output demo customer data dir.' },
      days: { type: 'number', minimum: 1, maximum: 60 },
    },
    additionalProperties: false,
  }),
  tool('ask_chart', 'Ask a natural-language question and return title, subtitle, structured UI when supported, and SVG/HTML/PNG chart artifacts.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      dataDir: { type: 'string' },
    },
    required: ['question'],
    additionalProperties: false,
  }),
  tool('storage_report', 'Report DuckDB and Parquet sizes for a Density local data dir.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
    },
    additionalProperties: false,
  }),
  tool('starter_questions', 'Run the fast starter-question pack when supported, or return good Density chart questions for testing local data.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      chart: { type: 'boolean', description: 'Generate SVG/HTML chart artifacts. Defaults true.' },
      cached: { type: 'boolean', description: 'Return a previously warmed starter manifest when available. Defaults false.' },
    },
    additionalProperties: false,
  }),
  tool('repair_fast_questions', 'Repair normalized local space metadata from resources.parquet so fast question and report joins can use existing local data.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
    },
    additionalProperties: false,
  }),
];

let inputBuffer = '';
let toolQueue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  drainMessages();
});

function drainMessages() {
  let newlineIndex;
  while ((newlineIndex = inputBuffer.indexOf('\n')) !== -1) {
    const raw = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (raw) void handleRawMessage(raw);
  }
}

async function handleRawMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    sendError(null, -32700, `Parse error: ${error.message}`);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;

  try {
    if (message.method === 'initialize') {
      sendResult(message.id, {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'density', version: await pluginVersion() ?? '0.1.2' },
      });
      return;
    }
    if (message.method === 'tools/list') {
      sendResult(message.id, { tools });
      return;
    }
    if (message.method === 'tools/call') {
      const result = await enqueueToolCall(message.params?.name, message.params?.arguments || {});
      sendResult(message.id, result);
      return;
    }
    sendError(message.id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    sendResult(message.id, toolError(error.message || String(error)));
  }
}

async function enqueueToolCall(name, args) {
  const run = toolQueue.then(() => callTool(name, args));
  toolQueue = run.catch(() => undefined);
  return run;
}

async function callTool(name, args) {
  switch (name) {
    case 'setup':
      return jsonTool(await setup(args));
    case 'auth_login':
      return jsonTool(await authLogin(args));
    case 'onboard_customer':
      return jsonTool(await onboardCustomer(args));
    case 'create_demo_customer':
      return jsonTool(await createDemoCustomer(args));
    case 'ask_chart':
      return jsonTool(await askChart(args));
    case 'storage_report':
      return jsonTool(await storageReport(resolveDataDir(args.dataDir)));
    case 'starter_questions':
      return jsonTool(await starterQuestions(args));
    case 'repair_fast_questions':
      return jsonTool(await repairFastQuestions(args));
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

async function createDemoCustomer(args) {
  const sourceDir = args.sourceDir || path.join(os.homedir(), '.density-cli-linkedin');
  const outDir = args.outDir || path.join(os.homedir(), '.density-cli-demo-customer');
  const days = boundedGenericDays(args.days);
  const result = await runNodeScript('density-demo-customer.mjs', [
    `--source=${sourceDir}`,
    `--out=${outDir}`,
    `--days=${days}`,
    '--json',
  ]);
  return JSON.parse(result.stdout);
}

async function runNodeScript(script, args) {
  const scriptPath = new URL(`../scripts/${script}`, import.meta.url);
  return runProcess(process.execPath, [scriptPath.pathname, ...args]);
}

async function runProcess(command, args) {
  const child = spawn(command, args);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(stderr || stdout || `${command} failed`);
  return { stdout, stderr };
}

function tool(name, description, inputSchema) {
  return { name, description, inputSchema };
}

function jsonTool(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function sendResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}
