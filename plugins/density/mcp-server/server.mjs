#!/usr/bin/env node
import { defaultDataDir, ensureDensityCliBuilt, parseAskOutput, renderPng, resolveDensityCli, runDensity, storageReport } from '../scripts/density-lib.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const NO_PROPS = { type: 'object', properties: {}, additionalProperties: false };

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
  tool('onboard_customer', 'Prepare local customer data by syncing spaces, 15-minute metrics, and hourly occupancy for a short window.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      orgId: { type: 'string', description: 'Optional organization id to select before syncing.' },
      days: { type: 'number', minimum: 1, maximum: 60, description: 'Window to sync. Defaults to 14.' },
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
  tool('ask_chart', 'Ask a natural-language question and return title, subtitle, SVG, HTML, and PNG chart artifacts.', {
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
  tool('starter_questions', 'Return good Density chart questions for testing the current local data.', NO_PROPS),
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
        serverInfo: { name: 'density', version: '0.1.0' },
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
      return jsonTool({
        known: [
          'what are the busiest rooms?',
          'what are the least used rooms?',
          'what time are rooms busiest?',
        ],
        generated: [
          'which room capacities are used most?',
          'which room capacities are used most on weekends?',
          'show me a pie chart of space type breakdown',
          'what kinds of spaces are represented?',
        ],
      });
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

async function setup(args) {
  const dataDir = resolveDataDir(args.dataDir);
  const checks = [];
  const addCheck = (name, ok, detail) => checks.push({ name, ok, detail });
  const cli = await resolveDensityCli();
  addCheck('density cli found', Boolean(cli), cli?.source ?? 'Set DENSITY_CLI_BIN or install density on PATH.');
  if (cli) {
    const build = await ensureDensityCliBuilt(cli);
    addCheck('density cli built', true, build.reason);
    const status = await runDensity(cli, ['status'], { dataDir, allowFailure: true });
    addCheck('density status runs', status.code === 0, status.code === 0 ? 'status completed' : (status.stderr || status.stdout).trim());
  }
  const storage = await storageReport(dataDir);
  addCheck('canonical parquet present', storage.parquetBytes > 0, storage.parquetBytes > 0 ? `${storage.parquetBytes} bytes` : 'No parquet mirror yet.');
  return {
    ok: checks.every((check) => check.ok),
    dataDir,
    checks,
    storage,
    nextSteps: checks.some((check) => !check.ok && check.name === 'density status runs')
      ? ['Run auth_login, then onboard_customer.']
      : storage.parquetBytes === 0
        ? ['Run onboard_customer after auth, or create_demo_customer from an existing local dataset.']
        : [],
  };
}

async function authLogin(args) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const result = await runDensity(cli, ['auth', 'login'], { dataDir, allowFailure: true });
  return {
    ok: result.code === 0,
    dataDir,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function onboardCustomer(args) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const days = boundedDays(args.days);
  const steps = [];
  const runStep = async (name, commandArgs) => {
    const startedAt = Date.now();
    const result = await runDensity(cli, commandArgs, { dataDir, allowFailure: true });
    const step = {
      name,
      ok: result.code === 0,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
    steps.push(step);
    if (!step.ok) throw new Error(`${name} failed: ${step.stderr || step.stdout}`);
  };
  if (args.orgId) await runStep('select organization', ['org', 'use', args.orgId]);
  await runStep('sync spaces', ['sync', '--stream', 'spaces']);
  await runStep('sync meeting-room metrics', ['sync', '--stream', 'metrics', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', '15m']);
  await runStep('sync occupancy overview', ['sync', '--stream', 'occupancy', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', '1h']);
  return {
    ok: true,
    dataDir,
    days,
    steps,
    storage: await storageReport(dataDir),
  };
}

async function createDemoCustomer(args) {
  const sourceDir = args.sourceDir || path.join(os.homedir(), '.density-cli-linkedin');
  const outDir = args.outDir || path.join(os.homedir(), '.density-cli-demo-customer');
  const days = boundedDays(args.days);
  const result = await runNodeScript('density-demo-customer.mjs', [
    `--source=${sourceDir}`,
    `--out=${outDir}`,
    `--days=${days}`,
    '--json',
  ]);
  return JSON.parse(result.stdout);
}

async function askChart(args) {
  const question = String(args.question || '').trim();
  if (!question) throw new Error('question is required.');
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const answer = await runDensity(cli, ['ask', question, '--chart'], { dataDir });
  const parsed = parseAskOutput(answer.stdout);
  const png = await renderPng(parsed.chart);
  return {
    question,
    title: parsed.title,
    subtitle: parsed.subtitle,
    chart: parsed.chart,
    html: parsed.html,
    png,
    dataDir,
  };
}

async function requireCli() {
  const cli = await resolveDensityCli();
  if (!cli) throw new Error('Density CLI not found. Set DENSITY_CLI_BIN, DENSITY_CLI_REPO, or install density on PATH.');
  await ensureDensityCliBuilt(cli);
  return cli;
}

function boundedDays(value) {
  const days = value === undefined ? 14 : Number(value);
  if (!Number.isInteger(days) || days <= 0 || days > 60) {
    throw new Error('days must be an integer between 1 and 60.');
  }
  return days;
}

function resolveDataDir(value) {
  return value || process.env.DENSITY_CLI_DATA_DIR || defaultDataDir();
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
