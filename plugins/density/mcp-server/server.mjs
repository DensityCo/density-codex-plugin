#!/usr/bin/env node
import {
  defaultDemoSourceDir,
  pluginVersion,
  storageReport,
} from '../scripts/density-lib.mjs';
import {
  authLogin,
  availableBuildings,
  benchmarkCompare,
  configureBrand,
  boundedGenericDays,
  dataHealthReport,
  demoModeStatus,
  floorUsageReport,
  getDbSchema,
  historicalExport,
  installManagedCli,
  liveWayfindingStatus,
  localDataProfile,
  onboardCustomer,
  onboardingStatus,
  prepareFloorplans,
  queryDb,
  renderChart,
  resolveDataDir,
  sensorHealthReport,
  setup,
  status,
} from '../scripts/density-core.mjs';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { standardizeAgentResponse } from './agent-response-envelope.mjs';
import { publicQueryResponse, queryResponseDiagnostics } from './query-response-envelope.mjs';

const chartDeclarationInputSchema = {
  type: 'object',
  description: 'A presentation declaration over exact query evidence. It does not change or recalculate the evidence.',
  properties: {
    body: {
      type: 'string',
      enum: ['bars', 'line', 'heatmap', 'histogram', 'tiles', 'table', 'stacked_bar', 'scatter', 'slope', 'range', 'area', 'pie', 'donut'],
      description: 'The requested chart family. For tiles, use one row with three or four defining scalar measures. Put the semantic lead measure first.',
    },
    columns: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', minLength: 1, description: 'Exact returned column alias.' },
          role: {
            type: 'string',
            enum: ['time', 'entity', 'series', 'measure', 'bin', 'low', 'high'],
            description: 'Use measure only for quantitative evidence the user asked to chart. Omit rank, row number, ids, and coverage metadata.',
          },
          unit: {
            type: 'string',
            minLength: 1,
            description: 'For percent measures, the query must return values on a 0–100 scale. Do not pass 0–1 fractions as percent values.',
          },
          label: { type: 'string', minLength: 1 },
          sparklineField: {
            type: 'string',
            minLength: 1,
            description: 'Exact returned alias containing 2–366 ordered {x,value} weekly point objects. Use only on tile measures, and declare it on every tile measure or none.',
          },
          decimals: {
            type: 'integer',
            minimum: 0,
            maximum: 6,
            description: 'Optional fixed display decimals for a numeric table measure. Omit it to preserve natural number formatting.',
          },
        },
        required: ['field', 'role'],
        additionalProperties: false,
      },
    },
    scopeLabel: {
      type: 'string',
      minLength: 1,
      description: 'The exact requested building, floor, or space for this chart.',
    },
    timezoneNote: { type: 'string', minLength: 1 },
    window: {
      type: 'object',
      description: 'Use only when the user supplied explicit ISO dates. Otherwise omit it and return boundary aliases in the SQL result.',
      properties: {
        start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    coverageNote: { type: 'string', minLength: 1 },
    population: {
      type: 'object',
      description: 'Optional evidence aliases for constant eligible and measured counts. Every returned row must contain each declared alias.',
      properties: {
        eligibleField: { type: 'string', minLength: 1 },
        measuredField: { type: 'string', minLength: 1 },
      },
      minProperties: 1,
      additionalProperties: false,
    },
    spatial: {
      type: 'object',
      description: 'Optional static historical location evidence in the chart rail. Every selected floor and space ID must come from the same query evidence. This never shows live state.',
      properties: {
        floorIdField: { type: 'string', minLength: 1, description: 'Exact returned alias containing one floor ID.' },
        spaceIdField: { type: 'string', minLength: 1, description: 'Exact returned alias containing one to five space IDs.' },
        labelField: { type: 'string', minLength: 1, description: 'Optional returned alias containing the human space name.' },
        title: { type: 'string', minLength: 1, description: 'Optional short heading. Defaults to Historical location.' },
      },
      required: ['floorIdField', 'spaceIdField'],
      additionalProperties: false,
    },
    display: {
      type: 'object',
      description: 'Set top for one readable bars or table subset. Set scaleMax to 100 for a percentage bar measure.',
      properties: {
        top: { type: 'integer', minimum: 1 },
        scaleMax: { type: 'number', enum: [100] },
      },
      minProperties: 1,
      additionalProperties: false,
    },
    title: { type: 'string', minLength: 1 },
    subtitle: { type: 'string', minLength: 1 },
  },
  required: ['body', 'columns', 'title'],
  additionalProperties: false,
};

