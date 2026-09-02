import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import {
  checkPluginUpdate,
  defaultDataDir,
  defaultDemoSourceDir,
  discoverCliCapabilities,
  ensureDensityCliBuilt,
  fileExists,
  installManagedCliRuntime,
  loadManagedCliManifest,
  localDataProfileReport,
  managedCliRuntimeStatus,
  missingRequiredCliCapabilities,
  renderHtmlPreview,
  renderPng,
  resolveDensityCli,
  runDensity,
  safeCliInfo,
  storageReport,
  which,
} from './density-lib.mjs';

export const DEFAULT_METRICS_DAYS = 30;
export const MAX_METRICS_DAYS = 30;
export const MAX_15M_METRICS_DAYS = 7;
export const DEFAULT_HISTORICAL_EXPORT_DAYS = 90;
export const MAX_HISTORICAL_EXPORT_DAYS = 365;
export const DEFAULT_BACKGROUND_DEEP_SYNC_DAYS = MAX_HISTORICAL_EXPORT_DAYS;

export const resolveDataDir = (value) => value || process.env.DENSITY_CLI_DATA_DIR || defaultDataDir();
const availableBuildingsSupported = (capabilities) => Boolean(capabilities.commands?.availableBuildings || capabilities.availableBuildings);
const onboardingStateDir = (dataDir) => path.join(dataDir, 'onboarding');
const deepSyncStatusFile = (dataDir) => path.join(onboardingStateDir(dataDir), 'deep-history-sync.json');

const SOURCE_LAYERS = {
  localCustomerData: 'local_customer_data',
  mixedLocalBenchmark: 'mixed_local_benchmark',
  benchmarkNetworkContext: 'benchmark_network_context',
  liveFeed: 'live_feed',
  cloudSensorHealth: 'cloud_sensor_health',
};
const SOURCE_BADGES = {
  [SOURCE_LAYERS.localCustomerData]: 'Local',
  [SOURCE_LAYERS.mixedLocalBenchmark]: 'Mixed',
  [SOURCE_LAYERS.benchmarkNetworkContext]: 'Benchmark',
  [SOURCE_LAYERS.liveFeed]: 'Live',
  [SOURCE_LAYERS.cloudSensorHealth]: 'Live',
};

const oneLine = (value) => String(value ?? '').trim();
const DERIVED_DATASET_NAME = 'local_metrics';
const MAINTAIN_LOCAL_METRICS_ARGS = ['maintain', 'local-metrics', '--format', 'json'];
const derivedDatasetRepairsStarted = new Set();

const unknownDerivedDataset = (reason) => ({ name: DERIVED_DATASET_NAME, state: 'unknown', reason });

const derivedDatasetState = async ({ dataDir, timeoutMs = 10000 }) => {
  const cli = await resolveDensityCli();
  if (!cli) return unknownDerivedDataset('Density CLI not found.');
  const capabilities = await discoverCliCapabilities(cli, { dataDir });
  if (!capabilities.commands?.maintainLocalMetrics) {
    return unknownDerivedDataset('This Density CLI does not report the derived dataset state.');
  }
  const result = await runDensity(cli, [...MAINTAIN_LOCAL_METRICS_ARGS, '--check'], { dataDir, allowFailure: true, timeoutMs });
  if (result.code !== 0 || result.timedOut) {
    return unknownDerivedDataset(result.timedOut ? 'The derived dataset check timed out.' : oneLine(result.stderr || result.stdout));
  }
  try {
    return JSON.parse(result.stdout).after;
  } catch (error) {
    return unknownDerivedDataset(`The derived dataset check was not JSON: ${error.message}`);
  }
};

const freshnessState = async ({ dataDir, timeoutMs = 10000 }) => {
  const cli = await resolveDensityCli();
  if (!cli) return { state: 'unavailable', policy: { streams: {} }, streams: [] };
  const capabilities = await discoverCliCapabilities(cli, { dataDir, timeoutMs });
  if (!capabilities.commands?.freshnessStatus) {
    return { state: 'unavailable', policy: { streams: {} }, streams: [] };
  }
  const result = await runDensity(cli, ['freshness-status', '--format', 'json'], {
    dataDir,
    allowFailure: true,
    timeoutMs,
  });
  if (result.code !== 0 || result.timedOut) {
    return { state: 'unavailable', policy: { streams: {} }, streams: [] };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return { state: 'available', policy: parsed.policy, streams: parsed.streams };
  } catch {
    return { state: 'unavailable', policy: { streams: {} }, streams: [] };
  }
};

// Starts one detached `density maintain local-metrics` per data directory and server process.
const startDerivedDatasetRepair = ({ cli, capabilities, dataDir, derivedDataset }) => {
  if (!isRecord(derivedDataset) || derivedDataset.state === 'current' || derivedDataset.state === 'unknown') return undefined;
  if (process.env.DENSITY_DISABLE_BACKGROUND_REFRESH === '1') {
    return { started: false, reason: 'DENSITY_DISABLE_BACKGROUND_REFRESH=1 disables the background repair.' };
  }
  if (!capabilities.commands?.maintainLocalMetrics) {
    return { started: false, reason: 'This Density CLI does not support density maintain local-metrics.' };
  }
  if (derivedDatasetRepairsStarted.has(dataDir)) {
    return { started: false, reason: 'A repair already started in this server process.' };
  }
  derivedDatasetRepairsStarted.add(dataDir);
  const child = spawn(cli.command, [...cli.args, ...MAINTAIN_LOCAL_METRICS_ARGS], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DENSITY_CLI_DATA_DIR: dataDir },
  });
  child.on('error', () => {});
  child.unref();
  return { started: true, command: ['density', ...MAINTAIN_LOCAL_METRICS_ARGS].join(' '), pid: child.pid };
};
const sourceBadgeFor = (sourceLayer) => SOURCE_BADGES[sourceLayer] ?? 'Mixed';
const nowIso = () => new Date().toISOString();
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const QUERY_ANALYSIS_FIELDS = ['scope', 'window', 'population', 'metric', 'denominator', 'timezone', 'question'];
const QUERY_ANALYSIS_STRING_LIMITS = {
  scope: 500,
  population: 200,
  metric: 200,
  denominator: 300,
  timezone: 100,
  question: 2000,
};
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const validIsoDate = (value) => {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : undefined;
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
};

const validateQueryAnalysisString = (field, value) => {
  if (typeof value !== 'string') throw new Error(`analysis.${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`analysis.${field} must not be empty.`);
  if (trimmed.length > QUERY_ANALYSIS_STRING_LIMITS[field]) {
    throw new Error(`analysis.${field} must be ${QUERY_ANALYSIS_STRING_LIMITS[field]} characters or fewer.`);
  }
  return value;
};

export const validateQueryAnalysis = (analysis) => {
  if (analysis === undefined) return undefined;
  if (!isRecord(analysis)) throw new Error('analysis must be an object when provided.');
  const unknownFields = Object.keys(analysis).filter((field) => !QUERY_ANALYSIS_FIELDS.includes(field));
  if (unknownFields.length > 0) {
    throw new Error(`analysis contains unsupported field(s): ${unknownFields.join(', ')}.`);
  }

  const validated = {};
  for (const field of QUERY_ANALYSIS_FIELDS) {
    if (field === 'window' || !Object.hasOwn(analysis, field)) continue;
    validated[field] = validateQueryAnalysisString(field, analysis[field]);
  }
  if (Object.hasOwn(analysis, 'window')) {
    if (!isRecord(analysis.window) || Object.keys(analysis.window).length !== 2
      || !Object.hasOwn(analysis.window, 'start') || !Object.hasOwn(analysis.window, 'end')) {
      throw new Error('analysis.window must contain only start and end ISO dates.');
    }
    for (const edge of ['start', 'end']) {
      if (!validIsoDate(analysis.window[edge])) {
        throw new Error(`analysis.window.${edge} must be a valid ISO date in YYYY-MM-DD format.`);
      }
    }
    if (analysis.window.start > analysis.window.end) {
      throw new Error('analysis.window.start must be on or before analysis.window.end.');
    }
    validated.window = { start: analysis.window.start, end: analysis.window.end };
  }
  return validated;
};

const readJsonFile = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
};

const writeJsonFile = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempFile, file);
};

const latestDeepSyncStatus = async (dataDir) => {
  const statusFile = deepSyncStatusFile(dataDir);
  const status = await readJsonFile(statusFile);
  return status ? { ...status, statusFile } : undefined;
};

const startBackgroundDeepSync = async ({ dataDir, orgId, days, recentDays }) => {
  const statusFile = deepSyncStatusFile(dataDir);
  const startedAt = nowIso();
  const job = {
    kind: 'density.onboarding.deep-history-sync',
    jobId: `deep-history-${Date.now()}`,
    status: 'running',
    mode: 'historical-export',
    scope: { type: 'all_locations' },
    days,
    recentDays,
    dataDir,
    statusFile,
    startedAt,
    updatedAt: startedAt,
    note: 'Background sync uses the Density CLI historical export path, which splits Data Access API observation requests at UTC calendar-month boundaries.',
  };
  await writeJsonFile(statusFile, job);

  const script = new URL('./density-background-deep-sync.mjs', import.meta.url).pathname;
  const child = spawn(process.execPath, [
    script,
    '--data-dir', dataDir,
    '--days', String(days),
    '--recent-days', String(recentDays),
    '--status-file', statusFile,
    ...(orgId ? ['--org', orgId] : []),
  ], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const withPid = { ...job, pid: child.pid };
  await writeJsonFile(statusFile, withPid);
  return withPid;
};

const sensorSubjectIntent = (question) =>
  /\b(sensor(?:s)?|sensor[-\s]?health|live signal|presence signal|health of (?:the )?sensor|signal stale|stale signal)\b/i.test(question);

const historicalSensorUtilizationIntent = (question) =>
  /\b(historical|history|trend|over time|last|past|yesterday|weeks?|months?|quarters?|years?)\b/i.test(question)
  && /\b(utili[sz](?:e|ed|ation)|occupancy|occupied|usage|performance|busiest|least used|underused)\b/i.test(question);

const sensorHealthIntent = (question) => {
  if (historicalSensorUtilizationIntent(question)) return false;
  const healthOrStatus = /\b(health|healthy|unhealthy|status|online|offline|error|errors|unconfigured|heartbeat|heartbeats|reporting|stale|degraded|mapping|mapped|attention|operational readiness|live signal|presence signal)\b/i.test(question);
  return sensorSubjectIntent(question) && healthOrStatus;
};

const floorplanRouteResponse = ({ question, dataDir, liveIntent = false }) => ({
  ok: false,
  unsupported: true,
  question,
  intent: liveIntent ? 'live_wayfinding_floorplan' : 'floorplan_artifact',
  routedSkill: liveIntent ? 'wayfinding' : 'floorplan',
  routedTool: liveIntent ? 'live_wayfinding_status' : undefined,
  sourceLayer: liveIntent ? SOURCE_LAYERS.liveFeed : SOURCE_LAYERS.localCustomerData,
  sourceBadge: sourceBadgeFor(liveIntent ? SOURCE_LAYERS.liveFeed : SOURCE_LAYERS.localCustomerData),
  artifactRequired: 'floorplan',
  chartSuppressed: true,
  dataDir,
  message: liveIntent
    ? 'This needs live wayfinding on a floorplan, not a cached utilization chart.'
    : 'This needs a floorplan artifact, not a generic cached chart.',
  fallback: liveIntent
    ? 'Historical utilization can be context only; it is not a walkable recommendation.'
    : 'A generic chart can be context only; it does not replace the requested floorplan artifact.',
  nextAction: {
    id: liveIntent ? 'use_live_wayfinding_floorplan' : 'use_floorplan_workflow',
    label: liveIntent
      ? 'Use live Density wayfinding with a floorplan artifact.'
      : 'Use the Density floorplan workflow for a spatial artifact.',
  },
  userVisiblePrimaryActions: 1,
});

const safeWayfindingName = (space) =>
  space?.name ?? space?.displayName ?? space?.label ?? space?.spaceName ?? space?.roomName;

const spaceAvailabilityState = (space) => {
  if (typeof space?.availabilityStatus === 'string') return space.availabilityStatus;
  if (space?.available === true) return 'available';
  if (space?.occupied === true) return 'occupied';
  if (space?.available === false) return 'unavailable';
  return space?.availability ?? space?.status ?? space?.state ?? 'unknown';
};

const wayfindingSpaces = (parsed) => {
  if (Array.isArray(parsed?.spaces)) return parsed.spaces;
  if (Array.isArray(parsed?.candidates) || Array.isArray(parsed?.unavailableMatches)) {
    return [
      ...(Array.isArray(parsed?.candidates) ? parsed.candidates : []),
      ...(Array.isArray(parsed?.unavailableMatches) ? parsed.unavailableMatches : []),
    ];
  }
  const result = parsed?.result;
  return [
    ...(Array.isArray(result?.candidates) ? result.candidates : []),
    ...(Array.isArray(result?.unavailableMatches) ? result.unavailableMatches : []),
  ];
};

const compactWayfindingSummary = (parsed) => {
  const spaces = wayfindingSpaces(parsed);
  const derivedCounts = spaces.reduce((acc, space) => {
    const state = String(spaceAvailabilityState(space)).toLowerCase();
    if (state === 'available' || state === 'free' || state === 'vacant') acc.available += 1;
    else if (state === 'occupied') acc.occupied += 1;
    else if (state === 'unavailable') acc.unavailable += 1;
    else if (state === 'stale') acc.stale += 1;
    else acc.unknown += 1;
    return acc;
  }, { available: 0, occupied: 0, unavailable: 0, unknown: 0, stale: 0 });
  const counts = parsed?.counts && typeof parsed.counts === 'object'
    ? parsed.counts
    : derivedCounts;
  const namedSpaces = spaces
    .map((space) => {
      const name = safeWayfindingName(space);
      return name ? {
        name,
        floorName: space?.floorName,
        buildingName: space?.buildingName,
        state: spaceAvailabilityState(space),
        occupied: typeof space?.occupied === 'boolean' ? space.occupied : undefined,
        observedAt: space?.observedAt,
        receivedAt: space?.receivedAt,
        healthStatus: space?.healthStatus,
      } : undefined;
    })
    .filter(Boolean);
  return {
    availabilityMode: parsed?.availabilityMode,
    elapsedMs: Number.isFinite(parsed?.elapsedMs) ? parsed.elapsedMs : undefined,
    spacesChecked: Number.isFinite(parsed?.checkedSpaceCount) ? parsed.checkedSpaceCount : spaces.length,
    floorsChecked: Number.isFinite(parsed?.checkedFloorCount) ? parsed.checkedFloorCount : undefined,
    counts,
    spaces: namedSpaces.length ? namedSpaces : undefined,
  };
};

const parseJsonOutput = (stdout, label) => {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} was not JSON: ${error.message}`);
  }
};

