#!/usr/bin/env node
import { pluginVersion, storageReport } from '../scripts/density-lib.mjs';
import {
  answerDensityQuestion,
  askChart,
  authLogin,
  availableBuildings,
  benchmarkCompare,
  boundedGenericDays,
  dataHealthReport,
  floorUsageReport,
  historicalExport,
  installManagedCli,
  liveWayfindingStatus,
  localDataProfile,
  localUtilizationQuery,
  onboardCustomer,
  repairFastQuestions,
  resolveDataDir,
  sensorHealthReport,
  setup,
  starterQuestions,
} from '../scripts/density-core.mjs';
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
  tool('install_managed_cli', 'Explicitly install or update the plugin-managed Density CLI runtime from the configured verified manifest.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string', description: 'Density local data dir used only for capability validation. Defaults to DENSITY_CLI_DATA_DIR or ~/.density-cli.' },
      manifestPath: { type: 'string', description: 'Optional local manifest path or file:// URL. Defaults to the plugin manifest or DENSITY_MANAGED_CLI_MANIFEST(_PATH).' },
      platform: { type: 'string', description: 'Optional platform-arch key such as darwin-arm64. Defaults to the current platform.' },
      runtimeRoot: { type: 'string', description: 'Optional runtime cache root. Defaults to ~/.density-cli/plugin-runtime.' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
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
  tool('onboard_customer', 'Prepare a starter local customer dataset with staged setup by default; full preload sync requires explicit fullSync.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      orgId: { type: 'string', description: 'Optional organization id to select before syncing.' },
      days: { type: 'number', minimum: 1, maximum: 14, description: 'Starter metrics preload window. Defaults to 14 days; windows over 7 days use hourly metrics.' },
      fullSync: { type: 'boolean', description: 'Run starter preload metrics/occupancy/export phases. Defaults false.' },
      prewarmQuestions: { type: 'boolean', description: 'After full sync, precompute starter-question answers and chart artifacts when supported. Defaults true.' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 600, description: 'Per-command timeout for explicit full sync.' },
    },
    additionalProperties: false,
  }),
  tool('historical_export', 'Export a larger customer-owned local history window to Parquet. Separate from the fast 14-day starter preload.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      orgId: { type: 'string', description: 'Optional organization id to select before exporting.' },
      days: { type: 'number', minimum: 1, maximum: 365, description: 'Historical local export window. Defaults to 90 days.' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 3600, description: 'Per-command timeout for historical export. Defaults to 600 seconds.' },
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
  tool('answer_density_question', 'Default front door for ordinary Density questions. Use for natural-language Density questions before narrower tools, especially broad prompts like "pick any building" or "compare any one site"; routes internally through historical, live wayfinding, floorplan, data health, or sensor health surfaces. Do not use shell, DuckDB, SQL, manual CLI commands, or hand-built chart scripts for ordinary questions.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      dataDir: { type: 'string', description: 'Density local data dir. Defaults to DENSITY_CLI_DATA_DIR or ~/.density-cli.' },
      intentHint: { type: 'string', description: 'Optional caller hint such as historical, live, floorplan, data-health, or sensor-health. The router still validates from the question.' },
    },
    required: ['question'],
    additionalProperties: false,
  }),
  tool('ask_chart', 'Compatibility-only. Use for legacy chart artifact callers that already expect ask_chart output; prefer answer_density_question or local_utilization_query for ordinary Density questions.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      dataDir: { type: 'string' },
    },
    required: ['question'],
    additionalProperties: false,
  }),
  tool('local_utilization_query', 'Use for historical utilization, trends, rankings, busiest/least-used spaces, and local customer-owned analytics when the scope is already clear. For broad "any building/site" prompts, use answer_density_question first. Do not use for live availability, sensor health, benchmark peer context, shell, DuckDB, SQL, or manual Parquet fallbacks.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      dataDir: { type: 'string' },
    },
    required: ['question'],
    additionalProperties: false,
  }),
  tool('floor_usage_report', 'Use for floorplan, map, spatial overlay, heatmap, or visual floor-usage artifact requests. Historical utilization only; live walkable availability belongs in live_wayfinding_status.', {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Optional user prompt that requested the floorplan artifact.' },
      dataDir: { type: 'string' },
      outFile: { type: 'string', description: 'Optional destination HTML file. Defaults to the Density artifacts directory.' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
    },
    additionalProperties: false,
  }),
  tool('local_data_profile', 'Profile local customer-owned Density data readiness and freshness without using benchmark or live-feed sources.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      window: { type: 'string', description: 'Optional user-requested time window to describe coverage expectations.' },
    },
    additionalProperties: false,
  }),
  tool('available_buildings', 'List building readiness before analysis: live/planning status, go-live state, metric coverage, geometry, chart queryability, and live wayfinding eligibility.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
    },
    additionalProperties: false,
  }),
  tool('data_health_report', 'Use for local data readiness, freshness, missing rows, stale data, zero charts, sync gaps, and trust diagnostics for historical analytics.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      window: { type: 'string' },
    },
    additionalProperties: false,
  }),
  tool('live_wayfinding_status', 'Use for current, now, live, open, free, occupied, or available space questions. Reads the live feed and returns liveAvailable false rather than substituting historical data.', {
    type: 'object',
    properties: {
      query: { type: 'string' },
      floorId: { type: 'string' },
      dataDir: { type: 'string' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 30000 },
      maxAgeSeconds: { type: 'number', minimum: 1, maximum: 300 },
    },
    required: ['query'],
    additionalProperties: false,
  }),
  tool('benchmark_compare', 'Use for benchmark, peer, cohort, percentile, or market comparison questions when an approved Density benchmark source is connected. Never returns raw peer rows.', {
    type: 'object',
    properties: {
      metric: { type: 'string' },
      cohort: { type: 'object', additionalProperties: true },
      customerMetric: { type: 'object', additionalProperties: true },
    },
    additionalProperties: false,
  }),
  tool('sensor_health_report', 'Use for sensor health, offline/stale/degraded sensors, mapping status, live signal health, and operational readiness. Cloud-only; no DuckDB or Parquet fallback.', {
    type: 'object',
    properties: {
      organizationId: { type: 'string' },
      buildingId: { type: 'string' },
      floorId: { type: 'string' },
      spaceIds: { type: 'array', items: { type: 'string' } },
    },
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
        serverInfo: { name: 'density', version: await pluginVersion() ?? '0.1.8' },
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
    case 'install_managed_cli':
      return jsonTool(await installManagedCli(args));
    case 'auth_login':
      return jsonTool(await authLogin(args));
    case 'onboard_customer':
      return jsonTool(await onboardCustomer(args));
    case 'historical_export':
      return jsonTool(await historicalExport(args));
    case 'create_demo_customer':
      return jsonTool(await createDemoCustomer(args));
    case 'answer_density_question':
      return jsonTool(await answerDensityQuestion(args));
    case 'ask_chart':
      return jsonTool(await askChart(args));
    case 'local_utilization_query':
      return jsonTool(await localUtilizationQuery(args));
    case 'floor_usage_report':
      return jsonTool(await floorUsageReport(args));
    case 'local_data_profile':
      return jsonTool(await localDataProfile(args));
    case 'available_buildings':
      return jsonTool(await availableBuildings(args));
    case 'data_health_report':
      return jsonTool(await dataHealthReport(args));
    case 'live_wayfinding_status':
      return jsonTool(await liveWayfindingStatus(args));
    case 'benchmark_compare':
      return jsonTool(await benchmarkCompare(args));
    case 'sensor_health_report':
      return jsonTool(await sensorHealthReport(args));
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