const localReadOnlyTool = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const remoteReadOnlyTool = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const localWriteTool = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
});

const remoteWriteTool = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
});

const tools = [
  tool('setup', 'Check Density readiness: CLI discovery/build, renderer tools, auth/status, and Parquet-first storage.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string', description: 'Density local data dir. Defaults to DENSITY_CLI_DATA_DIR or ~/.density-cli.' },
    },
    additionalProperties: false,
  }, localWriteTool),
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
  }, remoteWriteTool),
  tool('auth_login', 'Start Density browser auth through the underlying CLI.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
    },
    additionalProperties: false,
  }, remoteWriteTool),
  tool('onboard_customer', 'Prepare local Density data. Recommended full sync fetches 30 days for all locations now and can continue deeper supported history in the background.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      orgId: { type: 'string', description: 'Optional organization id to select before syncing.' },
      days: { type: 'number', minimum: 1, maximum: 30, description: 'Recent metrics preload window. Defaults to 30 days; windows over 7 days use hourly metrics.' },
      fullSync: { type: 'boolean', description: 'Run recent metrics/occupancy/export phases. Defaults false.' },
      backgroundDeepSync: { type: 'boolean', description: 'After the recent preload completes, start a background job for deeper supported history. Defaults true for the recommended 30-day full sync.' },
      backgroundDeepSyncDays: { type: 'number', minimum: 1, maximum: 365, description: 'Background deeper-history window. Defaults to 365 days.' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 600, description: 'Per-command timeout for explicit full sync.' },
    },
    additionalProperties: false,
  }, remoteWriteTool),
  tool('onboarding_status', 'Check Density onboarding progress, including any background deeper-history sync started by onboard_customer.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
    },
    additionalProperties: false,
  }, localReadOnlyTool),
  tool('prepare_floorplans', 'Explicitly cache floorplan geometry for one building or floor. This does not fetch historical utilization or change live text availability.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      buildingId: { type: 'string', minLength: 1, description: 'Exact building id. Use either buildingId or floorId.' },
      floorId: { type: 'string', minLength: 1, description: 'Exact floor id. Use either floorId or buildingId.' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 600, description: 'Per-command timeout. Defaults to 110 seconds.' },
    },
    additionalProperties: false,
  }, remoteWriteTool),
  tool('status', 'Report local Density configuration, safe identity, scope, sync freshness, storage size, and readiness. Use when the user asks what is configured, downloaded, current, or ready. Do not call before every analysis.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string', description: 'Explicit alternate local data directory. Omit for the host-selected customer profile.' },
    },
    additionalProperties: false,
  }, localReadOnlyTool),
  tool('historical_export', 'Export a larger customer-owned local history window to Parquet. Separate from the fast 30-day recent onboarding preload.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      orgId: { type: 'string', description: 'Optional organization id to select before exporting.' },
      days: { type: 'number', minimum: 1, maximum: 365, description: 'Historical local export window. Defaults to 90 days.' },
      until: { type: 'string', description: 'Optional end of the historical export window, e.g. now or 30d. Defaults to now.' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 3600, description: 'Per-command timeout for historical export. Defaults to 600 seconds.' },
    },
    additionalProperties: false,
  }, remoteWriteTool),
  tool('create_demo_customer', 'Create a fresh Parquet-first demo customer data dir from an existing local Density data dir.', {
    type: 'object',
    properties: {
      sourceDir: { type: 'string', description: 'Existing Density data dir with parquet files.' },
      outDir: { type: 'string', description: 'Output demo customer data dir.' },
      days: { type: 'number', minimum: 1, maximum: 60 },
    },
    additionalProperties: false,
  }, localWriteTool),
  tool('query_db', 'Use for historical workplace questions. Read density://schema directly once per question. Do not list tools or resources first, and do not reread a successful schema response. Omit dataDir so the host-selected customer profile remains authoritative. Prefer one sufficient SELECT that returns the result and its supporting evidence. Use only customer-scoped density_* tables. Do not convert missing measures to zero. The analysis object records declared provenance only; it does not prove SQL intent. If an aggregate returns zero matching counts or only null measures, report no matching evidence rather than zero use or supply. Treat a timeout or error as failure, not empty data. Use the returned evidence ID with render_chart when the user requests a chart. Omit analysis.window unless the user supplied explicit ISO dates. Do not use writes, PRAGMA, COPY, ATTACH, file reads, raw tables, or internal tables.', {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'DuckDB SELECT using only the customer-scoped density_* tables described by the Density schema resource.' },
      analysis: {
        type: 'object',
        description: 'Declared provenance context only. It helps preserve the requested interpretation but does not prove arbitrary SQL matches user intent.',
        properties: {
          scope: { type: 'string', minLength: 1, maxLength: 500 },
          window: {
            type: 'object',
            description: 'Use only when the user supplied explicit ISO dates. Otherwise omit it and return boundary aliases in the SQL result.',
            properties: {
              start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            },
            required: ['start', 'end'],
            additionalProperties: false,
          },
          population: { type: 'string', minLength: 1, maxLength: 200 },
          metric: { type: 'string', minLength: 1, maxLength: 200 },
          denominator: { type: 'string', minLength: 1, maxLength: 200 },
          timezone: { type: 'string', minLength: 1, maxLength: 100 },
          question: { type: 'string', minLength: 1, maxLength: 2000 },
        },
        additionalProperties: false,
      },
      dataDir: { type: 'string', description: 'Explicit alternate local data directory. Omit for ordinary questions so the host-selected customer profile remains authoritative.' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
    },
    required: ['sql'],
    additionalProperties: false,
  }, localReadOnlyTool),
  tool('render_chart', 'Render existing query evidence without executing DuckDB again. Before this call, resolve any material ambiguity and choose one supported Brief body with model judgment. For a clear request whose exact visualization does not fit the Brief grammar, automatically use the nearest truthful, relevant Brief chart. Use separate Brief charts when units, populations, periods, timezones, denominators, or aggregations cannot share one faithful chart. Reuse the evidence ID when it supports the related chart; run a new query only when meaning or required evidence changes. Never requery to change display formatting. For percent charts, make the query return 0–100 values before this call. Omit decimals for bars; semantic formatting handles their labels. Never use the previous renderer or a chart fallback cascade. If this call rejects the deliberate Brief declaration, stop and state the representation limit; do not retry another body. When the user does not request a count, use at most 15 displayed rows for a ranked bar chart. Keep the full result in the evidence; do not add a SQL limit. The chart states the shown and total row counts.', {
    type: 'object',
    properties: {
      evidenceId: { type: 'string', pattern: '^qe_[a-f0-9]{64}$' },
      chart: chartDeclarationInputSchema,
      dataDir: { type: 'string', description: 'Omit for ordinary requests so the host-selected customer profile remains authoritative.' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
    },
    required: ['evidenceId', 'chart'],
    additionalProperties: false,
  }, localReadOnlyTool),
  tool('configure_brand', 'Apply a customer brand to future charts. Use a local guideline file or an HTTP(S) URL. Density extracts one safe chart accent and one logo. Typography and layout rules remain unchanged.', {
    type: 'object',
    properties: {
      source: { type: 'string', minLength: 1, description: 'A local brand guideline file or an HTTP(S) URL.' },
      logo: { type: 'string', minLength: 1, description: 'Optional local or HTTP(S) PNG, JPEG, WebP, or safe SVG logo. Omit it when the HTML guideline page identifies a logo.' },
      dataDir: { type: 'string', description: 'Omit this so the host-selected customer profile remains authoritative.' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
    },
    required: ['source'],
    additionalProperties: false,
  }, remoteWriteTool),
  tool('floor_usage_report', 'Use for floorplan, map, spatial overlay, heatmap, or visual floor-usage artifact requests. Historical utilization only; live walkable availability belongs in live_wayfinding_status. Use floorId to show one floor. Use focusSpaceIds to locate result spaces without changing the historical measure.', {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Optional user prompt that requested the floorplan artifact.' },
      floorId: { type: 'string', minLength: 1, description: 'Optional exact floor space ID. The report shows only this floor.' },
      focusSpaceIds: {
        type: 'array',
        description: 'Optional exact space IDs to outline and label on the selected floor. These IDs locate evidence; they do not create a live availability claim.',
        items: { type: 'string', minLength: 1 },
        maxItems: 20,
        uniqueItems: true,
      },
      dataDir: { type: 'string' },
      outFile: { type: 'string', description: 'Optional destination HTML file. Defaults to the Density artifacts directory.' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
    },
    additionalProperties: false,
  }, localReadOnlyTool),
  tool('local_data_profile', 'Profile local customer-owned Density data readiness and freshness without using benchmark or live-feed sources.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      window: { type: 'string', description: 'Optional user-requested time window to describe coverage expectations.' },
    },
    additionalProperties: false,
  }, localReadOnlyTool),
  tool('available_buildings', 'List portfolio building readiness: live/planning status, go-live state, metric coverage, geometry, chart queryability, and live wayfinding eligibility. Do not use before a named-building live availability request.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
    },
    additionalProperties: false,
  }, localReadOnlyTool),
  tool('data_health_report', 'Use for local data readiness, freshness, missing rows, stale data, zero charts, sync gaps, and trust diagnostics for historical analytics.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      window: { type: 'string' },
    },
    additionalProperties: false,
  }, localReadOnlyTool),
  tool('live_wayfinding_status', 'Use for current, now, live, open, free, occupied, or available space questions. A uniquely resolved building is a complete scope. If a floor is unknown or ambiguous, return its clarification instead of listing the portfolio. Reads the live feed and returns liveAvailable false rather than substituting historical data.', {
    type: 'object',
    properties: {
      query: { type: 'string' },
      building: { type: 'string', description: 'Building name or ID in the selected organization. May be combined with floor.' },
      floor: { type: 'string', description: 'Floor name or ID. When building is supplied, this resolves only within that building.' },
      floorId: { type: 'string', description: 'Exact floor ID. Use floor for a natural-language floor name.' },
      dataDir: { type: 'string' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 30000 },
      maxAgeSeconds: { type: 'number', minimum: 1, maximum: 300 },
      includeFloorplan: { type: 'boolean', description: 'When true, also return a separate interactive live floorplan focused on matching spaces. Requires one exact floor.' },
    },
    required: ['query'],
    additionalProperties: false,
  }, remoteReadOnlyTool),
  tool('benchmark_compare', 'Use for benchmark, peer, cohort, percentile, or market comparison questions when an approved Density benchmark source is connected. Never returns raw peer rows.', {
    type: 'object',
    properties: {
      metric: { type: 'string' },
      cohort: { type: 'object', additionalProperties: true },
      customerMetric: { type: 'object', additionalProperties: true },
    },
    additionalProperties: false,
  }, remoteReadOnlyTool),
  tool('sensor_health_report', 'Read current cloud sensor inventory and health, or daily historical uptime for one building in the selected authorized organization. Cloud-only; no DuckDB or Parquet fallback.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      mode: { type: 'string', enum: ['current', 'history'], default: 'current' },
      building: { type: 'string', description: 'Optional building name or ID in the selected organization.' },
      floor: { type: 'string', description: 'Optional floor name or ID in the selected organization.' },
      status: { type: 'array', items: { type: 'string' }, description: 'Optional raw or normalized health statuses.' },
      sensor: { type: 'array', items: { type: 'string' }, description: 'Optional sensor serial numbers.' },
      includeSensors: { type: 'boolean', default: false, description: 'Include sensor-level rows. The default response contains aggregates.' },
      start: { type: 'string', description: 'Required RFC 3339 start instant for history mode.' },
      end: { type: 'string', description: 'Required RFC 3339 end instant for history mode.' },
      interval: { type: 'string', enum: ['day'], default: 'day', description: 'History aggregation interval.' },
      includeChart: { type: 'boolean', default: false, description: 'Include a daily line-chart preview in history mode.' },
      dataDir: { type: 'string' },
      timeoutMs: { type: 'number', minimum: 1 },
    },
    additionalProperties: false,
  }, remoteReadOnlyTool),
  tool('storage_report', 'Report DuckDB and Parquet sizes for a Density local data dir.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
    },
    additionalProperties: false,
  }, localReadOnlyTool),

];