const validatedQuestionUiSource = (answerProps) => {
  const sourceLayer = answerProps.sourceLayer ?? SOURCE_LAYERS.localCustomerData;
  if (!Object.values(SOURCE_LAYERS).includes(sourceLayer)) {
    throw new Error('Density UI response used an unsupported source layer.');
  }
  const expectedBadge = sourceBadgeFor(sourceLayer);
  const sourceBadge = answerProps.sourceBadge ?? expectedBadge;
  if (sourceBadge !== expectedBadge) {
    throw new Error('Density UI response used an inconsistent source badge.');
  }
  const sourceLabel = typeof answerProps.sourceLabel === 'string' && answerProps.sourceLabel.trim()
    ? answerProps.sourceLabel.trim()
    : undefined;
  return { sourceLayer, sourceBadge, sourceLabel };
};

const publicQuestionSnapshot = (snapshot) => {
  const states = new Set(['fresh', 'stale', 'unknown']);
  const scopes = new Set(['all_spaces', 'per_space', 'unavailable']);
  const refreshStates = new Set(['not_needed', 'started', 'in_progress', 'unavailable', 'unsupported']);
  const refresh = snapshot?.backgroundRefresh;
  if (snapshot?.contract !== 'density.local-question-snapshot.v1'
    || snapshot?.source !== SOURCE_LAYERS.localCustomerData
    || snapshot?.live !== false
    || !states.has(snapshot?.state)
    || !scopes.has(snapshot?.scope)
    || !Number.isFinite(snapshot?.staleAfterMs)
    || !refreshStates.has(refresh?.state)) {
    return undefined;
  }
  return {
    contract: snapshot.contract,
    source: snapshot.source,
    live: false,
    state: snapshot.state,
    scope: snapshot.scope,
    staleAfterMs: snapshot.staleAfterMs,
    ...(typeof snapshot.lastSyncAt === 'string' ? { lastSyncAt: snapshot.lastSyncAt } : {}),
    ...(Number.isFinite(snapshot.ageMs) ? { ageMs: snapshot.ageMs } : {}),
    ...(typeof snapshot.interval === 'string' ? { interval: snapshot.interval } : {}),
    backgroundRefresh: {
      state: refresh.state,
      ...(typeof refresh.reason === 'string' ? { reason: refresh.reason } : {}),
    },
  };
};

const questionUiProvenance = ({ dataDir, tool, sourceLayer, sourceBadge, sourceLabel, freshness }) => {
  if (sourceLayer === SOURCE_LAYERS.localCustomerData) {
    return localHistoricalProvenance({ dataDir, tool });
  }
  if (sourceLayer === SOURCE_LAYERS.mixedLocalBenchmark) {
    return {
      ...localHistoricalProvenance({ dataDir, tool }),
      sourceLayer,
      sourceBadge,
      sourceLabel,
      freshness,
      caveat: 'Customer-owned historical rows come from local Parquet; the comparison uses an approved display-safe Density benchmark scorecard.',
    };
  }
  const caveat = sourceLayer === SOURCE_LAYERS.cloudSensorHealth
    ? 'Sensor status comes from the complete Density cloud response; local metadata is used only for lifecycle-safe location mapping.'
    : 'This answer uses a non-local Density source selected by the CLI question contract.';
  return { sourceLayer, sourceBadge, sourceLabel, tool, freshness, caveat };
};

const parseQuestionUiAnswer = async ({ question, dataDir, cli, result, tool, renderTimeoutMs }) => {
  const ui = parseJsonOutput(result.stdout, 'Density UI response');
  if (ui?.clarificationRequest !== undefined) {
    const clarificationRequest = ui.clarificationRequest;
    if (!isRecord(clarificationRequest)
      || clarificationRequest.kind !== 'density.clarification_request.v1'
      || clarificationRequest.contract !== 'density.clarification') {
      throw new Error('Density UI clarificationRequest did not match the density.clarification contract.');
    }
    return {
      ok: false,
      ...clarificationRequest,
      clarificationRequest,
      originalQuestion: question,
      sourceLayer: SOURCE_LAYERS.localCustomerData,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
      provenance: localHistoricalProvenance({ dataDir, tool }),
      chartSuppressed: true,
      dataDir,
      cli: safeCliInfo(cli),
    };
  }

  const answerProps = ui.jsonRender?.spec?.elements?.answer?.props ?? {};
  const state = ui.jsonRender?.spec?.state ?? {};
  const source = validatedQuestionUiSource(answerProps);
  const snapshot = publicQuestionSnapshot(ui.snapshot);
  const { snapshot: _privateSnapshot, analytic: _legacyAnalytic, panelTarget: _legacyPanelTarget, ...publicUi } = ui;
  const chart = ui.artifacts?.svg ?? state.artifacts?.svg;
  const html = ui.artifacts?.html ?? state.artifacts?.html;
  const pngStartedAt = Date.now();
  const png = await renderPng(chart, { timeoutMs: renderTimeoutMs });

  return {
    ok: true,
    ...source,
    provenance: questionUiProvenance({
      dataDir,
      tool,
      ...source,
      freshness: answerProps.freshness ?? state.freshness,
    }),
    question,
    scopeResolution: answerProps.scopeResolution ?? state.scopeResolution,
    title: answerProps.title ?? '',
    subtitle: answerProps.subtitle ?? '',
    chart,
    html,
    png,
    cache: ui.cache,
    rows: state.rows,
    effectiveScope: answerProps.effectiveScope ?? state.effectiveScope,
    freshness: answerProps.freshness ?? state.freshness,
    confidence: answerProps.confidence ?? state.confidence,
    caveats: answerProps.caveats ?? state.caveats,
    benchmark: answerProps.benchmark ?? state.benchmark,
    sensorHealth: state.sensorHealth,
    snapshot,
    performance: { ...(ui.performance ?? {}), pngMs: Date.now() - pngStartedAt },
    ui: { ...publicUi, ...(snapshot ? { snapshot } : {}) },
    dataDir,
    cli: safeCliInfo(cli),
  };
};


const addCheck = (checks, name, ok, detail, extra = {}) => {
  checks.push({ name, ok, detail, ...extra });
};

export const primaryNextAction = (actions) => actions.find(Boolean);

export const toNextSteps = (action) => action ? [action.label] : [];

const managedCliNextAction = ({ dataDir, reason, missingRequiredCapabilities = [] }) => ({
  id: 'install_managed_cli',
  label: missingRequiredCapabilities.length > 0
    ? 'Install or update the managed Density CLI runtime.'
    : 'Install the managed Density CLI runtime.',
  tool: 'install_managed_cli',
  args: { dataDir },
  reason,
  missingRequiredCapabilities,
});

const starterUsefulness = (readiness) => {
  const nonzeroAnswerCount = Number(readiness?.nonzeroAnswerCount ?? 0);
  const useful = nonzeroAnswerCount > 0;
  return {
    useful,
    nonzeroAnswerCount,
    reason: useful
      ? undefined
      : 'Starter-question cache is warmed, but no starter answers have nonzero utilization. Local data may be empty or missing space metadata.',
  };
};

const starterReadyDetail = (starterCache, fallbackCount) => {
  if (!starterCache.ready) return starterCache.reason ?? 'Starter-question answers are not ready yet.';
  const count = starterCache.questionCount ?? fallbackCount ?? 'Starter';
  const cacheState = starterCache.cache?.hit ? 'cache hit' : 'cache warmed';
  if (starterCache.useful === false) {
    return `${count} answers ready; ${cacheState}; 0 nonzero utilization answers. Local data may be empty or missing space metadata.`;
  }
  return `${count} answers ready; ${cacheState}`;
};

const publicCliCapabilities = (capabilities = {}) => {
  const {
    chartQuestions: _chartQuestions,
    questionAnswering: _questionAnswering,
    commands,
    ...rest
  } = capabilities;
  const {
    askChart: _askChart,
    questionUi: _questionUi,
    questionStarter: _questionStarter,
    questionSensorHealth: _questionSensorHealth,
    questionSnapshotRefresh: _questionSnapshotRefresh,
    ...publicCommands
  } = commands ?? {};
  return {
    ...rest,
    commands: publicCommands,
  };
};

const hasResourcesParquet = (storage) => Boolean(storage.tables?.find((table) => table.table === 'resources')?.present);

