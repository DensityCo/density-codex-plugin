#!/usr/bin/env node
import {
  defaultDemoSourceDir,
  describeFileArtifact,
  pluginVersion,
  renderHtmlPreview,
  storageReport,
} from '../scripts/density-lib.mjs';
import {
  ANALYTIC_LEARNING_LABELS,
  analyticSlide,
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
  listAnalyticLearningRecords,
  liveWayfindingStatus,
  localDataProfile,
  localUtilizationQuery,
  onboardCustomer,
  onboardingStatus,
  repairFastQuestions,
  resolveDataDir,
  reviewAnalyticLearningRecord,
  sensorHealthReport,
  setup,
  starterQuestions,
} from '../scripts/density-core.mjs';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  tool('onboard_customer', 'Prepare local Density data. Recommended full sync fetches 30 days for all locations now and can continue deeper supported history in the background.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
      orgId: { type: 'string', description: 'Optional organization id to select before syncing.' },
      days: { type: 'number', minimum: 1, maximum: 30, description: 'Recent metrics preload window. Defaults to 30 days; windows over 7 days use hourly metrics.' },
      fullSync: { type: 'boolean', description: 'Run recent metrics/occupancy/export phases. Defaults false.' },
      backgroundDeepSync: { type: 'boolean', description: 'After the recent preload completes, start a background job for deeper supported history. Defaults true for the recommended 30-day full sync.' },
      backgroundDeepSyncDays: { type: 'number', minimum: 1, maximum: 365, description: 'Background deeper-history window. Defaults to 365 days.' },
      prewarmQuestions: { type: 'boolean', description: 'After full sync, precompute starter-question answers and chart artifacts when supported. Defaults true.' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 600, description: 'Per-command timeout for explicit full sync.' },
    },
    additionalProperties: false,
  }),
  tool('onboarding_status', 'Check Density onboarding progress, including any background deeper-history sync started by onboard_customer.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string' },
    },
    additionalProperties: false,
  }),
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
  tool('answer_density_question', 'Default front door for ordinary Density questions. Pass the user question verbatim. Do not add metrics, freshness checks, time windows, operating hours, exclusions, or other requirements the user did not state. Use before narrower tools, especially for broad prompts like "pick any building" or "compare any one site"; routes internally through historical, live wayfinding, floorplan, data health, or sensor health surfaces. Treat orchestration.terminal as final for the current turn: deliver complete results immediately, or ask exactly one question and wait when awaitingUser is true. Do not retry with another Density tool. Do not use shell, DuckDB, SQL, manual CLI commands, or hand-built chart scripts for ordinary questions.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      dataDir: { type: 'string', description: 'Density local data dir. Defaults to DENSITY_CLI_DATA_DIR or ~/.density-cli.' },
      intentHint: { type: 'string', description: 'Optional caller hint such as historical, live, floorplan, data-health, or sensor-health. The router still validates from the question.' },
      presentation: { type: 'string', enum: ['slide', 'broadsheet'], description: 'Defaults to the validated fixed slide. Use broadsheet for the classic editorial chart variant.' },
      clarificationAnswer: { type: 'string', description: 'User answer to a prior clarification. Resumes the original question without discovery or manual fallback.' },
      theme: { type: 'string', description: 'Optional render-time theme: a named theme id, preset, or #hex brand accent.' },
    },
    required: ['question'],
    additionalProperties: false,
  }),
  tool('ask_chart', 'Compatibility-only. Use for legacy chart artifact callers that already expect ask_chart output; prefer answer_density_question or local_utilization_query for ordinary Density questions.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      dataDir: { type: 'string' },
      presentation: { type: 'string', enum: ['slide', 'broadsheet'], description: 'Defaults to the classic Broadsheet chart. Use slide for the validated fixed-slide layout.' },
    },
    required: ['question'],
    additionalProperties: false,
  }),
  tool('analytic_slide', 'Use when the user asks for a slide or presentation-ready Density answer. Returns only the validated analytic slide summary, file path, and panel target.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      dataDir: { type: 'string', description: 'Density local data dir. Defaults to DENSITY_CLI_DATA_DIR or ~/.density-cli.' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000, description: 'Shared wall-time deadline for capability discovery and slide generation. Defaults to 30000ms.' },
      theme: { type: 'string', description: 'Optional render-time theme: a named theme id, preset, or #hex brand accent.' },
    },
    required: ['question'],
    additionalProperties: false,
  }),
  tool('analytic_learning_records', 'List private reviewable Density analytic examples and their current customer feedback or quality labels.', {
    type: 'object',
    properties: {
      dataDir: { type: 'string', description: 'Density local data dir containing the private analytic learning store.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Maximum records to return, newest first. Defaults to 25.' },
      offset: { type: 'integer', minimum: 0, default: 0, description: 'Zero-based record offset. Defaults to 0.' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
    },
    additionalProperties: false,
  }),
  tool('review_analytic_learning', 'Add customer context, a final interpretation, or an exact quality label to a Density analytic learning record without rewriting history.', {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^lr_[0-9a-fA-F-]{36}$' },
      answer: { type: 'string', minLength: 1, maxLength: 10000 },
      interpretation: { type: 'string', minLength: 1, maxLength: 10000 },
      label: { type: 'string', enum: ANALYTIC_LEARNING_LABELS },
      dataDir: { type: 'string', description: 'Density local data dir containing the private analytic learning store.' },
      timeoutMs: { type: 'number', minimum: 1, maximum: 120000 },
    },
    required: ['id'],
    additionalProperties: false,
  }),
  tool('local_utilization_query', 'Use for historical utilization, trends, rankings, busiest/least-used spaces, and local customer-owned analytics when the scope is already clear. For broad "any building/site" prompts, use answer_density_question first. Do not use for live availability, sensor health, benchmark peer context, shell, DuckDB, SQL, or manual Parquet fallbacks.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      dataDir: { type: 'string' },
      presentation: { type: 'string', enum: ['slide', 'broadsheet'], description: 'Defaults to the validated fixed slide. Use broadsheet for the classic editorial chart variant.' },
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
      question: { type: 'string' },
      dataDir: { type: 'string' },
      timeoutMs: { type: 'number', minimum: 1 },
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
let negotiatedProtocolVersion = '2025-06-18';
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
      negotiatedProtocolVersion = message.params?.protocolVersion || '2025-06-18';
      sendResult(message.id, {
        protocolVersion: negotiatedProtocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'density', version: await pluginVersion() ?? '0.1.10' },
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
    case 'onboarding_status':
      return jsonTool(await onboardingStatus(args));
    case 'historical_export':
      return jsonTool(await historicalExport(args));
    case 'create_demo_customer':
      return jsonTool(await createDemoCustomer(args));
    case 'answer_density_question':
      return nativeSlideTool(await answerDensityQuestion(args), { compactOrdinary: true });
    case 'ask_chart':
      return nativeSlideTool(await askChart(args));
    case 'analytic_slide':
      return nativeSlideTool(await analyticSlide(args));
    case 'analytic_learning_records':
      return jsonTool(await listAnalyticLearningRecords(args));
    case 'review_analytic_learning':
      return jsonTool(await reviewAnalyticLearningRecord(args));
    case 'local_utilization_query':
      return nativeSlideTool(await localUtilizationQuery(args));
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

function tool(name, description, inputSchema) {
  return { name, description, inputSchema };
}

function jsonTool(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function structuredJsonTool(value) {
  const content = [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  return negotiatedProtocolVersion >= '2025-06-18' ? { structuredContent: value, content } : { content };
}

const NATIVE_SLIDE_DELIVERY_CONTRACT = 'density.native-slide-delivery.v1';
const MAX_INLINE_PREVIEW_BYTES = 8 * 1024 * 1024;

const analyticSlideTarget = (value) => value?.panelTarget?.kind === 'analytic-slide'
  && value.panelTarget.contract === 'density.panel-target.v1'
  && typeof value.panelTarget.path === 'string'
  ? value.panelTarget
  : undefined;

const compactEvidenceReferences = (value) => {
  const fields = [
    'analyticArtifactFile',
    'analyticReceiptFile',
    'analyticLocalEvidenceFile',
    'analyticSensorEvidenceFile',
    'analyticBenchmarkEvidenceFile',
  ];
  const references = {};
  for (const field of fields) {
    const candidate = value[field] ?? value.analytic?.[field];
    if (typeof candidate === 'string') references[field] = candidate;
  }
  return Object.keys(references).length > 0 ? references : undefined;
};

const compactTrustContext = (value) => {
  const trust = value?.trustContext;
  if (!trust || typeof trust !== 'object') return undefined;
  return {
    contract: trust.contract,
    validationState: trust.validationState,
    confidence: trust.confidence,
    responseMode: trust.responseMode,
    gates: trust.gates,
    dataProvenance: trust.dataProvenance,
    source: trust.source,
    methodology: trust.methodology,
    limitations: trust.limitations,
    runtimeVersion: trust.runtimeVersion,
    liveArchetypes: trust.liveArchetypes,
    evidenceReceipt: trust.evidenceReceipt
      ? {
          contract: trust.evidenceReceipt.contract,
          generated_by: trust.evidenceReceipt.generated_by,
          artifact_sha256: trust.evidenceReceipt.artifact_sha256,
          presentation_sha256: trust.evidenceReceipt.presentation_sha256,
        }
      : undefined,
  };
};

const compactAnalyticArtifact = (artifact) => {
  if (!artifact || typeof artifact !== 'object') return undefined;
  const rankedChartData = artifact.chart_type === 'ranked_bars_variability'
    && artifact.chart_data && typeof artifact.chart_data === 'object'
    ? {
        archetype: artifact.chart_data.archetype,
        unit: artifact.chart_data.unit,
        interval_percent: artifact.chart_data.interval_percent,
        entities: Array.isArray(artifact.chart_data.entities)
          ? artifact.chart_data.entities.map((entity) => ({
              name: entity.name,
              median: entity.median,
              interval_low: entity.interval_low,
              interval_high: entity.interval_high,
              state: entity.state,
            }))
          : undefined,
      }
    : undefined;
  return {
    confidence: artifact.confidence,
    response_mode: artifact.response_mode,
    headline: artifact.headline,
    subtitle: artifact.subtitle,
    metric_name: artifact.metric_name,
    metric_value: artifact.metric_value,
    metric_unit: artifact.metric_unit,
    denominator: artifact.denominator,
    analysis_period: artifact.analysis_period,
    population: artifact.population,
    chart_type: artifact.chart_type,
    chart_data: rankedChartData,
    benchmark: artifact.benchmark,
  };
};

const compactClarification = (value) => {
  const clarification = value?.kind === 'density.clarification_request.v1'
    ? value
    : value?.clarificationRequest;
  if (!clarification || clarification.contract !== 'density.clarification') return undefined;
  return {
    kind: clarification.kind,
    contract: clarification.contract,
    reason: clarification.reason,
    question: clarification.question ?? value.question,
    prompt: clarification.prompt ?? value.prompt ?? value.message,
    requiredChoiceCount: clarification.requiredChoiceCount ?? 1,
    suggestions: Array.isArray(clarification.suggestions) ? clarification.suggestions.slice(0, 8) : [],
    candidates: Array.isArray(clarification.candidates) ? clarification.candidates.slice(0, 8) : undefined,
    freeform: clarification.freeform,
    responseSemantics: clarification.responseSemantics,
  };
};

const questionOrchestration = (value) => {
  const clarification = compactClarification(value);
  if (clarification) {
    return {
      state: 'clarification_required',
      terminal: true,
      retryable: false,
      awaitingUser: true,
      continuation: {
        tool: 'answer_density_question',
        originalQuestion: value.question,
        requires: ['clarificationAnswer'],
      },
    };
  }
  if (value?.ok) {
    return { state: 'complete', terminal: true, retryable: false, awaitingUser: false };
  }
  return { state: 'blocked', terminal: true, retryable: false, awaitingUser: false };
};

const compactQuestionResult = (value) => {
  const clarification = compactClarification(value);
  const artifact = value?.analytic?.artifact;
  return {
    ok: Boolean(value?.ok),
    tool: value?.tool,
    entrypoint: value?.entrypoint,
    question: value?.question,
    title: value?.title,
    headline: artifact?.headline ?? value?.headline ?? value?.title,
    subtitle: artifact?.subtitle ?? value?.subtitle,
    message: value?.message,
    intent: value?.intent,
    routedTool: value?.routedTool,
    routing: value?.routing,
    sourceLayer: value?.sourceLayer,
    sourceBadge: value?.sourceBadge,
    provenance: value?.provenance,
    freshness: value?.freshness,
    confidence: value?.confidence,
    caveats: value?.caveats,
    rows: Array.isArray(value?.rows)
      ? value.rows.slice(0, 12).map(({ label, value: rowValue, detail }) => ({ label, value: rowValue, detail }))
      : undefined,
    analytic: artifact ? { artifact: compactAnalyticArtifact(artifact) } : undefined,
    clarificationRequest: clarification,
    orchestration: questionOrchestration(value),
    retryBudget: value?.retryBudget,
    error: value?.error,
  };
};

const compactSlideResult = (value, slideDelivery) => {
  const artifact = value.analytic?.artifact;
  const delivered = slideDelivery.status === 'delivered' ? 'slide' : 'none';
  const priorDelivery = value.presentationDelivery ?? {};
  const presentationDelivery = {
    ...priorDelivery,
    requested: 'slide',
    generated: 'slide',
    delivered,
    slideSupported: true,
    attachmentContract: NATIVE_SLIDE_DELIVERY_CONTRACT,
    ...(delivered === 'slide'
      ? { reason: undefined }
      : { reason: slideDelivery.reason ?? 'The generated slide could not be attached to this response.' }),
  };
  if (presentationDelivery.reason === undefined) delete presentationDelivery.reason;
  return {
    ok: Boolean(value.ok),
    tool: value.tool,
    entrypoint: value.entrypoint,
    question: value.question,
    headline: artifact?.headline ?? value.headline ?? value.title,
    subtitle: artifact?.subtitle ?? value.subtitle,
    confidence: artifact?.confidence ?? value.confidence,
    analyticState: value.analyticState,
    validationState: value.validationState ?? value.trustContext?.validationState,
    requestedMode: 'slide',
    generatedMode: 'slide',
    deliveredMode: delivered,
    deliveryState: delivered === 'slide' ? 'delivered' : 'generated',
    presentationDelivery,
    slidePath: value.slidePath ?? value.analytic?.slideFile,
    dataDir: value.dataDir,
    intent: value.intent,
    routedTool: value.routedTool,
    routing: value.routing,
    sourceLayer: value.sourceLayer,
    sourceBadge: value.sourceBadge,
    provenance: value.provenance,
    freshness: value.freshness,
    cache: value.cache,
    analytic: artifact ? { artifact: compactAnalyticArtifact(artifact) } : undefined,
    panelTarget: value.panelTarget,
    slideDelivery,
    trustContext: compactTrustContext(value),
    evidenceReceipt: value.evidenceReceipt ?? value.trustContext?.evidenceReceipt,
    gates: value.analytic?.gates ?? value.trustContext?.gates,
    dataProvenance: artifact?.data_provenance ?? value.trustContext?.dataProvenance,
    evidenceFiles: compactEvidenceReferences(value),
    learningRecordId: value.learningRecordId,
    learningWarning: value.learningWarning,
    orchestration: questionOrchestration(value),
  };
};

async function nativeSlideTool(value, options = {}) {
  const panelTarget = analyticSlideTarget(value);
  if (!panelTarget) return options.compactOrdinary ? structuredJsonTool(compactQuestionResult(value)) : jsonTool(value);

  let html;
  try {
    html = await describeFileArtifact(panelTarget.path, 'text/html');
  } catch (error) {
    const slideDelivery = {
      contract: NATIVE_SLIDE_DELIVERY_CONTRACT,
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
    const structuredContent = compactSlideResult(value, slideDelivery);
    const content = [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }];
    return negotiatedProtocolVersion >= '2025-06-18'
      ? { structuredContent, content }
      : { content };
  }

  const preview = await renderHtmlPreview(panelTarget.path, { timeoutMs: 10000 });
  let inlinePreview;
  if (preview.status === 'available' && preview.artifact.bytes <= MAX_INLINE_PREVIEW_BYTES) {
    inlinePreview = await readFile(preview.artifact.path);
  }
  const supportsResourceLinks = negotiatedProtocolVersion >= '2025-06-18';
  const delivered = supportsResourceLinks || Boolean(inlinePreview);
  const slideDelivery = {
    contract: NATIVE_SLIDE_DELIVERY_CONTRACT,
    status: delivered ? 'delivered' : 'generated',
    ...(!delivered
      ? { reason: 'This MCP client cannot receive the canonical HTML link, and no PNG preview was available.' }
      : {}),
    canonical: html,
    preview: preview.status === 'available'
      ? {
          ...preview,
          inline: Boolean(inlinePreview),
          ...(inlinePreview ? {} : { reason: 'The PNG preview is too large to attach inline.' }),
        }
      : preview,
  };
  const structuredContent = compactSlideResult(value, slideDelivery);
  const headline = structuredContent.headline || 'Density analytic slide';
  const content = [
    { type: 'text', text: JSON.stringify(structuredContent, null, 2) },
    ...(inlinePreview
      ? [{
          type: 'image',
          data: inlinePreview.toString('base64'),
          mimeType: 'image/png',
          _meta: {
            'density/sha256': preview.artifact.sha256,
            'density/width': 1920,
            'density/height': 1080,
            'density/canonicalHtmlSha256': html.sha256,
          },
        }]
      : []),
    ...(supportsResourceLinks
      ? [{
          type: 'resource_link',
          name: path.basename(html.path),
          title: headline,
          uri: html.url,
          description: 'Canonical Density analytic slide (1920x1080 HTML).',
          mimeType: 'text/html',
          size: html.bytes,
          _meta: {
            'density/sha256': html.sha256,
            'density/presentation': 'slide',
          },
        }]
      : []),
  ];
  return supportsResourceLinks
    ? { structuredContent, content }
    : { content };
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