const SCHEMA_URI = 'density://schema';
const SCHEMA_TABLES = [
  'density_atlas_spaces_flat',
  'density_local_metrics',
];
const BLOCKED_QUERY_RELATIONS = /\bdensity_(?:atlas_local|space)_metrics\b/i;
const schemaReadInstruction = 'Before calling `query_db`, read the application-controlled resource `density://schema` directly once for the question. Do not list tools or resources first.';
const systemPromptPath = new URL('../guidance/density-system-prompt.md', import.meta.url);
const schemaTextByDataDir = new Map();
const DEMO_ALLOWED_TOOLS = new Set(['query_db', 'render_chart', 'sensor_health_report']);
const demoTools = tools.filter(({ name }) => DEMO_ALLOWED_TOOLS.has(name));
const DEMO_PRIVATE_FIELDS = new Set([
  'cli',
  'dataDir',
  'stdout',
  'stderr',
  'sql',
  'executedSql',
  'declaredAnalysisContext',
]);
const DEMO_PATH_FIELDS = new Set(['artifact', 'html', 'png', 'file', 'path']);

const resources = [
  {
    uri: SCHEMA_URI,
    name: 'Density customer schema',
    description: 'Application-controlled customer-scoped Density schema from the default local data directory. Read this before calling query_db.',
    mimeType: 'application/json',
  },
];