export async function checkStarterCache(cli, dataDir) {
  const result = await runDensity(cli, ['question', '--starter', '--cached', '--cache-only', '--format', 'json'], {
    dataDir,
    allowFailure: true,
    timeoutMs: 10000,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      checked: true,
      ready: false,
      reason: result.timedOut ? 'Starter-question cache check timed out.' : oneLine(result.stderr || result.stdout),
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const usefulness = starterUsefulness(parsed.readiness);
    return {
      checked: true,
      ready: Boolean(parsed.readiness?.ready),
      ...usefulness,
      readiness: parsed.readiness,
      artifactManifest: parsed.artifactManifest,
      cache: parsed.cache,
      questionCount: parsed.questionCount,
      reason: parsed.reason,
    };
  } catch (error) {
    return {
      checked: true,
      ready: false,
      reason: `Starter-question cache response was not JSON: ${error.message}`,
    };
  }
}

export async function setup(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const checks = [];
  const managedManifest = await loadManagedCliManifest();
  const managedRuntime = await managedCliRuntimeStatus(managedManifest);
  const cli = await resolveDensityCli();
  addCheck(checks, 'density cli found', Boolean(cli), cli?.source ?? 'Set DENSITY_CLI_BIN or install density on PATH.', {
    cli: safeCliInfo(cli),
  });
  addCheck(
    checks,
    'managed cli manifest configured',
    Boolean(managedManifest),
    managedManifest ? `version ${managedManifest.version}` : 'No managed CLI manifest is configured.',
    { optional: Boolean(cli) }
  );
  addCheck(
    checks,
    'managed cli runtime installed',
    managedRuntime.installed || Boolean(cli),
    managedRuntime.installed ? managedRuntime.path : 'Run install_managed_cli to install the managed runtime.',
    { optional: Boolean(cli), managedCli: managedRuntime }
  );

  let capabilities = { checked: false, commands: {}, reason: 'Density CLI not found.' };
  let missingRequiredCapabilities = [];
  let status;
  if (cli) {
    const build = await ensureDensityCliBuilt(cli);
    addCheck(checks, 'density cli built', true, build.reason);
    capabilities = await discoverCliCapabilities(cli, { dataDir });
    addCheck(
      checks,
      'direct database tools advertised',
      Boolean(capabilities.commands?.getDbSchema && capabilities.commands?.queryDb),
      capabilities.commands?.getDbSchema && capabilities.commands?.queryDb
        ? 'get-db-schema and query-db are available for scoped local DuckDB reads.'
        : 'CLI does not advertise the hardened local database query contract yet.'
    );
    addCheck(
      checks,
      'building lifecycle readiness advertised',
      availableBuildingsSupported(capabilities),
      availableBuildingsSupported(capabilities)
        ? 'available-buildings reports building status, go-live, metric coverage, geometry, and live wayfinding eligibility.'
        : 'CLI does not advertise building lifecycle/go-live readiness yet.'
    );
    missingRequiredCapabilities = missingRequiredCliCapabilities(capabilities, managedManifest?.requiredCapabilities);
    status = await runDensity(cli, ['status'], { dataDir, allowFailure: true });
    addCheck(
      checks,
      'density status runs',
      status.code === 0,
      status.code === 0 ? 'status completed' : oneLine(status.stderr || status.stdout)
    );
  }

  addCheck(checks, 'svg to png renderer found', Boolean(await which('rsvg-convert')), 'Optional: used for inline Codex PNG chart previews.', { optional: true });
  addCheck(checks, 'duckdb cli found', Boolean(await which('duckdb')), 'Optional: used for demo customer Parquet slicing.', { optional: true });

  const storage = await storageReport(dataDir);
  addCheck(
    checks,
    'canonical parquet ready',
    storage.parquetReady,
    storage.parquetReady ? `${storage.parquetBytes} bytes across expected tables` : 'Parquet export is missing or incomplete.'
  );
  const update = await checkPluginUpdate();
  const usableCliSelected = Boolean(cli) && missingRequiredCapabilities.length === 0;
  const managedInstallNeeded = Boolean(managedManifest)
    && managedRuntime.assetAvailable
    && !cli?.explicit
    && !usableCliSelected
    && (!managedRuntime.installed || missingRequiredCapabilities.length > 0);
  const nextAction = primaryNextAction([
    managedInstallNeeded && managedCliNextAction({
      dataDir,
      reason: !managedRuntime.installed
        ? 'The plugin-managed Density CLI runtime is not installed.'
        : 'The current Density CLI does not advertise the managed runtime capability contract.',
      missingRequiredCapabilities,
    }),
    !cli && {
      id: 'configure_cli',
      label: 'Install or point Codex at the Density CLI.',
      command: 'Set DENSITY_CLI_BIN or install density on PATH.',
    },
    cli && status?.code !== 0 && /Token|auth|Authorization|login/i.test(status.stderr || status.stdout) && {
      id: 'auth_login',
      label: 'Run Density browser auth.',
      tool: 'auth_login',
      command: 'density auth login',
    },
    cli && status?.code === 0 && !storage.parquetReady && {
      id: 'onboard_customer',
      label: `Fetch ${DEFAULT_METRICS_DAYS} days for all locations, then continue deeper history in the background.`,
      tool: 'onboard_customer',
      args: {
        dataDir,
        days: DEFAULT_METRICS_DAYS,
        fullSync: true,
        backgroundDeepSync: true,
        backgroundDeepSyncDays: DEFAULT_BACKGROUND_DEEP_SYNC_DAYS,
      },
      command: `density sync --stream spaces && density sync --stream metrics --all-spaces --since ${DEFAULT_METRICS_DAYS}d --until now --interval ${metricsIntervalForDays(DEFAULT_METRICS_DAYS)} && density export parquet --out ${path.join(dataDir, 'parquet')} --all-orgs`,
    },
    cli && status?.code === 0 && !availableBuildingsSupported(capabilities) && {
      id: 'update_cli_for_building_lifecycle',
      label: 'Update the Density CLI for lifecycle-aware building analysis.',
      command: 'density capabilities --format json',
    },
    cli && status?.code === 0 && storage.parquetReady && !(capabilities.commands?.getDbSchema && capabilities.commands?.queryDb) && {
      id: 'update_cli_for_db_query',
      label: 'Update the Density CLI for scoped local database queries.',
      command: 'density capabilities --format json',
    },
    update.available && {
      id: 'plugin_update',
      label: update.prompt,
      command: update.command,
      userPrompt: update.userPrompt,
      displayPrompt: update.displayPrompt,
      pluginSelector: update.pluginSelector,
      pluginUri: update.pluginUri,
    },
  ]);

  return {
    ok: checks.every((check) => check.ok || check.optional),
    dataDir,
    cli: safeCliInfo(cli),
    checks,
    capabilities: publicCliCapabilities(capabilities),
    storage,
    update,
    managedCli: {
      manifest: managedManifest,
      runtime: managedRuntime,
      missingRequiredCapabilities,
    },
    nextAction,
    nextSteps: toNextSteps(nextAction),
    userVisiblePrimaryActions: nextAction ? 1 : 0,
  };
}

export async function installManagedCli(args = {}) {
  try {
    const result = await installManagedCliRuntime({
      dataDir: resolveDataDir(args.dataDir),
      manifestPath: args.manifestPath,
      platform: args.platform,
      runtimeRoot: args.runtimeRoot,
      timeoutMs: args.timeoutMs,
    });
    return result.capabilities
      ? { ...result, capabilities: publicCliCapabilities(result.capabilities) }
      : result;
  } catch (error) {
    return {
      ok: false,
      error: oneLine(error.message),
    };
  }
}

const summarizeAvailableBuildings = (buildings) => buildings.reduce((summary, building) => {
  const status = String(building.status || 'unknown').toLowerCase();
  const goLiveState = String(building.goLive?.goLiveState || 'unknown').toLowerCase();
  summary.status[status] = (summary.status[status] ?? 0) + 1;
  summary.goLive[goLiveState] = (summary.goLive[goLiveState] ?? 0) + 1;
  if (building.chartQueryable) summary.chartQueryable += 1;
  if (building.liveWayfindingEligible) summary.liveWayfindingEligible += 1;
  if (Array.isArray(building.caveats) && building.caveats.length) summary.withCaveats += 1;
  return summary;
}, {
  status: {},
  goLive: {},
  chartQueryable: 0,
  liveWayfindingEligible: 0,
  withCaveats: 0,
});

export async function availableBuildings(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const includeMetrics = args.includeMetrics === true;
  const building = oneLine(args.building);
  const cli = await requireCli();
  const capabilities = await discoverCliCapabilities(cli, { dataDir });
  const buildingFilterSupported = Boolean(capabilities.commands?.availableBuildingsScope);
  if (!availableBuildingsSupported(capabilities) || (building && !buildingFilterSupported)) {
    return {
      ok: false,
      unsupported: true,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      message: building && !buildingFilterSupported
        ? 'This Density CLI does not support a building filter for available-buildings yet.'
        : 'This Density CLI does not support lifecycle-aware building readiness yet.',
      nextAction: {
        id: 'update_cli_for_building_lifecycle',
        label: 'Update/build a Density CLI that supports density available-buildings.',
        command: 'density capabilities --format json',
      },
      userVisiblePrimaryActions: 1,
    };
  }

  const result = await runDensity(cli, [
    'available-buildings',
    ...(building ? ['--building', building] : []),
    ...(includeMetrics ? ['--include-metrics'] : []),
    '--format', 'json',
  ], {
    dataDir,
    allowFailure: true,
    timeoutMs: args.timeoutMs ?? 15000,
  });
  if (result.code !== 0) {
    return {
      ok: false,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      error: oneLine(result.stderr || result.stdout),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Density available-buildings response was not JSON: ${error.message}`);
  }
  const buildings = Array.isArray(parsed.buildings) ? parsed.buildings : [];
  const derivedDatasetRepair = startDerivedDatasetRepair({ cli, capabilities, dataDir, derivedDataset: parsed.derivedDataset });
  return {
    ok: true,
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    kind: parsed.kind,
    organizationId: parsed.organizationId,
    organizationName: parsed.organizationName,
    ...(isRecord(parsed.scope) ? { scope: parsed.scope } : {}),
    buildingCount: Number(parsed.buildingCount ?? buildings.length),
    metricCoverageIncluded: includeMetrics,
    buildings,
    summary: summarizeAvailableBuildings(buildings),
    contract: {
      queryNonLiveAllowed: true,
      discloseStatusAndGoLive: true,
      chartQueryableRequires: ['live_or_historical_metric_coverage', 'not_planning_only'],
      liveWayfindingRequires: ['live_status', 'past_go_live', 'mapped_geometry'],
      missingGoLiveHandling: 'caveat_not_live_claim',
    },
    ...(isRecord(parsed.derivedDataset) ? { derivedDataset: parsed.derivedDataset } : {}),
    ...(derivedDatasetRepair ? { derivedDatasetRepair } : {}),
    dataDir,
    cli: safeCliInfo(cli),
    capabilities,
  };
}

// Readiness for one building or floor through `density onboard scope --include-readiness`. No portfolio scan.
const scopeReadiness = async ({ cli, dataDir, timeoutMs, scope }) => {
  const capabilities = await discoverCliCapabilities(cli, { dataDir });
  if (!capabilities.commands?.onboardingScopeReadiness) {
    return { ok: false, unsupported: true, error: 'This Density CLI does not report scope readiness yet.', floors: [] };
  }
  const result = await runDensity(cli, [
    'onboard', 'scope', scope.id, '--scope-type', scope.type, '--include-readiness', '--format', 'json',
  ], { dataDir, allowFailure: true, timeoutMs });
  if (result.code !== 0 || result.timedOut) {
    return { ok: false, error: result.timedOut ? 'Scope readiness timed out.' : oneLine(result.stderr || result.stdout), floors: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, error: `Scope readiness response was not JSON: ${error.message}`, floors: [] };
  }
  if (parsed.ok !== true || !isRecord(parsed.readiness)) {
    return {
      ok: false,
      error: parsed.reason === 'ambiguous' ? 'The scope name is ambiguous.' : 'The scope was not found in the selected organization.',
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      floors: [],
    };
  }
  return { ok: true, ...parsed.readiness, floors: Array.isArray(parsed.floors) ? parsed.floors : [] };
};

export async function prepareFloorplans(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const buildingId = oneLine(args.buildingId);
  const floorId = oneLine(args.floorId);
  if (Boolean(buildingId) === Boolean(floorId)) {
    return {
      ok: false,
      dataDir,
      error: 'Floorplan preparation needs exactly one buildingId or floorId.',
    };
  }
  const scope = buildingId ? { type: 'building', id: buildingId } : { type: 'floor', id: floorId };

  const cli = await requireCli();
  const timeoutSeconds = Number.isFinite(Number(args.timeoutSeconds)) ? Number(args.timeoutSeconds) : 110;
  const timeoutMs = Math.max(1, Math.min(600, timeoutSeconds)) * 1000;
  const steps = [];
  const runStep = async (name, commandArgs) => {
    const startedAt = Date.now();
    const result = await runDensity(cli, commandArgs, { dataDir, allowFailure: true, timeoutMs });
    const step = {
      name,
      command: ['density', ...commandArgs].join(' '),
      ok: result.code === 0 && !result.timedOut,
      timedOut: result.timedOut,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      stdout: oneLine(result.stdout),
      stderr: oneLine(result.stderr),
    };
    steps.push(step);
    if (!step.ok) {
      throw Object.assign(new Error(`${name} failed: ${step.timedOut ? 'timed out' : step.stderr || step.stdout}`), { steps });
    }
  };

  try {
    const scopeArgs = buildingId ? ['--building', buildingId] : ['--floor', floorId];
    await runStep('sync floorplans', ['sync', '--stream', 'floorplans', ...scopeArgs]);
    const { floors, ...mapReadiness } = await scopeReadiness({ cli, dataDir, timeoutMs, scope });
    return {
      ok: mapReadiness.ok,
      kind: 'density.floorplan-preparation',
      sourceLayer: SOURCE_LAYERS.localCustomerData,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
      dataDir,
      scope,
      steps,
      mapReadiness,
      floors,
      textLiveChanged: false,
      historicalDataChanged: false,
    };
  } catch (error) {
    return {
      ok: false,
      kind: 'density.floorplan-preparation',
      dataDir,
      scope,
      steps: error.steps ?? steps,
      error: oneLine(error.message),
      textLiveChanged: false,
      historicalDataChanged: false,
    };
  }
}

async function runCapabilityJsonCommand(args, options) {
  const startedAt = Date.now();
  const cli = await requireCli();
  const cliResolvedAt = Date.now();
  const dataDir = resolveDataDir(args.dataDir);
  const timeoutMs = args.timeoutMs ?? options.timeoutMs;
  const capabilities = await discoverCliCapabilities(cli, { dataDir, timeoutMs });
  const capabilitiesDiscoveredAt = Date.now();
  const cliInfo = safeCliInfo(cli);
  const cliArgs = typeof options.cliArgs === 'function' ? options.cliArgs(capabilities) : options.cliArgs;
  const performance = (commandCompletedAt = capabilitiesDiscoveredAt) => options.measurePerformance
    ? {
        performance: {
          cliResolutionMs: cliResolvedAt - startedAt,
          capabilityDiscoveryMs: capabilitiesDiscoveredAt - cliResolvedAt,
          cliCommandMs: commandCompletedAt - capabilitiesDiscoveredAt,
          totalMs: commandCompletedAt - startedAt,
        },
      }
    : {};

  if (!capabilities.commands?.[options.capability]) {
    return {
      ok: false,
      unsupported: true,
      dataDir,
      cli: cliInfo,
      capabilities,
      ...options.extraFields,
      ...performance(),
      error: options.unsupportedError,
      nextAction: options.nextAction,
    };
  }

  const result = await runDensity(cli, cliArgs, {
    dataDir,
    allowFailure: true,
    timeoutMs,
  });
  const commandCompletedAt = Date.now();
  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      dataDir,
      cli: cliInfo,
      ...options.extraFields,
      ...performance(commandCompletedAt),
      error: result.timedOut ? options.timedOutError : oneLine(result.stderr || result.stdout),
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    const derivedDatasetRepair = startDerivedDatasetRepair({ cli, capabilities, dataDir, derivedDataset: payload?.derivedDataset });
    return {
      ok: true,
      dataDir,
      cli: cliInfo,
      ...performance(commandCompletedAt),
      [options.payloadKey]: payload,
      ...(derivedDatasetRepair ? { derivedDatasetRepair } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      dataDir,
      cli: cliInfo,
      ...options.extraFields,
      ...performance(commandCompletedAt),
      error: `${options.responseLabel} response was not JSON: ${error.message}`,
      stdout: oneLine(result.stdout),
    };
  }
}

export const DEFAULT_SCHEMA_BUDGET_MS = 10000;

export async function getDbSchema(args = {}) {
  const tables = Array.isArray(args.tables)
    ? args.tables.filter((table) => typeof table === 'string' && table.trim()).map((table) => table.trim())
    : [];
  const budgetMs = args.budgetMs === undefined ? DEFAULT_SCHEMA_BUDGET_MS : Number(args.budgetMs);
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('budgetMs must be a non-negative number.');
  return runCapabilityJsonCommand(args, {
    capability: 'getDbSchema',
    // The CLI returns a partial schema when the budget ends, so the process timeout only guards a hung CLI.
    cliArgs: (capabilities) => [
      'get-db-schema',
      ...(tables.length > 0 ? ['--tables', tables.join(',')] : []),
      ...(capabilities.commands?.getDbSchemaBudget ? ['--budget-ms', String(budgetMs)] : []),
      '--format', 'json',
    ],
    timeoutMs: budgetMs + 5000,
    unsupportedError: 'This Density CLI does not support get-db-schema yet.',
    timedOutError: 'DB schema lookup timed out.',
    responseLabel: 'DB schema',
    payloadKey: 'schema',
    nextAction: {
      id: 'update_cli_for_db_schema',
      label: 'Update/build a Density CLI that supports density get-db-schema.',
      command: 'density capabilities --format json',
    },
  });
}

export async function demoModeStatus(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const cli = await resolveDensityCli();
  if (!cli) {
    throw new Error('Demo mode status is unavailable.');
  }
  const capabilities = await discoverCliCapabilities(cli, { dataDir, timeoutMs: args.timeoutMs ?? 5000 });
  if (!capabilities.commands?.demoMode) {
    throw new Error('Demo mode status is unavailable.');
  }
  const result = await runDensity(cli, ['demo', 'status', '--format', 'json'], {
    dataDir,
    allowFailure: true,
    timeoutMs: args.timeoutMs ?? 5000,
  });
  if (result.code !== 0 || result.timedOut) {
    throw new Error('Demo mode status is unavailable.');
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('Demo mode status is unavailable.');
  }
  if (!isRecord(parsed) || typeof parsed.enabled !== 'boolean'
    || (parsed.enabled && !(
      (typeof parsed.generation === 'string' && parsed.generation.trim())
      || (Number.isSafeInteger(parsed.generation) && parsed.generation >= 0)
    ))
    || (parsed.enabled && (typeof parsed.organizationId !== 'string' || !parsed.organizationId.trim()))) {
    throw new Error('Demo mode status is unavailable.');
  }
  return {
    supported: true,
    enabled: parsed.enabled,
    generation: parsed.enabled ? String(parsed.generation) : 'off',
    ...(parsed.enabled ? { organizationId: parsed.organizationId } : {}),
  };
}

async function attachQueryChartPreview(response, args = {}, extraFields = {}, payloadKey = 'result') {
  const payload = response?.[payloadKey];
  const html = payload?.chart?.state === 'rendered'
    ? payload.chart.artifacts?.html
    : undefined;
  if (typeof html !== 'string' || !path.isAbsolute(html)) {
    return { ...response, ...extraFields };
  }
  let preview;
  try {
    preview = await renderHtmlPreview(path.normalize(html), { timeoutMs: args.timeoutMs ?? 10000 });
  } catch (error) {
    preview = { status: 'unavailable', reason: oneLine(error?.message || String(error)) };
  }
  if (preview.status !== 'available') {
    return {
      ...response,
      ...extraFields,
      [payloadKey]: {
        ...payload,
        chart: {
          ...payload.chart,
          png: { state: 'unavailable', reason: preview.reason },
        },
      },
    };
  }
  const png = preview.artifact.path;
  return {
    ...response,
    ...extraFields,
    png,
    [payloadKey]: {
      ...payload,
      chart: {
        ...payload.chart,
        artifacts: {
          ...payload.chart.artifacts,
          png,
        },
        png: {
          state: 'available',
          width: preview.width,
          height: preview.height,
          renderer: preview.renderer,
        },
      },
    },
  };
}

export const QUERY_DB_DEFAULT_TIMEOUT_MS = 120000;

export async function queryDb(args = {}) {
  const sql = String(args.sql || '').trim();
  if (!sql) throw new Error('sql is required.');
  const declaredAnalysisContext = validateQueryAnalysis(args.analysis);
  const response = await runCapabilityJsonCommand(args, {
    capability: 'queryDb',
    cliArgs: [
      'query-db',
      '--sql', sql,
      ...(declaredAnalysisContext ? ['--analysis', JSON.stringify(declaredAnalysisContext)] : []),
      '--format', 'json',
    ],
    timeoutMs: QUERY_DB_DEFAULT_TIMEOUT_MS,
    measurePerformance: true,
    extraFields: { sql },
    unsupportedError: 'This Density CLI does not support query-db yet.',
    timedOutError: 'DB query timed out.',
    responseLabel: 'DB query',
    payloadKey: 'result',
    nextAction: {
      id: 'update_cli_for_query_db',
      label: 'Update/build a Density CLI that supports density query-db.',
      command: 'density capabilities --format json',
    },
  });
  return declaredAnalysisContext === undefined ? response : { ...response, declaredAnalysisContext };
}

export async function renderChart(args = {}) {
  const evidenceId = String(args.evidenceId || '').trim();
  if (!/^qe_[a-f0-9]{64}$/u.test(evidenceId)) throw new Error('A valid evidenceId is required.');
  if (!isRecord(args.chart)) throw new Error('chart is required.');
  const response = await runCapabilityJsonCommand(args, {
    capability: 'renderChart',
    cliArgs: ['render-chart', '--evidence', evidenceId, '--chart', JSON.stringify(args.chart), '--format', 'json'],
    timeoutMs: 30000,
    unsupportedError: 'This Density CLI does not support presentation-only chart rendering yet.',
    timedOutError: 'Chart rendering timed out.',
    responseLabel: 'Chart rendering',
    payloadKey: 'result',
    nextAction: {
      id: 'update_cli_for_render_chart',
      label: 'Update/build a Density CLI that supports density render-chart.',
      command: 'density capabilities --format json',
    },
  });
  return attachQueryChartPreview(response, args);
}

export async function configureBrand(args = {}) {
  const source = String(args.source || '').trim();
  if (!source) throw new Error('A brand guideline source is required.');
  const logo = String(args.logo || '').trim();
  return runCapabilityJsonCommand(args, {
    capability: 'brandGuidelines',
    cliArgs: ['brand', 'set', '--source', source, ...(logo ? ['--logo', logo] : []), '--format', 'json'],
    timeoutMs: 30000,
    unsupportedError: 'This Density CLI does not support brand guidelines yet.',
    timedOutError: 'Brand guideline ingestion timed out.',
    responseLabel: 'Brand guideline ingestion',
    payloadKey: 'result',
    nextAction: {
      id: 'update_cli_for_brand_guidelines',
      label: 'Update the Density CLI to support brand guidelines.',
      command: 'density capabilities --format json',
    },
  });
}

async function attachBuildingReadiness(response, args = {}) {
  if (response?.buildingReadiness) return response;
  try {
    const readiness = await availableBuildings({ dataDir: args.dataDir });
    return { ...response, buildingReadiness: readiness };
  } catch (error) {
    return {
      ...response,
      buildingReadiness: {
        ok: false,
        error: oneLine(error.message),
        caveat: 'Building status/go-live readiness could not be checked before this response.',
      },
    };
  }
}

export async function authLogin(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const result = await runDensity(cli, ['auth', 'login'], { dataDir, allowFailure: true });
  return {
    ok: result.code === 0,
    dataDir,
    cli: safeCliInfo(cli),
    stdout: oneLine(result.stdout),
    stderr: oneLine(result.stderr),
  };
}

export async function onboardCustomer(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const days = boundedMetricsDays(args.days);
  const fullSync = Boolean(args.fullSync);
  const backgroundDeepSync = Boolean(args.backgroundDeepSync ?? (fullSync && days === DEFAULT_METRICS_DAYS));
  const backgroundDeepSyncDays = backgroundDeepSync
    ? boundedHistoricalExportDays(args.backgroundDeepSyncDays ?? DEFAULT_BACKGROUND_DEEP_SYNC_DAYS)
    : undefined;
  const timeoutSeconds = Number.isFinite(Number(args.timeoutSeconds)) ? Number(args.timeoutSeconds) : 110;
  const steps = [];
  const runStep = async (name, commandArgs, options = {}) => {
    const startedAt = Date.now();
    const result = await runDensity(cli, commandArgs, {
      dataDir,
      allowFailure: true,
      timeoutMs: options.timeoutMs,
    });
    const step = {
      name,
      command: ['density', ...commandArgs].join(' '),
      ok: result.code === 0 && !result.timedOut,
      timedOut: result.timedOut,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      stdout: oneLine(result.stdout),
      stderr: oneLine(result.stderr),
    };
    steps.push(step);
    if (!step.ok) {
      throw Object.assign(new Error(`${name} failed: ${step.timedOut ? 'timed out' : step.stderr || step.stdout}`), { steps });
    }
    return step;
  };
  try {
    const metricsCommand = ['sync', '--stream', 'metrics', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', metricsIntervalForDays(days)];
    const occupancyCommand = ['sync', '--stream', 'occupancy', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', '1h'];
    const exportCommand = ['export', 'parquet', '--out', path.join(dataDir, 'parquet'), '--all-orgs'];

    if (!fullSync) {
      const storage = await storageReport(dataDir);
      return {
        ok: true,
        mode: 'staged',
        dataDir,
        days,
        cli: safeCliInfo(cli),
        steps,
        storage,
        nextAction: {
          id: 'run_full_sync',
          label: `Fetch ${DEFAULT_METRICS_DAYS} days for all locations, then continue deeper history in the background.`,
          tool: 'onboard_customer',
          args: {
            dataDir,
            orgId: args.orgId,
            days: DEFAULT_METRICS_DAYS,
            fullSync: true,
            backgroundDeepSync: true,
            backgroundDeepSyncDays: DEFAULT_BACKGROUND_DEEP_SYNC_DAYS,
          },
          command: `density ${metricsCommand.join(' ')}`,
        },
        onboardingOptions: [
          {
            id: 'recommended_recent_plus_background',
            recommended: true,
            label: `Fetch ${DEFAULT_METRICS_DAYS} days for all locations now, then background the remaining supported history.`,
            tool: 'onboard_customer',
            args: {
              dataDir,
              orgId: args.orgId,
              days: DEFAULT_METRICS_DAYS,
              fullSync: true,
              backgroundDeepSync: true,
              backgroundDeepSyncDays: DEFAULT_BACKGROUND_DEEP_SYNC_DAYS,
            },
          },
          {
            id: 'recent_only',
            label: `Fetch ${DEFAULT_METRICS_DAYS} days for all locations and skip the background history job.`,
            tool: 'onboard_customer',
            args: { dataDir, orgId: args.orgId, days: DEFAULT_METRICS_DAYS, fullSync: true, backgroundDeepSync: false },
          },
          {
            id: 'specific_location',
            label: 'Fetch a specific building, floor, or location slice.',
            unavailable: true,
            reason: 'Scoped onboarding needs a CLI scope resolver so the plugin can sync descendants without guessing space ids.',
          },
        ],
        nextSteps: [`Fetch ${DEFAULT_METRICS_DAYS} days for all locations, then continue deeper history in the background.`],
        userVisiblePrimaryActions: 1,
      };
    }

    if (args.orgId) await runStep('select organization', ['org', 'use', args.orgId]);
    await runStep('sync spaces', ['sync', '--stream', 'spaces']);
    const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
    await runStep('sync meeting-room metrics', metricsCommand, { timeoutMs });
    await runStep('sync occupancy overview', occupancyCommand, { timeoutMs });
    await runStep('export parquet', exportCommand, { timeoutMs });
    const storage = await storageReport(dataDir);
    const backgroundJob = backgroundDeepSync && storage.parquetReady
      ? await startBackgroundDeepSync({
        dataDir,
        orgId: args.orgId,
        days: backgroundDeepSyncDays,
        recentDays: days,
      })
      : undefined;

    return {
      ok: storage.parquetReady,
      mode: backgroundJob ? 'recent-plus-background' : 'full-sync',
      dataDir,
      days,
      backgroundDeepSync: backgroundJob
        ? {
          enabled: true,
          days: backgroundDeepSyncDays,
          recentDays: days,
          status: backgroundJob,
          pollingTool: 'onboarding_status',
        }
        : { enabled: false },
      cli: safeCliInfo(cli),
      steps,
      storage,
      nextAction: storage.parquetReady ? undefined : {
        id: 'export_parquet',
        label: 'Export Parquet after sync completes.',
        command: `density ${exportCommand.join(' ')}`,
      },
      nextSteps: storage.parquetReady ? [] : ['Export Parquet after sync completes.'],
      userVisiblePrimaryActions: storage.parquetReady ? 0 : 1,
    };
  } catch (error) {
    return {
      ok: false,
      mode: fullSync ? 'full-sync' : 'staged',
      dataDir,
      days,
      cli: safeCliInfo(cli),
      steps: error.steps ?? steps,
      error: oneLine(error.message),
      storage: await storageReport(dataDir),
      nextAction: {
        id: 'resume_onboarding',
        label: 'Resume Density onboarding after resolving the failed step.',
      },
      nextSteps: ['Resume Density onboarding after resolving the failed step.'],
      userVisiblePrimaryActions: 1,
    };
  }
}

export async function historicalExport(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const days = boundedHistoricalExportDays(args.days);
  const until = args.until === undefined ? 'now' : String(args.until);
  const interval = historicalIntervalForDays(days);
  const timeoutSeconds = Number.isFinite(Number(args.timeoutSeconds)) ? Number(args.timeoutSeconds) : 600;
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const steps = [];
  const runStep = async (name, commandArgs) => {
    const startedAt = Date.now();
    const result = await runDensity(cli, commandArgs, {
      dataDir,
      allowFailure: true,
      timeoutMs,
    });
    const step = {
      name,
      command: ['density', ...commandArgs].join(' '),
      ok: result.code === 0 && !result.timedOut,
      timedOut: result.timedOut,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      stdout: oneLine(result.stdout),
      stderr: oneLine(result.stderr),
    };
    steps.push(step);
    if (!step.ok) {
      throw Object.assign(new Error(`${name} failed: ${step.timedOut ? 'timed out' : step.stderr || step.stdout}`), { steps });
    }
    return step;
  };

  const metricsCommand = ['sync', '--stream', 'metrics', '--all-spaces', '--since', `${days}d`, '--until', until, '--interval', interval];
  const occupancyCommand = ['sync', '--stream', 'occupancy', '--all-spaces', '--since', `${days}d`, '--until', until, '--interval', '1h'];
  const exportCommand = ['export', 'parquet', '--out', path.join(dataDir, 'parquet'), '--all-orgs'];

  try {
    if (args.orgId) await runStep('select organization', ['org', 'use', args.orgId]);
    await runStep('sync spaces', ['sync', '--stream', 'spaces']);
    await runStep('sync historical metrics', metricsCommand);
    await runStep('sync historical occupancy overview', occupancyCommand);
    await runStep('export parquet', exportCommand);
    const storage = await storageReport(dataDir);
    return {
      ok: storage.parquetReady,
      mode: 'historical-export',
      sourceLayer: SOURCE_LAYERS.localCustomerData,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
      dataDir,
      days,
      until,
      interval,
      cli: safeCliInfo(cli),
      steps,
      storage,
      nextSteps: storage.parquetReady ? [] : ['Export Parquet after sync completes.'],
      userVisiblePrimaryActions: storage.parquetReady ? 0 : 1,
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'historical-export',
      sourceLayer: SOURCE_LAYERS.localCustomerData,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
      dataDir,
      days,
      until,
      interval,
      cli: safeCliInfo(cli),
      steps: error.steps ?? steps,
      error: oneLine(error.message),
      storage: await storageReport(dataDir),
      nextAction: {
        id: 'resume_historical_export',
        label: 'Resume Density historical export after resolving the failed step.',
      },
      nextSteps: ['Resume Density historical export after resolving the failed step.'],
      userVisiblePrimaryActions: 1,
    };
  }
}

export async function onboardingStatus(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const backgroundDeepSync = await latestDeepSyncStatus(dataDir);
  return {
    ok: true,
    kind: 'density.onboarding-status',
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    dataDir,
    backgroundDeepSync: backgroundDeepSync ?? {
      status: 'not_started',
      statusFile: deepSyncStatusFile(dataDir),
    },
    nextAction: backgroundDeepSync?.status === 'running'
      ? {
        id: 'check_background_deep_sync',
        label: 'Check the Density background history sync again later.',
        tool: 'onboarding_status',
        args: { dataDir },
      }
      : undefined,
    userVisiblePrimaryActions: backgroundDeepSync?.status === 'running' ? 1 : 0,
  };
}

const latestIso = (values) => values.filter(Boolean).sort().at(-1);

const streamName = (key) => {
  const parts = String(key).split(':');
  return parts[0] === 'org' ? parts[2] : parts[0];
};

const streamScope = (key) => {
  if (String(key).includes(':all-spaces')) return 'all_spaces';
  if (String(key).includes(':spc_')) return 'selected_spaces';
  return 'organization';
};

const summarizeSyncState = (streams = {}) => {
  const summaries = new Map();
  for (const [key, value] of Object.entries(streams)) {
    const name = streamName(key);
    const current = summaries.get(name) ?? {
      name,
      stateEntries: 0,
      scopes: new Set(),
      latestSyncAt: undefined,
      coverageThrough: undefined,
    };
    current.stateEntries += 1;
    current.scopes.add(streamScope(key));
    current.latestSyncAt = latestIso([current.latestSyncAt, value?.lastSyncAt]);
    current.coverageThrough = latestIso([current.coverageThrough, value?.updatedSince]);
    summaries.set(name, current);
  }
  return [...summaries.values()]
    .map((summary) => ({
      ...summary,
      scopes: [...summary.scopes].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};

const readStatusState = async (dataDir) => {
  try {
    const state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    return isRecord(state) ? state : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Unable to read Density status state: ${oneLine(error.message)}`);
  }
};

const readStatusSyncStreams = async (dataDir, state) => {
  let syncState;
  try {
    syncState = await readJsonFile(path.join(dataDir, 'sync-state.json'));
  } catch (error) {
    throw new Error(`Unable to read Density sync state: ${oneLine(error.message)}`);
  }
  const stored = isRecord(syncState?.streams) ? syncState.streams : {};
  // Entries that an older CLI left inside state.json win until the CLI migrates them.
  return isRecord(state.streams) ? { ...stored, ...state.streams } : stored;
};

const uniqueParquetStorage = (storage) => {
  const tables = new Map();
  for (const table of [...storage.tables, ...storage.fastQuestionTables]) {
    const current = tables.get(table.table);
    if (!current || table.bytes > current.bytes) tables.set(table.table, table);
  }
  const uniqueTables = [...tables.values()];
  return {
    parquetBytes: uniqueTables.reduce((sum, table) => sum + table.bytes, 0),
    parquetFiles: uniqueTables.reduce((sum, table) => sum + table.files, 0),
    newestParquetModifiedAt: latestIso(uniqueTables.map((table) => table.modifiedAt)),
  };
};

export async function status(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const [state, storage, backgroundDeepSync, derivedDataset, freshness] = await Promise.all([
    readStatusState(dataDir),
    storageReport(dataDir),
    latestDeepSyncStatus(dataDir),
    derivedDatasetState({ dataDir }),
    freshnessState({ dataDir }),
  ]);
  const streams = summarizeSyncState(await readStatusSyncStreams(dataDir, state));
  const latestSyncAt = latestIso(streams.map((stream) => stream.latestSyncAt));
  const parquet = uniqueParquetStorage(storage);
  const tokenExpiresAt = typeof state.token?.expiresAt === 'string' ? state.token.expiresAt : undefined;
  const accessTokenPresent = await fileExists(path.join(dataDir, '.token'));
  const refreshTokenPresent = await fileExists(path.join(dataDir, '.refresh-token'));
  const localDataReady = storage.parquetReady && storage.fastQuestionsReady;

  return {
    ok: true,
    kind: 'density.status.v1',
    generatedAt: nowIso(),
    dataDir,
    identity: {
      organization: state.organizationId
        ? { id: state.organizationId, name: state.organizationName }
        : null,
      user: typeof state.token?.subject === 'string' ? { id: state.token.subject } : null,
      authentication: {
        accessTokenPresent,
        refreshTokenPresent,
        expiresAt: tokenExpiresAt,
        expired: tokenExpiresAt ? Date.parse(tokenExpiresAt) <= Date.now() : undefined,
      },
    },
    scope: {
      organizationSelected: Boolean(state.organizationId),
      buildingSelection: {
        persisted: false,
        selected: null,
        inventoryTool: 'available_buildings',
      },
    },
    sync: {
      latestSyncAt,
      streams,
      backgroundDeepSync: backgroundDeepSync ?? { status: 'not_started' },
    },
    storage: {
      duckdbBytes: storage.duckdbBytes,
      parquetBytes: parquet.parquetBytes,
      localDataBytes: storage.duckdbBytes + parquet.parquetBytes,
      parquetFiles: parquet.parquetFiles,
      newestParquetModifiedAt: parquet.newestParquetModifiedAt,
      canonicalParquetReady: storage.parquetReady,
      fastQuestionsReady: storage.fastQuestionsReady,
    },
    derivedDataset,
    freshness,
    readiness: {
      localDataReady,
      status: localDataReady ? 'ready' : 'sync_required',
      reason: localDataReady ? undefined : 'Required local Parquet tables are missing.',
    },
    nextAction: localDataReady ? undefined : {
      tool: 'onboard_customer',
      args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true, backgroundDeepSync: true },
    },
  };
}

export async function floorUsageReport(args = {}) {
  const focusSpaceIds = args.focusSpaceIds === undefined ? [] : args.focusSpaceIds;
  if (!Array.isArray(focusSpaceIds)) {
    throw new Error('focusSpaceIds must be an array.');
  }
  if (focusSpaceIds.length > 20) {
    throw new Error('focusSpaceIds must contain at most 20 space IDs.');
  }
  const normalizedFocusSpaceIds = focusSpaceIds.map((value) => String(value).trim());
  if (new Set(normalizedFocusSpaceIds).size !== normalizedFocusSpaceIds.length) {
    throw new Error('focusSpaceIds must not contain duplicate space IDs.');
  }
  for (const spaceId of normalizedFocusSpaceIds) {
    if (!spaceId) throw new Error('focusSpaceIds must contain non-empty space IDs.');
  }
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const command = ['viz', '--html', '--report', 'floor-usage', '--format', 'json'];
  if (args.outFile) command.push('--out', String(args.outFile));
  if (args.floorId) command.push('--floor', String(args.floorId));
  for (const spaceId of normalizedFocusSpaceIds) {
    command.push('--focus-space', spaceId);
  }
  const timeoutMs = args.timeoutMs === undefined ? 30000 : Number(args.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number.');
  }
  const result = await runDensity(cli, command, {
    dataDir,
    allowFailure: true,
    timeoutMs,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      ...floorplanRouteResponse({ question: args.question, dataDir }),
      ok: false,
      unsupported: false,
      error: result.timedOut ? 'Floor usage report timed out.' : oneLine(result.stderr || result.stdout),
      nextAction: {
        id: 'prepare_floor_usage_report',
        label: 'Prepare local floorplan and utilization data, then render the floor usage report.',
        tool: 'setup',
        args: { dataDir },
      },
    };
  }
  let parsed;
  try {
    parsed = parseJsonOutput(result.stdout, 'Density floor usage report response');
  } catch (error) {
    return {
      ...floorplanRouteResponse({ question: args.question, dataDir }),
      ok: false,
      unsupported: false,
      error: error.message,
    };
  }
  return {
    ok: true,
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    provenance: localHistoricalProvenance({ dataDir, tool: 'floor_usage_report' }),
    question: args.question,
    intent: 'floorplan_artifact',
    routedSkill: 'floorplan',
    report: parsed.report ?? 'floor-usage',
    artifact: parsed.artifact,
    html: parsed.artifact?.html,
    panelTarget: parsed.panelTarget,
    artifactRequired: 'floorplan',
    dataDir,
    cli: safeCliInfo(cli),
    userVisiblePrimaryActions: 0,
  };
}