const DEFAULT_REMOTE_MCP_URL = 'https://density-mcp-cloud-spike.preview.density.rodeo/api/mcp-full';
const REMOTE_TOKEN_ENV = 'DENSITY_CLOUD_MCP_TOKEN';

let inputBuffer = '';
let toolQueue = Promise.resolve();
let negotiatedProtocolVersion = '2025-06-18';
let sessionDemoBinding;
let sessionSourceBinding;

async function configuredDataSource(dataDir) {
  try {
    const state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    if (state.dataSource === undefined || state.dataSource === 'local') return 'local';
    if (state.dataSource === 'remote') return 'remote';
    throw new Error('The Density data source is invalid.');
  } catch (error) {
    if (error?.code === 'ENOENT') return 'local';
    throw new Error('The Density data source is unavailable.');
  }
}

async function sessionDataSource(dataDir) {
  const source = await configuredDataSource(dataDir);
  if (sessionSourceBinding === undefined) {
    sessionSourceBinding = source;
  } else if (sessionSourceBinding !== source) {
    throw new Error('The Density data source changed. Start a fresh task.');
  }
  return source;
}

async function remoteMcpResponse(message) {
  if (Object.hasOwn(message.params?.arguments ?? {}, 'dataDir')) {
    throw new Error('Remote Density uses the server-selected data source.');
  }
  const token = process.env[REMOTE_TOKEN_ENV]?.trim();
  if (!token) throw new Error(`Remote Density access requires ${REMOTE_TOKEN_ENV}.`);
  const endpoint = process.env.DENSITY_REMOTE_MCP_URL?.trim() || DEFAULT_REMOTE_MCP_URL;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Remote Density returned HTTP ${response.status}.`);
  const value = await response.json();
  if (!value || typeof value !== 'object' || value.jsonrpc !== '2.0') {
    throw new Error('Remote Density returned an invalid MCP response.');
  }
  return value;
}

async function hasDemoModeState(dataDir) {
  try {
    const state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    return Object.hasOwn(state, 'demoMode');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new Error('Demo mode status is unavailable.');
  }
}

async function sessionDemoMode(dataDir) {
  if (!(await hasDemoModeState(dataDir))) {
    const demo = { supported: true, enabled: false, generation: 'off' };
    if (sessionDemoBinding === undefined) sessionDemoBinding = 'off:off';
    return demo;
  }
  const demo = await demoModeStatus({ dataDir });
  const binding = `${demo.enabled ? 'on' : 'off'}:${demo.generation}`;
  if (sessionDemoBinding === undefined) {
    sessionDemoBinding = binding;
  } else if (sessionDemoBinding !== binding) {
    throw new Error('Demo mode changed. Start a fresh task.');
  }
  return demo;
}
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
    if (await sessionDataSource(resolveDataDir()) === 'remote') {
      sendRemoteResponse(message.id, await remoteMcpResponse(message));
      return;
    }
    if (message.method === 'initialize') {
      negotiatedProtocolVersion = message.params?.protocolVersion || '2025-06-18';
      sendResult(message.id, {
        protocolVersion: negotiatedProtocolVersion,
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: 'density', version: await pluginVersion() ?? '0.1.10' },
      });
      return;
    }
    if (message.method === 'tools/list') {
      try {
        const demo = await sessionDemoMode(resolveDataDir());
        sendResult(message.id, { tools: demo.enabled ? demoTools : tools });
      } catch {
        sendResult(message.id, { tools: [] });
      }
      return;
    }
    if (message.method === 'resources/list') {
      sendResult(message.id, { resources });
      return;
    }
    if (message.method === 'resources/read') {
      const uri = message.params?.uri;
      if (uri === SCHEMA_URI) {
        const dataDir = resolveDataDir();
        try {
          const demo = await sessionDemoMode(dataDir);
          const cacheKey = JSON.stringify({
            dataDir,
            demo: demo.enabled,
            generation: demo.generation,
            organizationId: demo.organizationId ?? null,
          });
          let text = schemaTextByDataDir.get(cacheKey);
          if (text === undefined) {
            const response = await getDbSchema({ dataDir, tables: SCHEMA_TABLES });
            if (response?.ok === false) {
              throw new Error('Density schema is not ready.');
            }
            const schema = response?.schema ?? response;
            text = JSON.stringify(schema, null, 2);
            const confirmed = await sessionDemoMode(dataDir);
            if (confirmed.enabled !== demo.enabled || confirmed.generation !== demo.generation) {
              throw new Error('Demo mode changed while the schema was loading.');
            }
            if (demo.enabled && !text.includes('demo_org')) {
              throw new Error('Demo mode did not return an aliased schema.');
            }
            schemaTextByDataDir.set(cacheKey, text);
          }
          sendResult(message.id, {
            contents: [{ uri, mimeType: 'application/json', text }],
          });
        } catch (error) {
          let demoEnabled = true;
          try {
            demoEnabled = (await sessionDemoMode(dataDir)).enabled;
          } catch {
            // Fail closed when the runtime cannot prove that Demo mode is off.
          }
          sendResult(message.id, {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(demoEnabled
                ? { ok: false, error: 'Demo mode could not provide the schema.' }
                : {
                    ok: false,
                    dataDir,
                    error: `Density schema is not ready: ${error.message || String(error)}`,
                  }, null, 2),
            }],
          });
        }
        return;
      }
      sendError(message.id, -32602, `Unknown resource URI: ${typeof uri === 'string' ? uri : ''}`);
      return;
    }
    if (message.method === 'prompts/list') {
      sendResult(message.id, {
        prompts: [{
          name: 'density',
          description: 'Use Density for a local-first workplace question.',
          arguments: [{ name: 'question', description: 'The workplace question to answer.', required: false }],
        }],
      });
      return;
    }
    if (message.method === 'prompts/get') {
      if (message.params?.name !== 'density') {
        sendError(message.id, -32602, `Unknown prompt: ${message.params?.name ?? ''}`);
        return;
      }
      const systemPrompt = await readFile(systemPromptPath, 'utf8');
      const question = String(message.params?.arguments?.question ?? '').trim();
      let demoEnabled = true;
      try {
        demoEnabled = (await sessionDemoMode(resolveDataDir())).enabled;
      } catch {
        // Do not repeat caller text when the runtime cannot prove that Demo mode is off.
      }
      sendResult(message.id, {
        description: 'Density local-first workplace analysis',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              systemPrompt,
              schemaReadInstruction,
              demoEnabled ? 'Demo mode is on. Use only the aliases from the Density schema.' : question && `User question:\n${question}`,
            ].filter(Boolean).join('\n\n'),
          },
        }],
      });
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
  let demo;
  try {
    demo = await sessionDemoMode(resolveDataDir());
  } catch {
    return demoToolError('Demo mode status is unavailable.');
  }
  if (demo.enabled && !DEMO_ALLOWED_TOOLS.has(name)) {
    return demoToolError('Demo mode allows only historical queries, chart rendering, and Demo-safe sensor health.');
  }
  if (demo.enabled && args.dataDir !== undefined) {
    return demoToolError('Demo mode uses the host-selected local profile.');
  }
  try {
    if (name === 'query_db' && BLOCKED_QUERY_RELATIONS.test(args.sql ?? '')) {
      throw new Error('Use density_local_metrics as the only metric relation for query_db.');
    }
    const result = await callToolUnchecked(name, args, demo.enabled);
    if (demo.enabled) {
      const confirmed = await sessionDemoMode(resolveDataDir());
      if (!confirmed.enabled || confirmed.generation !== demo.generation) {
        return demoToolError('Demo mode could not complete this request.');
      }
      const publicText = JSON.stringify(result);
      if (!publicText.includes('demo_org')
        || (name === 'sensor_health_report' && !publicText.includes(`\"generation\":\"${demo.generation}\"`))) {
        return demoToolError('Demo mode could not complete this request.');
      }
    }
    return result;
  } catch (error) {
    if (demo.enabled) return demoToolError('Demo mode could not complete this request.');
    throw error;
  }
}