export async function localDataProfile(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const [profile, streamFreshness] = await Promise.all([
    localDataProfileReport(dataDir),
    freshnessState({ dataDir }),
  ]);
  const storage = profile.storage;
  const newestModifiedAt = [
    ...storage.tables.map((table) => table.modifiedAt),
    ...storage.fastQuestionTables.map((table) => table.modifiedAt),
  ].filter(Boolean).sort().at(-1);
  const requestedWindowCovered = profile.coverage?.firstTimestamp && profile.coverage?.lastTimestamp
    ? (args.window ? 'profiled_not_compared' : 'profiled')
    : 'not_checked';
  return {
    ok: storage.parquetReady,
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    dataDir,
    freshness: {
      newestLocalParquetModifiedAt: newestModifiedAt,
      firstTimestamp: profile.coverage?.firstTimestamp,
      lastTimestamp: profile.coverage?.lastTimestamp,
      requestedWindow: args.window ?? undefined,
      windowCoverage: requestedWindowCovered,
      reason: profile.reason,
      policy: streamFreshness.policy,
      streams: streamFreshness.streams,
      state: streamFreshness.state,
    },
    profile,
    storage,
    nextAction: storage.parquetReady && storage.fastQuestionsReady
      ? undefined
      : {
          id: 'onboard_customer',
          label: `Fetch ${DEFAULT_METRICS_DAYS} days for all locations, then continue deeper history in the background.`,
          tool: 'onboard_customer',
          args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true, backgroundDeepSync: true },
        },
    userVisiblePrimaryActions: storage.parquetReady && storage.fastQuestionsReady ? 0 : 1,
  };
}

export async function dataHealthReport(args = {}) {
  const profile = await localDataProfile(args);
  const derivedDataset = await derivedDatasetState({ dataDir: profile.dataDir });
  const timestampCoverageChecked = Boolean(profile.profile?.coverage?.firstTimestamp && profile.profile?.coverage?.lastTimestamp);
  return {
    ...profile,
    tool: 'data_health_report',
    derivedDataset,
    checks: [
      { name: 'canonical parquet ready', ok: profile.storage.parquetReady },
      { name: 'fast question parquet ready', ok: profile.storage.fastQuestionsReady },
      { name: 'derived local_metrics dataset current', ok: derivedDataset.state === 'current', detail: derivedDataset.reason },
      { name: 'timestamp coverage checked', ok: timestampCoverageChecked, optional: !timestampCoverageChecked, detail: profile.freshness.reason },
    ],
  };
}

const INSTALL_MANAGED_CLI_ACTION = {
  id: 'install_managed_cli',
  tool: 'install_managed_cli',
  label: 'Install the plugin-managed Density runtime.',
};

const chooseScopeAction = (clarification) => ({
  id: 'choose_scope',
  label: clarification?.suggestions?.length
    ? 'Call live_wayfinding_status again with floorId set to a suggestion id from clarification.suggestions.'
    : 'Call live_wayfinding_status again with a building or floor name.',
});

const CHECK_LIVE_CLI_ACTION = {
  id: 'check_live_wayfinding_cli',
  label: 'Update or run a Density CLI with live wayfinding JSON support.',
};

const liveWayfindingFailure = ({ query, dataDir, error, artifactRequired }) => ({
  ok: false,
  sourceLayer: SOURCE_LAYERS.liveFeed,
  sourceBadge: sourceBadgeFor(SOURCE_LAYERS.liveFeed),
  liveAvailable: false,
  walkableRecommendation: false,
  query,
  dataDir,
  error,
  fallbackAvailable: true,
  fallback: 'Use historical utilization only as context; it is not a walkable recommendation.',
  artifactRequired: artifactRequired ? 'floorplan' : undefined,
  userVisiblePrimaryActions: 1,
});

// Fallback for a CLI without commands.liveFloorplan: a second process renders the floorplan.
const attachSeparateFloorplan = async ({ cli, dataDir, timeoutMs, parsed, floorId }) => {
  const floorplanCommand = ['wayfinding', 'floorplan', '--floor', floorId, '--format', 'json'];
  const floorplanSpaceIds = [
    ...(Array.isArray(parsed.matchedSpaceIds) ? parsed.matchedSpaceIds : []),
    ...wayfindingSpaces(parsed).map((space) => space?.spaceId),
  ];
  const matchedSpaceIds = [...new Set(
    floorplanSpaceIds.filter((spaceId) => typeof spaceId === 'string' && spaceId.length > 0),
  )];
  for (const spaceId of matchedSpaceIds) {
    floorplanCommand.push('--focus-space', spaceId);
  }
  const floorplanResult = await runDensity(cli, floorplanCommand, {
    dataDir,
    allowFailure: true,
    timeoutMs,
  });
  if (floorplanResult.code === 0 && !floorplanResult.timedOut) {
    const floorplan = parseJsonOutput(floorplanResult.stdout, 'Live floorplan');
    parsed.floorplanArtifact = floorplan.artifact;
    parsed.floorplanPanelTarget = floorplan.panelTarget;
  } else {
    parsed.floorplanError = floorplanResult.timedOut
      ? 'Live floorplan timed out.'
      : oneLine(floorplanResult.stderr || floorplanResult.stdout);
  }
};