async function callToolUnchecked(name, args, demoEnabled) {
  switch (name) {
    case 'setup':
      return structuredJsonTool(standardizeAgentResponse('setup', await setup(args)));
    case 'install_managed_cli':
      return jsonTool(await installManagedCli(args));
    case 'auth_login':
      return structuredJsonTool(standardizeAgentResponse('auth_login', await authLogin(args)));
    case 'onboard_customer':
      return structuredJsonTool(standardizeAgentResponse('onboard_customer', await onboardCustomer(args)));
    case 'onboarding_status':
      return structuredJsonTool(standardizeAgentResponse('onboarding_status', await onboardingStatus(args)));
    case 'prepare_floorplans':
      return jsonTool(await prepareFloorplans(args));
    case 'status':
      return structuredJsonTool(await status(args));
    case 'historical_export':
      return jsonTool(await historicalExport(args));
    case 'create_demo_customer':
      return jsonTool(await createDemoCustomer(args));
    case 'query_db': {
      const value = await queryDb(args);
      return demoEnabled && demoPayloadFailed(value)
        ? demoToolError('Demo mode could not complete this request.')
        : queryDbTool(value, demoEnabled, true);
    }
    case 'render_chart': {
      const value = await renderChart(args);
      return demoEnabled && demoPayloadFailed(value)
        ? demoToolError('Demo mode could not complete this request.')
        : queryDbTool(value, demoEnabled);
    }
    case 'configure_brand':
      return jsonTool(await configureBrand(args));
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
    case 'sensor_health_report': {
      const value = await sensorHealthReport(args);
      return demoEnabled && demoPayloadFailed(value)
        ? demoToolError('Demo mode could not complete this request.')
        : queryDbTool(value, demoEnabled);
    }
    case 'storage_report':
      return jsonTool(await storageReport(resolveDataDir(args.dataDir)));
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

async function createDemoCustomer(args) {
  const sourceDir = args.sourceDir || defaultDemoSourceDir();
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

function tool(name, description, inputSchema, annotations) {
  return { name, description, inputSchema, annotations };
}

function jsonTool(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

const demoPayloadFailed = (value) => value?.ok === false
  || value?.result?.state === 'error'
  || value?.result?.chart?.state === 'error'
  || value?.report?.chart?.state === 'error';

function sanitizeDemoValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeDemoValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (DEMO_PRIVATE_FIELDS.has(key)) return [];
    if (typeof child === 'string' && (DEMO_PATH_FIELDS.has(key) || path.isAbsolute(child))) return [];
    return [[key, sanitizeDemoValue(child)]];
  }));
}