export async function liveWayfindingStatus(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is required.');
  const dataDir = resolveDataDir(args.dataDir);
  const timeoutMs = args.timeoutMs === undefined ? 30000 : Number(args.timeoutMs);
  const maxAgeSeconds = args.maxAgeSeconds === undefined ? 30 : Number(args.maxAgeSeconds);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number.');
  }
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error('maxAgeSeconds must be a positive number.');
  }
  const building = String(args.building || '').trim();
  const floor = String(args.floor || '').trim();
  if (args.floorId && floor) throw new Error('Provide floor or floorId, not both.');
  const artifactRequired = args.floorplanArtifactRequired;
  let cli;
  try {
    cli = await requireCli();
  } catch (error) {
    if (!error?.nextAction) throw error;
    return { ...liveWayfindingFailure({ query, dataDir, error: error.message, artifactRequired }), nextAction: error.nextAction };
  }
  // Old builds advertise wayfindingLiveAvailability too; only liveScopeQueries proves name resolution.
  const capabilities = await discoverCliCapabilities(cli, { dataDir });
  const commands = capabilities.commands ?? {};
  if ((building || floor) && !commands.liveScopeQueries) {
    return {
      ...liveWayfindingFailure({
        query,
        dataDir,
        error: `Density CLI ${capabilities.version ?? 'unknown'} cannot resolve building or floor names.`,
        artifactRequired,
      }),
      nextAction: INSTALL_MANAGED_CLI_ACTION,
    };
  }
  let floorId = args.floorId ? String(args.floorId) : undefined;
  const singleProcessFloorplan = args.includeFloorplan === true && Boolean(commands.liveFloorplan);
  const command = ['live', query, '--format', 'json'];
  if (floorId) command.push('--floor', floorId);
  if (building) command.push('--building-query', building);
  if (floor) command.push('--floor-query', floor);
  command.push('--live-timeout-ms', String(timeoutMs));
  command.push('--max-age-seconds', String(maxAgeSeconds));
  if (singleProcessFloorplan) command.push('--floorplan');
  const result = await runDensity(cli, command, {
    dataDir,
    allowFailure: true,
    timeoutMs: timeoutMs + 2000,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      ...liveWayfindingFailure({
        query,
        dataDir,
        error: result.timedOut ? 'Live wayfinding timed out.' : oneLine(result.stderr || result.stdout),
        artifactRequired,
      }),
      nextAction: CHECK_LIVE_CLI_ACTION,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ...liveWayfindingFailure({
        query,
        dataDir,
        error: `Live wayfinding response was not JSON: ${error.message}`,
        artifactRequired,
      }),
      nextAction: CHECK_LIVE_CLI_ACTION,
    };
  }
  const profile = { organizationId: parsed?.organizationId, organizationName: parsed?.organizationName };
  if (parsed?.kind === 'density.live-error.v1') {
    return {
      ...liveWayfindingFailure({
        query,
        dataDir,
        error: parsed.error?.message || 'Live wayfinding failed.',
        artifactRequired,
      }),
      ...profile,
      ...(parsed.clarification
        ? { needsInput: true, clarification: parsed.clarification, nextAction: chooseScopeAction(parsed.clarification) }
        : {}),
    };
  }
  floorId ??= parsed?.query?.floorId;
  if (args.includeFloorplan === true && !singleProcessFloorplan && floorId) {
    await attachSeparateFloorplan({ cli, dataDir, timeoutMs, parsed, floorId });
  }
  const availabilityMode = parsed.availabilityMode;
  if (availabilityMode !== 'live') {
    return {
      ok: false,
      needsInput: true,
      sourceLayer: SOURCE_LAYERS.liveFeed,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.liveFeed),
      liveAvailable: false,
      walkableRecommendation: false,
      query,
      dataDir,
      ...profile,
      availabilityMode,
      clarification: parsed.clarification,
      artifactRequired: artifactRequired ? 'floorplan' : undefined,
      nextAction: chooseScopeAction(parsed.clarification),
      userVisiblePrimaryActions: 1,
    };
  }
  const response = {
    ok: true,
    sourceLayer: SOURCE_LAYERS.liveFeed,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.liveFeed),
    liveAvailable: true,
    walkableRecommendation: Array.isArray(parsed.candidates) && parsed.candidates.length > 0,
    query,
    dataDir,
    ...profile,
    availabilityMode,
    freshness: {
      source: 'live-presence:wayfinding',
      maxAgeSeconds,
      requestedMaxAgeSeconds: maxAgeSeconds,
      fallbackAvailable: false,
    },
    summary: compactWayfindingSummary(parsed),
    artifact: parsed.artifact,
    html: parsed.artifact?.html,
    panelTarget: parsed.panelTarget,
    floorplanArtifact: parsed.floorplanArtifact,
    floorplanHtml: parsed.floorplanArtifact?.html,
    floorplanPanelTarget: parsed.floorplanPanelTarget,
    floorplanError: parsed.floorplanError,
    floorplanClarification: parsed.floorplanClarification,
    artifactRequired: artifactRequired ? 'floorplan' : undefined,
    userVisiblePrimaryActions: 0,
  };
  if (args.includeRaw === true) response.result = parsed;
  if (args.includeDiagnostics === true) {
    response.floorId = args.floorId;
    response.cli = safeCliInfo(cli);
  }
  return response;
}

const sanitizeBenchmarkCohort = (cohort) => {
  if (!cohort || typeof cohort !== 'object' || Array.isArray(cohort)) {
    return undefined;
  }
  const allowedKeys = ['label', 'cohortLabel', 'metro', 'region', 'country', 'industry', 'spaceType', 'buildingType', 'sizeBand'];
  const safeEntries = allowedKeys
    .filter((key) => typeof cohort[key] === 'string' || typeof cohort[key] === 'number')
    .map((key) => [key, cohort[key]]);
  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined;
};

export async function benchmarkCompare(args = {}) {
  const cohort = sanitizeBenchmarkCohort(args.cohort);
  return {
    ok: false,
    unsupported: true,
    sourceLayer: SOURCE_LAYERS.benchmarkNetworkContext,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.benchmarkNetworkContext),
    displaySafe: true,
    metric: args.metric,
    cohort,
    message: 'Benchmark comparison requires a Density benchmark API or approved benchmark snapshot. Do not infer peer context from local customer Parquet.',
    contract: {
      allowedOutput: ['metric', 'cohortLabel', 'sampleSizeStatus', 'percentileOrRange', 'confidence', 'caveats', 'recommendation'],
      forbiddenOutput: ['peerRows', 'peerOrgIds', 'rawDistributions', 'histogramBuckets'],
    },
    nextAction: {
      id: 'connect_benchmark_api',
      label: 'Connect an approved Density benchmark source.',
    },
    userVisiblePrimaryActions: 1,
  };
}

const normalizedScopeName = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/\b(?:the|building|site|office|location|floor)\b/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const SENSOR_STATUS_PREPOSITIONAL_PHRASE = /\b(?:in|at)\s+(?:(?:an?|the)\s+)?(?:errors?(?:\s+(?:state|status|condition))?|(?:good|bad|poor)\s+health|healthy|unhealthy|online|offline|unconfigured|stale|(?:in\s+)?need(?:ing)?\s+(?:of\s+)?attention|risk)(?=\b)/gi;

const unsupportedSensorQuestionResponse = (question, contract = {
  source: 'density_cloud_only',
  noLocalDuckdbFallback: true,
  rawStatusPreserved: true,
}) => ({
  ok: false,
  unsupported: true,
  question,
  sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
  sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
  sourceLabel: 'Density Sensor Health',
  contract,
  message: 'This question is outside the supported sensor health or status vocabulary. No substitute sensor question was run.',
  userVisiblePrimaryActions: 0,
});

const requestedNamedScope = (question) => {
  const text = String(question ?? '').replace(SENSOR_STATUS_PREPOSITIONAL_PHRASE, '');
  const namedMatch = text.match(/\b(?:in|at)\s+(?:the\s+)?(.+?)(?=\s+(?:are|is|has|have|with)\b|[?!,.]|$)/i);
  const floorMatch = text.match(/\bon\s+(?:the\s+)?((?:floor|level)\s+[\p{L}\p{N}'-]+)(?=\s|[?!,.]|$)/iu);
  const rawScope = namedMatch?.[1] ?? floorMatch?.[1];
  if (!rawScope) return undefined;
  const scope = normalizedScopeName(rawScope);
  return /^(?:this|that|the)?\s*(?:moment|time|present|same time|last heartbeat)$/.test(scope) ? undefined : scope;
};

const UNAMBIGUOUS_MONTH_NAME = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_NAME = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';

const requestsHistoricalSensorSnapshot = (question) => {
  if (!/\b(?:sensors?|sensor[-\s]?health|live signal|presence signal|heartbeats?|last[-\s]?seen)\b/i.test(question)) return false;
  const normalized = question.toLowerCase();
  return /\b(?:were|was|had|did|reported|went|became|stopped|came|previously|earlier|before)\b/.test(normalized)
    || /\b(?:has|have)\s+been\b/.test(normalized)
    || /\byesterday\b|\blast\s+(?:week|month|quarter|year)\b|\bpast\s+(?:\d+\s+)?(?:days?|weeks?|months?|quarters?|years?)\b/.test(normalized)
    || /\bago\b/.test(normalized)
    || /\b(?:since|between)\b/.test(normalized)
    || new RegExp(`\\b${UNAMBIGUOUS_MONTH_NAME}\\b`, 'i').test(question)
    || /\b(?:in|during|for|from|since|through)\s+may\b|\bmay\s+\d{1,2}\b/i.test(question)
    || new RegExp(`\\bon\\s+${WEEKDAY_NAME}\\b`, 'i').test(question)
    || /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(question);
};

const requestsUnapprovedSignalDiagnosis = (question) => {
  const normalized = question.toLowerCase();
  return /\bheartbeats?\b|\blast[-\s]?seen\b|\bstale\b/.test(normalized)
    || /\b(?:live|presence)\s+signals?\b/.test(normalized)
    || /\bsignals?[-\s]+(?:is\s+|are\s+)?(?:health|healthy|unhealthy|offline|online|missing)\b/.test(normalized)
    || /\bhealth\s+of\s+(?:the\s+)?(?:live\s+|presence\s+)?signals?\b/.test(normalized);
};

const safeSensorStatusCounts = (statusCounts) => {
  if (!Array.isArray(statusCounts) || statusCounts.length === 0) throw new Error('Missing sensor status aggregates.');
  return statusCounts.map((entry) => {
    if (typeof entry?.status !== 'string' || !entry.status.trim() || !Number.isInteger(entry.count) || entry.count < 0) {
      throw new Error('Invalid sensor status aggregate.');
    }
    return { status: entry.status.trim(), count: entry.count };
  });
};

const validateAndAllowlistSensorResponse = async ({ response, question, elapsedMs, targetMs }) => {
  const ui = response.ui;
  const answerProps = ui?.jsonRender?.spec?.elements?.answer?.props ?? {};
  const state = ui?.jsonRender?.spec?.state ?? {};
  const stateAnswer = state.answer ?? {};
  const sensorHealth = state.sensorHealth ?? {};
  const freshness = answerProps.freshness;
  const answerBenchmark = answerProps.benchmark;
  const stateBenchmark = state.benchmark;

  if (answerProps.sourceLayer !== SOURCE_LAYERS.cloudSensorHealth
    || answerProps.sourceBadge !== sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth)
    || answerProps.sourceLabel !== 'Density Sensor Health') {
    throw new Error('Invalid sensor source contract.');
  }
  if (freshness?.source !== 'sensor_health_api') throw new Error('Invalid sensor freshness contract.');
  if (typeof freshness.observedAt !== 'string' || !Number.isFinite(Date.parse(freshness.observedAt))) {
    throw new Error('Invalid sensor observation timestamp.');
  }
  if (typeof response.chart !== 'string' || !await fileExists(response.chart)
    || typeof response.html !== 'string' || !await fileExists(response.html)) {
    throw new Error('Missing sensor chart artifacts.');
  }
  if (sensorHealth.complete !== true) throw new Error('Incomplete sensor aggregate.');
  if (answerBenchmark?.state !== 'not_comparable' || stateBenchmark?.state !== 'not_comparable') {
    throw new Error('Invalid sensor benchmark contract.');
  }
  if (!answerProps.title || !answerProps.subtitle
    || answerProps.title !== stateAnswer.title
    || answerProps.subtitle !== stateAnswer.subtitle) {
    throw new Error('Mismatched sensor answer contract.');
  }

  const countKeys = ['cloudSensorCount', 'eligibleSensorCount', 'excludedSensorCount'];
  if (countKeys.some((key) => !Number.isInteger(sensorHealth[key]) || sensorHealth[key] < 0)) {
    throw new Error('Invalid sensor aggregate counts.');
  }
  const statusCounts = safeSensorStatusCounts(sensorHealth.statusCounts);
  const statusTotal = statusCounts.reduce((sum, entry) => sum + entry.count, 0);
  if (sensorHealth.eligibleSensorCount + sensorHealth.excludedSensorCount !== sensorHealth.cloudSensorCount
    || statusTotal !== sensorHealth.eligibleSensorCount) {
    throw new Error('Inconsistent sensor aggregate counts.');
  }

  const returnedScope = state.chartSpec?.filters?.scope;
  const requestedScope = requestedNamedScope(question);
  const returnedScopeName = normalizedScopeName(returnedScope?.label);
  const effectiveScope = answerProps.effectiveScope;
  const effectiveScopeNames = ['organizationName', 'buildingName', 'floorName']
    .map((key) => normalizedScopeName(effectiveScope?.[key]))
    .filter(Boolean);
  const returnedScopeNames = [returnedScopeName, ...effectiveScopeNames].filter(Boolean);
  if (requestedScope && !returnedScopeNames.some((name) => name.includes(requestedScope) || requestedScope.includes(name))) {
    const error = new Error('Sensor health response scope did not match the requested scope.');
    error.code = 'SCOPE_MISMATCH';
    throw error;
  }

  const caveats = Array.isArray(answerProps.caveats)
    ? answerProps.caveats.filter((value) => typeof value === 'string')
    : [];
  if (/\bwhy\b/i.test(question)) {
    caveats.push('This current snapshot cannot diagnose the underlying root cause; use sensor telemetry and operational logs for that investigation.');
  }
  const confidence = answerProps.confidence && typeof answerProps.confidence === 'object'
    ? {
        level: typeof answerProps.confidence.level === 'string' ? answerProps.confidence.level : undefined,
        reasons: Array.isArray(answerProps.confidence.reasons)
          ? answerProps.confidence.reasons.filter((value) => typeof value === 'string')
          : [],
      }
    : undefined;
  const scope = returnedScopeName
    ? {
        label: String(returnedScope.label),
        type: typeof returnedScope.type === 'string' ? returnedScope.type : undefined,
      }
    : undefined;
  const rows = Array.isArray(state.rows)
    ? state.rows.map((row) => {
        if (typeof row?.label !== 'string' || !row.label.trim()
          || !Number.isInteger(row.value) || row.value < 0
          || (row.detail !== undefined && typeof row.detail !== 'string')) {
          throw new Error('Invalid sensor location aggregate.');
        }
        return {
          label: row.label.trim(),
          value: row.value,
          ...(row.detail === undefined ? {} : { detail: row.detail }),
        };
      })
    : [];
  return {
    ok: true,
    sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
    sourceLabel: 'Density Sensor Health',
    question,
    title: answerProps.title,
    subtitle: answerProps.subtitle,
    chart: response.chart,
    html: response.html,
    png: response.png,
    effectiveScope: {
      ...(typeof effectiveScope?.organizationName === 'string' ? { organizationName: effectiveScope.organizationName } : {}),
      ...(typeof effectiveScope?.buildingName === 'string' ? { buildingName: effectiveScope.buildingName } : {}),
      ...(typeof effectiveScope?.floorName === 'string' ? { floorName: effectiveScope.floorName } : {}),
      ...(scope ? { selectedScope: scope } : {}),
    },
    rows,
    freshness: {
      source: freshness.source,
      observedAt: typeof freshness.observedAt === 'string' ? freshness.observedAt : undefined,
      mappingSnapshotAt: typeof freshness.mappingSnapshotAt === 'string' ? freshness.mappingSnapshotAt : undefined,
    },
    confidence,
    caveats,
    benchmark: {
      state: 'not_comparable',
      summary: typeof answerBenchmark.summary === 'string' ? answerBenchmark.summary : undefined,
    },
    sensorHealth: {
      cloudSensorCount: sensorHealth.cloudSensorCount,
      eligibleSensorCount: sensorHealth.eligibleSensorCount,
      excludedSensorCount: sensorHealth.excludedSensorCount,
      statusCounts,
      complete: true,
      pageCount: Number.isInteger(sensorHealth.pageCount) && sensorHealth.pageCount >= 0 ? sensorHealth.pageCount : undefined,
    },
    performance: {
      elapsedMs,
      targetMs,
      cliElapsedMs: Number.isFinite(response.performance?.elapsedMs) ? response.performance.elapsedMs : undefined,
    },
  };
};

export async function sensorHealthReport(args = {}) {
  const mode = args.mode === undefined ? 'current' : String(args.mode);
  if (mode !== 'current' && mode !== 'history') {
    return {
      ok: false,
      unsupported: true,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      message: `Sensor health mode '${mode}' is not supported. Use current or history.`,
      userVisiblePrimaryActions: 0,
    };
  }
  if (mode === 'history') {
    if (typeof args.building !== 'string' || !args.building.trim()
      || typeof args.start !== 'string' || !args.start.trim()
      || typeof args.end !== 'string' || !args.end.trim()) {
      return {
        ok: false,
        invalid: true,
        sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
        sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
        sourceLabel: 'Density Sensor Health',
        message: 'Historical sensor health requires building, start, and end.',
        userVisiblePrimaryActions: 0,
      };
    }
    if (args.floor !== undefined || args.status !== undefined || args.sensor !== undefined || args.includeSensors !== undefined) {
      return {
        ok: false,
        invalid: true,
        sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
        sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
        sourceLabel: 'Density Sensor Health',
        message: 'Historical sensor health currently supports one building without floor, status, or sensor filters.',
        userVisiblePrimaryActions: 0,
      };
    }
    const response = await runCapabilityJsonCommand(args, {
      capability: 'sensorHealthHistory',
      cliArgs: [
        'sensor-health', 'history',
        '--building', args.building.trim(),
        '--start', args.start.trim(),
        '--end', args.end.trim(),
        '--interval', args.interval === undefined ? 'day' : String(args.interval),
        ...(args.includeChart === true ? ['--chart'] : []),
        '--format', 'json',
      ],
      timeoutMs: 45000,
      unsupportedError: 'This Density CLI does not support historical sensor health yet.',
      timedOutError: 'Historical sensor-health request timed out.',
      responseLabel: 'Historical sensor-health',
      payloadKey: 'report',
      nextAction: {
        id: 'update_cli_for_sensor_health_history',
        label: 'Update the Density CLI to access historical sensor health.',
        command: 'density capabilities --format json',
      },
    });
    return args.includeChart === true
      ? attachQueryChartPreview(response, args, {}, 'report')
      : response;
  }
  const repeated = (value) => Array.isArray(value) ? value : value === undefined ? [] : [value];
  return runCapabilityJsonCommand(args, {
    capability: 'sensorHealthCurrent',
    cliArgs: [
      'sensor-health', 'current',
      ...(typeof args.building === 'string' && args.building.trim() ? ['--building', args.building.trim()] : []),
      ...(typeof args.floor === 'string' && args.floor.trim() ? ['--floor', args.floor.trim()] : []),
      ...repeated(args.status).flatMap((value) => typeof value === 'string' && value.trim() ? ['--status', value.trim()] : []),
      ...repeated(args.sensor).flatMap((value) => typeof value === 'string' && value.trim() ? ['--sensor', value.trim()] : []),
      ...(args.includeSensors === true ? ['--include-sensors'] : []),
      '--format', 'json',
    ],
    timeoutMs: 15000,
    unsupportedError: 'This Density CLI does not support current sensor-health data yet.',
    timedOutError: 'Current sensor-health request timed out.',
    responseLabel: 'Current sensor-health',
    payloadKey: 'report',
    nextAction: {
      id: 'update_cli_for_sensor_health',
      label: 'Update the Density CLI to access current sensor health.',
      command: 'density capabilities --format json',
    },
  });

}

function localHistoricalProvenance({ dataDir, tool }) {
  return {
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    tool,
    dataDir,
    freshness: 'local_parquet_checked_by_setup_or_query',
    caveat: 'Local historical data answers customer-owned utilization questions; benchmark context and live availability require separate Density sources.',
  };
}

export async function createDemoCustomer(args = {}) {
  const sourceDir = args.sourceDir || defaultDemoSourceDir();
  const outDir = args.outDir || path.join(os.homedir(), '.density-cli-demo-customer');
  const days = boundedGenericDays(args.days);
  return { sourceDir, outDir, days };
}

export async function requireCli() {
  const cli = await resolveDensityCli();
  if (!cli) throw new Error('Density CLI not found. Run install_managed_cli, set DENSITY_CLI_BIN, set DENSITY_CLI_REPO, or install density on PATH.');
  if (cli.managedMissing) {
    throw Object.assign(
      new Error(`The plugin pins Density CLI ${cli.managedMissing.version}, but it is not installed: ${cli.managedMissing.reason}. Run install_managed_cli.`),
      { nextAction: INSTALL_MANAGED_CLI_ACTION }
    );
  }
  await ensureDensityCliBuilt(cli);
  return cli;
}

export function boundedMetricsDays(value) {
  const days = value === undefined ? DEFAULT_METRICS_DAYS : Number(value);
  if (!Number.isInteger(days) || days <= 0 || days > MAX_METRICS_DAYS) {
    throw new Error(`days must be an integer between 1 and ${MAX_METRICS_DAYS} for metrics preload.`);
  }
  return days;
}

export function metricsIntervalForDays(days) {
  return days <= MAX_15M_METRICS_DAYS ? '15m' : '1h';
}

export function historicalIntervalForDays(days) {
  return days <= MAX_15M_METRICS_DAYS ? '15m' : '1h';
}

export function boundedHistoricalExportDays(value) {
  const days = value === undefined ? DEFAULT_HISTORICAL_EXPORT_DAYS : Number(value);
  if (!Number.isInteger(days) || days <= 0 || days > MAX_HISTORICAL_EXPORT_DAYS) {
    throw new Error(`days must be an integer between 1 and ${MAX_HISTORICAL_EXPORT_DAYS} for historical export.`);
  }
  return days;
}

export function boundedGenericDays(value) {
  const days = value === undefined ? 14 : Number(value);
  if (!Number.isInteger(days) || days <= 0 || days > 60) {
    throw new Error('days must be an integer between 1 and 60.');
  }
  return days;
}