async function queryDbTool(value, demoEnabled = false, usePublicEnvelope = false) {
  const publicValue = demoEnabled ? sanitizeDemoValue(value) : value;
  const modelValue = !demoEnabled && usePublicEnvelope ? publicQueryResponse(publicValue) : publicValue;
  const responseMeta = !demoEnabled && usePublicEnvelope ? queryResponseDiagnostics(value) : undefined;
  if (typeof value?.png !== 'string' || !value.png) return structuredJsonTool(modelValue, responseMeta);
  try {
    const result = structuredJsonTool(modelValue, responseMeta);
    result.content.push({ type: 'image', data: (await readFile(value.png)).toString('base64'), mimeType: 'image/png' });
    return result;
  } catch {
    const payloadKey = modelValue?.result?.chart ? 'result' : modelValue?.report?.chart ? 'report' : 'result';
    const payload = modelValue?.[payloadKey] ?? {};
    const artifacts = payload?.chart?.artifacts ?? {};
    const { png: _staleArtifactPng, ...withoutArtifactPng } = artifacts;
    return structuredJsonTool({
      ...modelValue,
      [payloadKey]: {
        ...payload,
        chart: {
          ...payload.chart,
          artifacts: withoutArtifactPng,
          png: { state: 'unavailable', reason: 'The rendered PNG file was unavailable when the MCP response was assembled.' },
        },
      },
    }, responseMeta);
  }
}

function structuredJsonTool(value, responseMeta) {
  const content = [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  return negotiatedProtocolVersion >= '2025-06-18'
    ? { ...(responseMeta ? { _meta: responseMeta } : {}), structuredContent: value, content }
    : { content };
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function demoToolError(message) {
  const payload = {
    kind: 'density.demo-error.v1',
    ok: false,
    error: message,
  };
  return { isError: true, ...structuredJsonTool(payload) };
}

function sendResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function sendRemoteResponse(id, response) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    ...(response.error ? { error: response.error } : { result: response.result }),
  })}\n`);
}
