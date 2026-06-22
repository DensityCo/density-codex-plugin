import path from 'node:path';
import os from 'node:os';
import {
  checkPluginUpdate,
  defaultDataDir,
  discoverCliCapabilities,
  ensureDensityCliBuilt,
  installManagedCliRuntime,
  loadManagedCliManifest,
  localDataProfileReport,
  managedCliRuntimeStatus,
  missingRequiredCliCapabilities,
  renderPng,
  resolveDensityCli,
  runDensity,
  safeCliInfo,
  storageReport,
  which,
} from './density-lib.mjs';

export const DEFAULT_METRICS_DAYS = 14;
export const MAX_METRICS_DAYS = 14;
export const MAX_15M_METRICS_DAYS = 7;
export const DEFAULT_HISTORICAL_EXPORT_DAYS = 90;
export const MAX_HISTORICAL_EXPORT_DAYS = 365;

export const resolveDataDir = (value) => value || process.env.DENSITY_CLI_DATA_DIR || defaultDataDir();
const availableBuildingsSupported = (capabilities) => Boolean(capabilities.commands?.availableBuildings || capabilities.availableBuildings);

const SOURCE_LAYERS = {
  localCustomerData: 'local_customer_data',
  benchmarkNetworkContext: 'benchmark_network_context',
  liveFeed: 'live_feed',
  cloudSensorHealth: 'cloud_sensor_health',
};
const SOURCE_BADGES = {
  [SOURCE_LAYERS.localCustomerData]: 'Local',
  [SOURCE_LAYERS.benchmarkNetworkContext]: 'Benchmark',
  [SOURCE_LAYERS.liveFeed]: 'Live',
  [SOURCE_LAYERS.cloudSensorHealth]: 'Sensor Health',
};
const chartContextCache = new Map();

const oneLine = (value) => String(value ?? '').trim();
const sourceBadgeFor = (sourceLayer) => SOURCE_BADGES[sourceLayer] ?? 'Mixed';

const chartContextKey = (dataDir) => path.resolve(dataDir);

const isChartFollowUpQuestion = (question) =>
  /\b(show|make|turn|render|chart|graph|visuali[sz]e)\b.*\b(that|this|it|same)\b/i.test(question)
  || /\b(that|this|it|same)\b.*\b(as a chart|as chart|chart|graph|visuali[sz]e)\b/i.test(question);

const isContextualAnalyticsFollowUp = (question) =>
  (
    /\b(?:normaliz(?:e|ed|ing)|normalis(?:e|ed|ing)|average|avg|per day)\b.*\b(?:that|this|it|same)\b/i.test(question)
    || /\b(?:that|this|it|same)\b.*\b(?:normaliz(?:e|ed|ing)|normalis(?:e|ed|ing)|average|avg|per day)\b/i.test(question)
    || /\buse\b.+\binstead\b/i.test(question)
    || /\b(what about|how about)\b/i.test(question)
  )
  && !isChartFollowUpQuestion(question);

const FLOOR_PATTERN = /\b(?:floor|fl|level)\s+([a-z0-9-]+)\b|\b((?:\d+)(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)\s+floor\b/i;
const KNOWN_BUILDING_PATTERN = /\b(empire state(?: building)?|lny2|esb|chrysler building|33 new montgomery|maude|b3)\b/i;
const DAY_NAME_PATTERN = /\b(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b/i;
const TIME_RANGE_PATTERN = /\b(?:from|between)\s+\d{1,2}\s*(?:a|p)?\.?m?\.?\s*(?:to|through|until|and|-)\s+\d{1,2}\s*(?:a|p)?\.?m?\.?\b/i;
const AFTER_TIME_PATTERN = /\bafter\s+\d{1,2}\s*(?:a|p)\.?m\.?\b/i;
const DAYPART_PATTERN = /\b(morning|afternoon|evening|around lunch|lunch|working hours|business hours)\b/i;

const cleanSpaces = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const withoutPriorFloor = (value) => cleanSpaces(
  value
    .replace(/\b(?:on|in|for|across)?\s*(?:the\s*)?(?:floor|fl|level)\s+[a-z0-9-]+\b/ig, ' ')
    .replace(/\b(?:on|in|for|across)?\s*(?:the\s*)?(?:\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)\s+floor\b/ig, ' ')
);

const withoutKnownBuilding = (value) => cleanSpaces(
  value.replace(/\b(empire state(?: building)?|lny2|esb|chrysler building|33 new montgomery|maude|b3)\b/ig, ' ')
);

const withoutPriorDayFilter = (value) => cleanSpaces(
  value.replace(/\b(weekdays?|weekends?|business days?|working days?|work days?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b/ig, ' ')
);

const withoutPriorTimeFilter = (value) => cleanSpaces(
  value
    .replace(/\b(?:from|between)\s+\d{1,2}\s*(?:a|p)?\.?m?\.?\s*(?:to|through|until|and|-)\s+\d{1,2}\s*(?:a|p)?\.?m?\.?\b/ig, ' ')
    .replace(/\bafter\s+\d{1,2}\s*(?:a|p)\.?m\.?\b/ig, ' ')
    .replace(/\b(?:in the\s+)?(?:morning|afternoon|evening)\b/ig, ' ')
    .replace(/\b(?:around\s+)?lunch\b/ig, ' ')
    .replace(/\b(?:working|business)\s+hours\b/ig, ' ')
);

const contextualFilterRewrite = (rewritten, question) => {
  let next = rewritten;
  const floorMatch = question.match(FLOOR_PATTERN);
  if (floorMatch) {
    next = withoutPriorFloor(next);
    next = `${next} on ${floorMatch[1] ? `floor ${floorMatch[1]}` : `the ${floorMatch[2]} floor`}`;
  }

  const buildingMatch = question.match(KNOWN_BUILDING_PATTERN);
  if (buildingMatch) {
    next = withoutKnownBuilding(next);
    next = `${next} in ${buildingMatch[1]}`;
  }

  const dayNameMatch = question.match(DAY_NAME_PATTERN);
  if (dayNameMatch) {
    next = `${withoutPriorDayFilter(next)} on ${dayNameMatch[1]}`;
  } else if (/\bweekends?\b/i.test(question)) {
    next = `${withoutPriorDayFilter(next)} on weekends`;
  } else if (/\b(weekdays?|business days?|working days?|work days?)\b/i.test(question)) {
    next = `${withoutPriorDayFilter(next)} on weekdays`;
  }

  const timeRangeMatch = question.match(TIME_RANGE_PATTERN);
  const afterTimeMatch = question.match(AFTER_TIME_PATTERN);
  const daypartMatch = question.match(DAYPART_PATTERN);
  if (timeRangeMatch) {
    next = `${withoutPriorTimeFilter(next)} ${timeRangeMatch[0]}`;
  } else if (afterTimeMatch) {
    next = `${withoutPriorTimeFilter(next)} ${afterTimeMatch[0]}`;
  } else if (daypartMatch) {
    next = `${withoutPriorTimeFilter(next)} during ${daypartMatch[1]}`;
  }

  return cleanSpaces(next);
};

const rewriteContextualQuestion = (question, prior) => {
  if (!prior?.question) return question;
  let rewritten = prior.question;
  if (/\b(phone booths?|booths?)\b/i.test(question)) {
    rewritten = rewritten.replace(/\b(conference|meeting)\s+rooms?\b/ig, 'phone booths');
    rewritten = rewritten.replace(/\brooms?\b/ig, 'phone booths');
    rewritten = rewritten.replace(/\bphone booths\s+(size|capacity|capacities|seat|seats)\b/ig, 'phone booth $1');
    if (!/\b(phone booths?|booths?)\b/i.test(rewritten)) rewritten = `${rewritten} for phone booths`;
  } else if (/\b(conference|meeting)\s+rooms?\b/i.test(question)) {
    rewritten = rewritten.replace(/\bphone booths?\b/ig, 'meeting rooms');
    if (!/\b(conference|meeting)\s+rooms?\b/i.test(rewritten)) rewritten = `${rewritten} for meeting rooms`;
  }
  if (/\b(normaliz(?:e|ed|ing)|normalis(?:e|ed|ing)|average|avg|per day)\b/i.test(question)
    && !/\b(normaliz(?:e|ed|ing)|normalis(?:e|ed|ing)|average|avg|per day)\b/i.test(rewritten)) {
    rewritten = `${rewritten} average occupied hours per day`;
  }
  const explicitRange = /\b(?:from|between|use)?\s*(?:like\s*)?(six|6)\s*a\.?m\.?\s*(?:to|through|until|and|-)\s*(?:like\s*)?(six|6)\s*p\.?m\.?\b/i.test(question);
  if (explicitRange && !/\b6\s*a\.?m\.?\s*(?:to|through|until|and|-)\s*6\s*p\.?m\.?\b/i.test(rewritten)) {
    rewritten = `${rewritten} from 6am to 6pm`;
  }
  return contextualFilterRewrite(rewritten, question);
};

const cleanCoverageValue = (value) => {
  const text = String(value ?? '').trim();
  return text && text.toLowerCase() !== 'null' ? text : undefined;
};

const dataCoverageIntent = (question) =>
  /\b(what data do we have|which data do we have|what local historical data|local historical data available|available local data|local data profile|data coverage|coverage report|readiness|ready to answer|storage report)\b/i.test(question);

const broadScopeSelectionIntent = (question) => (
  /\b(any one|any 1|pick (?:one|a)|choose (?:one|a)|select (?:one|a)|one (?:of|building|site|office|location))\b/i.test(question)
  && /\b(buildings?|sites?|offices?|locations?)\b/i.test(question)
);

const noMatchingLocalScope = ({ title = '', subtitle = '' } = {}) => (
  /\bno matching local scope\b/i.test(title)
  || /\bnot found in local (?:atlas )?metadata\b/i.test(subtitle)
);

const dataHealthIntent = (question) =>
  dataCoverageIntent(question)
  || /\b(can (?:we|i) trust|trustworthy|diagnos(?:e|is|tic)|data[-\s]?health|why (?:is|are).*(?:zero|missing|stale)|all .*zero|zeros?|stale (?:data|cache|local data)|missing (?:data|metrics|rows)|fresh(?:ness)? of (?:the )?(?:data|cache|local data)|is (?:the )?(?:data|cache|local data).*(?:fresh|stale|ready)|sync gaps?|data gaps?)\b/i.test(question);

const sensorHealthIntent = (question) =>
  /\b(sensor(?:s)?|sensor[-\s]?health|live signal|presence signal|offline|health of (?:the )?sensor|signal stale|stale signal)\b/i.test(question);

const historicalAvailabilityIntent = (question) =>
  /\b(how often|frequency|percent|percentage|share of time|historical|history|trend|over time|last|past|weekday|weekend|rank(?:ing)?|popular|busiest|least used|most occupied|least occupied|utili[sz]ation|used hours?|average|avg)\b/i.test(question);

const availabilityScopeIntent = (question) =>
  /\b(meeting rooms?|conference rooms?|rooms?|phone booths?|booths?|desks?|seats?|spaces?|floors?|buildings?|where|wayfinding)\b/i.test(question);

const currentAvailabilityIntent = (question) => {
  if (/\b(local historical data|available local data|what data do we have)\b/i.test(question)) return false;
  const availabilityText = question.replace(/\bopen collaboration spaces?\b/ig, 'collaboration spaces');
  const liveWord = /\b(now|right now|currently|current|live|real[-\s]?time|wayfinding)\b/i.test(question);
  const availabilityWord = /\b(available|availability|open|occupied|free|empty|vacant)\b/i.test(availabilityText);
  const scoped = availabilityScopeIntent(question);
  if (liveWord && (availabilityWord || scoped)) return true;
  if (/\b(?:available|open|occupied|free|empty|vacant)\s+now\b/i.test(availabilityText)) return true;
  if (historicalAvailabilityIntent(question)) return false;
  return (
    /\bfind\s+(?:me\s+)?(?:an?\s+)?(?:open|available|free|empty|vacant)\b/i.test(availabilityText)
    || (availabilityWord && scoped)
  );
};

const floorplanArtifactIntent = (question) => {
  const spatialScope = /\b(floors?|levels?|rooms?|spaces?|desks?|booths?|availability|usage|utili[sz]ation|occupancy)\b/i.test(question);
  return /\bfloor\s*plans?\b|\bfloorplans?\b/i.test(question)
    || (spatialScope && /\b(map|overlay|spatial|wayfind(?:ing)?|navigate|route)\b/i.test(question))
    || (spatialScope && /\bheat\s*map\b/i.test(question))
    || (/\b(show|visuali[sz]e|color|shade|draw|plot)\b/i.test(question) && /\b(on|onto|over)\s+(?:the\s+)?floor\b/i.test(question));
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
  if (typeof space?.available === 'boolean') return space.available ? 'available' : 'unavailable';
  return space?.availability ?? space?.status ?? space?.state ?? 'unknown';
};

const wayfindingSpaces = (parsed) => {
  if (Array.isArray(parsed?.spaces)) return parsed.spaces;
  const result = parsed?.result;
  return [
    ...(Array.isArray(result?.candidates) ? result.candidates : []),
    ...(Array.isArray(result?.unavailableMatches) ? result.unavailableMatches : []),
  ];
};

const compactWayfindingSummary = (parsed) => {
  const spaces = wayfindingSpaces(parsed);
  const counts = spaces.reduce((acc, space) => {
    const state = String(spaceAvailabilityState(space)).toLowerCase();
    if (state === 'available' || state === 'free' || state === 'vacant') acc.available += 1;
    else if (state === 'occupied') acc.occupied += 1;
    else if (state === 'unavailable') acc.unavailable += 1;
    else acc.unknown += 1;
    return acc;
  }, { available: 0, occupied: 0, unavailable: 0, unknown: 0 });
  const namedSpaces = spaces
    .map((space) => {
      const name = safeWayfindingName(space);
      return name ? { name, state: spaceAvailabilityState(space) } : undefined;
    })
    .filter(Boolean)
    .slice(0, 5);
  return {
    availabilityMode: parsed?.availabilityMode,
    spacesChecked: spaces.length,
    counts,
    spaces: namedSpaces.length ? namedSpaces : undefined,
  };
};

const rememberChartContext = (dataDir, result) => {
  if (!result?.ok) return;
  chartContextCache.set(chartContextKey(dataDir), {
    question: result.question,
    title: result.title,
    subtitle: result.subtitle,
    chart: result.chart,
    html: result.html,
    png: result.png,
    effectiveScope: result.effectiveScope,
    freshness: result.freshness,
    confidence: result.confidence,
    caveats: result.caveats,
    sourceLayer: result.sourceLayer,
    sourceBadge: result.sourceBadge,
    provenance: result.provenance,
  });
};

const readChartContext = (dataDir) => chartContextCache.get(chartContextKey(dataDir));

const parseJsonOutput = (stdout, label) => {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} was not JSON: ${error.message}`);
  }
};

const parseQuestionUiAnswer = async ({ question, dataDir, cli, result, tool }) => {
  let ui;
  try {
    ui = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Density UI response was not JSON: ${error.message}`);
  }
  const answerProps = ui.jsonRender?.spec?.elements?.answer?.props ?? {};
  const state = ui.jsonRender?.spec?.state ?? {};
  const svg = ui.artifacts?.svg ?? state.artifacts?.svg;
  const html = ui.artifacts?.html ?? state.artifacts?.html;
  const png = await renderPng(svg);
  const response = {
    ok: true,
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    provenance: localHistoricalProvenance({ dataDir, tool }),
    question,
    title: answerProps.title ?? '',
    subtitle: answerProps.subtitle ?? '',
    chart: svg,
    html,
    png,
    cache: ui.cache,
    effectiveScope: answerProps.effectiveScope ?? state.effectiveScope,
    freshness: answerProps.freshness ?? state.freshness,
    confidence: answerProps.confidence ?? state.confidence,
    caveats: answerProps.caveats ?? state.caveats,
    ui,
    dataDir,
    cli: safeCliInfo(cli),
  };
  if (broadScopeSelectionIntent(question) && noMatchingLocalScope(response)) {
    return {
      ...response,
      ok: false,
      intent: 'broad_scope_needs_resolution',
      title: 'I need a measured building scope',
      subtitle: 'The local question layer could not safely choose a building from that broad prompt, so this should not turn into manual DuckDB or Parquet work.',
      message: 'Ask for the available measured buildings, or name the building to compare.',
      chart: undefined,
      html: undefined,
      png: undefined,
      chartSuppressed: true,
      nextAction: {
        id: 'clarify_measured_building_scope',
        label: 'Ask which building to use, or ask what measured buildings are available.',
      },
      nextSteps: [
        'Ask which building to use, or ask what measured buildings are available.',
      ],
      recovery: {
        reason: 'Broad scope selection failed inside the local question layer.',
        preferredTool: 'answer_density_question',
        avoid: ['shell', 'DuckDB', 'SQL', 'manual Parquet scans', 'hand-built chart scripts'],
      },
    };
  }
  rememberChartContext(dataDir, response);
  return response;
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

  let capabilities = { checked: false, chartQuestions: false, reason: 'Density CLI not found.' };
  let missingRequiredCapabilities = [];
  let status;
  if (cli) {
    const build = await ensureDensityCliBuilt(cli);
    addCheck(checks, 'density cli built', true, build.reason);
    capabilities = await discoverCliCapabilities(cli, { dataDir });
    addCheck(
      checks,
      'density chart capability known',
      capabilities.checked,
      capabilities.checked
        ? (capabilities.chartQuestions ? 'chart questions supported' : 'chart questions not supported by this CLI')
        : capabilities.reason
    );
    addCheck(
      checks,
      'fast local question answering advertised',
      Boolean(capabilities.questionAnswering?.localFirst && capabilities.commands?.questionStarter),
      capabilities.questionAnswering?.localFirst && capabilities.commands?.questionStarter
        ? `${capabilities.questionAnswering.starterQuestionCount ?? '50+'} starter questions; target ${capabilities.questionAnswering.targetTextAnswerMs ?? 5000}ms text / ${capabilities.questionAnswering.targetChartAnswerMs ?? 10000}ms charts`
        : 'CLI does not advertise the fast local utilization question contract yet.'
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
  if (capabilities.commands?.questionStarter) {
    addCheck(
      checks,
      'fast question parquet ready',
      storage.fastQuestionsReady,
      storage.fastQuestionsReady
        ? `${storage.fastQuestionBytes} bytes across fast question tables`
        : `Missing fast question tables: ${storage.fastQuestionTables.filter((table) => !table.present).map((table) => table.table).join(', ') || 'unknown'}. Run full onboarding/export to sync spaces and metrics.`,
    );
  }
  let starterCache;
  if (cli && storage.parquetReady && storage.fastQuestionsReady && capabilities.commands?.questionStarter) {
    starterCache = await checkStarterCache(cli, dataDir);
    addCheck(
      checks,
      'fast starter answers ready',
      starterCache.ready && starterCache.useful !== false,
      starterReadyDetail(starterCache, capabilities.questionAnswering?.starterQuestionCount),
      { optional: true, starterCache }
    );
  }

  const update = await checkPluginUpdate();
  const usableCliSelected = Boolean(cli) && missingRequiredCapabilities.length === 0;
  const managedInstallNeeded = Boolean(managedManifest)
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
    cli && status?.code === 0 && storage.parquetReady && capabilities.commands?.questionStarter && !storage.fastQuestionsReady && capabilities.commands?.repairFastQuestions && hasResourcesParquet(storage) && {
      id: 'repair_fast_questions',
      label: 'Repair local fast-question metadata from resources.parquet.',
      tool: 'repair_fast_questions',
      args: { dataDir },
      command: 'density repair fast-questions --format json',
    },
    cli && status?.code === 0 && (!storage.parquetReady || (capabilities.commands?.questionStarter && !storage.fastQuestionsReady)) && {
      id: 'onboard_customer',
      label: 'Prepare local Density data.',
      tool: 'onboard_customer',
      args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true },
      command: `density sync --stream spaces && density sync --stream metrics --all-spaces --since ${DEFAULT_METRICS_DAYS}d --until now --interval ${metricsIntervalForDays(DEFAULT_METRICS_DAYS)} && density export parquet --out ${path.join(dataDir, 'parquet')} --all-orgs`,
    },
    cli && status?.code === 0 && !availableBuildingsSupported(capabilities) && {
      id: 'update_cli_for_building_lifecycle',
      label: 'Update the Density CLI for lifecycle-aware building analysis.',
      command: 'density capabilities --format json',
    },
    cli && status?.code === 0 && storage.parquetReady && !capabilities.chartQuestions && {
      id: 'chart_unsupported',
      label: 'Update the Density CLI for chart questions, or use local query/viz commands.',
      command: 'density capabilities --format json',
    },
    update.available && {
      id: 'plugin_update',
      label: update.prompt,
      command: update.command,
    },
  ]);

  return {
    ok: checks.every((check) => check.ok || check.optional),
    dataDir,
    cli: safeCliInfo(cli),
    checks,
    capabilities,
    storage,
    starterCache,
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
    return await installManagedCliRuntime({
      dataDir: resolveDataDir(args.dataDir),
      manifestPath: args.manifestPath,
      platform: args.platform,
      runtimeRoot: args.runtimeRoot,
      timeoutMs: args.timeoutMs,
    });
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
  const cli = await requireCli();
  const capabilities = await discoverCliCapabilities(cli, { dataDir });
  if (!availableBuildingsSupported(capabilities)) {
    return {
      ok: false,
      unsupported: true,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      message: 'This Density CLI does not support lifecycle-aware building readiness yet.',
      nextAction: {
        id: 'update_cli_for_building_lifecycle',
        label: 'Update/build a Density CLI that supports density available-buildings.',
        command: 'density capabilities --format json',
      },
      userVisiblePrimaryActions: 1,
    };
  }

  const result = await runDensity(cli, ['available-buildings', '--format', 'json'], {
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
  return {
    ok: true,
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    kind: parsed.kind,
    organizationId: parsed.organizationId,
    organizationName: parsed.organizationName,
    buildingCount: Number(parsed.buildingCount ?? buildings.length),
    buildings,
    summary: summarizeAvailableBuildings(buildings),
    contract: {
      queryNonLiveAllowed: true,
      discloseStatusAndGoLive: true,
      chartQueryableRequires: ['live_or_historical_metric_coverage', 'not_planning_only'],
      liveWayfindingRequires: ['live_status', 'past_go_live', 'mapped_geometry'],
      missingGoLiveHandling: 'caveat_not_live_claim',
    },
    dataDir,
    cli: safeCliInfo(cli),
    capabilities,
  };
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

export async function repairFastQuestions(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const result = await runDensity(cli, ['repair', 'fast-questions', '--format', 'json'], {
    dataDir,
    allowFailure: true,
    timeoutMs: 30000,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      dataDir,
      cli: safeCliInfo(cli),
      error: result.timedOut ? 'Fast-question repair timed out.' : oneLine(result.stderr || result.stdout),
      storage: await storageReport(dataDir),
      nextAction: {
        id: 'onboard_customer',
        label: 'Prepare local Density data.',
        tool: 'onboard_customer',
        args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true },
      },
      nextSteps: ['Prepare local Density data.'],
      userVisiblePrimaryActions: 1,
    };
  }
  let repair;
  try {
    repair = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      dataDir,
      cli: safeCliInfo(cli),
      error: `Fast-question repair response was not JSON: ${error.message}`,
      stdout: oneLine(result.stdout),
      storage: await storageReport(dataDir),
    };
  }
  const storage = await storageReport(dataDir);
  return {
    ok: storage.fastQuestionsReady,
    dataDir,
    cli: safeCliInfo(cli),
    repair,
    storage,
    nextAction: storage.fastQuestionsReady ? undefined : {
      id: 'onboard_customer',
      label: 'Prepare local Density data.',
      tool: 'onboard_customer',
      args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true },
    },
    nextSteps: storage.fastQuestionsReady ? [] : ['Prepare local Density data.'],
    userVisiblePrimaryActions: storage.fastQuestionsReady ? 0 : 1,
  };
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
  const prewarmQuestions = args.prewarmQuestions !== false;
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
  const runOptionalStep = async (name, commandArgs, options = {}) => {
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
      optional: true,
      timedOut: result.timedOut,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      stdout: oneLine(result.stdout),
      stderr: oneLine(result.stderr),
    };
    steps.push(step);
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
          label: 'Run explicit full sync when ready.',
          tool: 'onboard_customer',
          args: { dataDir, orgId: args.orgId, days, fullSync: true },
          command: `density ${metricsCommand.join(' ')}`,
        },
        nextSteps: ['Run explicit full sync when ready.'],
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
    let starterQuestions;
    if (storage.parquetReady && storage.fastQuestionsReady && prewarmQuestions) {
      const capabilities = await discoverCliCapabilities(cli, { dataDir });
      if (capabilities.commands?.questionStarter) {
        const step = await runOptionalStep('prewarm starter questions', ['question', '--starter', '--chart', '--format', 'json'], { timeoutMs });
        if (step.ok) {
          try {
            const parsed = JSON.parse(step.stdout);
            starterQuestions = {
              ok: true,
              ready: Boolean(parsed.readiness?.ready),
              ...starterUsefulness(parsed.readiness),
              readiness: parsed.readiness,
              artifactManifest: parsed.artifactManifest,
              cache: parsed.cache,
              questionCount: parsed.questionCount,
            };
          } catch (error) {
            starterQuestions = {
              ok: false,
              error: `Starter-question response was not JSON: ${error.message}`,
            };
          }
        } else {
          starterQuestions = {
            ok: false,
            error: step.timedOut ? 'Starter-question prewarm timed out.' : step.stderr || step.stdout,
          };
        }
      } else {
        starterQuestions = {
          ok: false,
          skipped: true,
          reason: 'Density CLI does not support starter-question prewarm.',
        };
      }
    }
    return {
      ok: storage.parquetReady && (!prewarmQuestions || storage.fastQuestionsReady),
      mode: 'full-sync',
      dataDir,
      days,
      cli: safeCliInfo(cli),
      steps,
      storage,
      starterQuestions,
      nextAction: storage.parquetReady && storage.fastQuestionsReady ? undefined : {
        id: 'export_parquet',
        label: 'Export Parquet after sync completes.',
        command: `density ${exportCommand.join(' ')}`,
      },
      nextSteps: storage.parquetReady && storage.fastQuestionsReady ? [] : ['Export Parquet after sync completes.'],
      userVisiblePrimaryActions: storage.parquetReady && storage.fastQuestionsReady ? 0 : 1,
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

  const metricsCommand = ['sync', '--stream', 'metrics', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', interval];
  const occupancyCommand = ['sync', '--stream', 'occupancy', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', '1h'];
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

export async function askChart(args = {}) {
  const question = String(args.question || '').trim();
  if (!question) throw new Error('question is required.');
  const dataDir = resolveDataDir(args.dataDir);
  const needsFloorplan = floorplanArtifactIntent(question);
  const liveIntent = currentAvailabilityIntent(question);
  if (needsFloorplan && !liveIntent) {
    return floorUsageReport({ ...args, question, dataDir });
  }
  if (liveIntent) {
    const response = await liveWayfindingStatus({
      ...args,
      query: question,
      dataDir,
      floorplanArtifactRequired: needsFloorplan,
    });
    return {
      ...response,
      question,
      intent: needsFloorplan ? 'live_wayfinding_floorplan' : 'live_wayfinding',
      routedTool: 'live_wayfinding_status',
      routedSkill: 'wayfinding',
      chartSuppressed: true,
      artifactRequired: needsFloorplan ? 'floorplan' : undefined,
    };
  }
  const cli = await requireCli();
  const capabilities = await discoverCliCapabilities(cli, { dataDir });
  if (!capabilities.chartQuestions) {
    return {
      ok: false,
      unsupported: true,
      question,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      message: 'This Density CLI does not support chart questions yet.',
      nextAction: {
        id: 'update_cli_for_chart_questions',
        label: 'Update/build a Density CLI that supports chart questions, or use density viz --html.',
        command: 'density capabilities --format json',
      },
      userVisiblePrimaryActions: 1,
    };
  }

  if (capabilities.generativeUi?.renderer === 'json-render' || capabilities.commands?.questionUi) {
    const cachedUiAnswer = await runDensity(cli, ['question', question, '--cached', '--chart', '--format', 'ui'], { dataDir, allowFailure: true });
    const uiAnswer = cachedUiAnswer.code === 0
      ? cachedUiAnswer
      : await runDensity(cli, ['question', question, '--chart', '--format', 'ui'], { dataDir, allowFailure: true });
    if (uiAnswer.code === 0) {
      const response = await parseQuestionUiAnswer({ question, dataDir, cli, result: uiAnswer, tool: 'ask_chart' });
      return { ...response, capabilities };
    }
  }

  const answer = await runDensity(cli, ['ask', question, '--chart', '--format', 'json'], { dataDir, allowFailure: true });
  if (answer.code !== 0) {
    return {
      ok: false,
      question,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      error: oneLine(answer.stderr || answer.stdout),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(answer.stdout);
  } catch (error) {
    throw new Error(`Density chart response was not JSON: ${error.message}`);
  }
  const png = await renderPng(parsed.chart);
  const response = {
    ok: true,
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    provenance: localHistoricalProvenance({ dataDir, tool: 'ask_chart' }),
    question,
    title: parsed.title ?? '',
    subtitle: parsed.subtitle ?? '',
    chart: parsed.chart,
    html: parsed.html,
    png,
    effectiveScope: parsed.effectiveScope,
    freshness: parsed.freshness,
    confidence: parsed.confidence,
    caveats: parsed.caveats,
    dataDir,
    cli: safeCliInfo(cli),
    capabilities,
  };
  rememberChartContext(dataDir, response);
  return response;
}

export async function floorUsageReport(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const command = ['viz', '--html', '--report', 'floor-usage', '--format', 'json'];
  if (args.outFile) command.push('--out', String(args.outFile));
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

export async function localUtilizationQuery(args = {}) {
  const question = String(args.question || '').trim();
  const dataDir = resolveDataDir(args.dataDir);
  const priorChart = readChartContext(dataDir);
  const needsFloorplan = floorplanArtifactIntent(question);
  if (sensorHealthIntent(question)) {
    const response = await sensorHealthReport(args);
    return {
      ...response,
      tool: 'local_utilization_query',
      routedTool: 'sensor_health_report',
      intent: 'sensor_health',
      routing: {
        fromTool: 'local_utilization_query',
        routedTool: 'sensor_health_report',
        intent: 'sensor_health',
        reason: 'Question asked about sensor or live signal health, which is cloud-only.',
      },
    };
  }
  if (currentAvailabilityIntent(question)) {
    const response = await liveWayfindingStatus({
      ...args,
      query: question,
      dataDir,
      floorplanArtifactRequired: needsFloorplan,
    });
    return {
      ...response,
      tool: 'local_utilization_query',
      routedTool: 'live_wayfinding_status',
      routedSkill: 'wayfinding',
      intent: needsFloorplan ? 'live_wayfinding_floorplan' : 'live_wayfinding',
      chartSuppressed: true,
      artifactRequired: needsFloorplan ? 'floorplan' : undefined,
      routing: {
        fromTool: 'local_utilization_query',
        routedTool: 'live_wayfinding_status',
        routedSkill: 'wayfinding',
        intent: needsFloorplan ? 'live_wayfinding_floorplan' : 'live_wayfinding',
        reason: 'Question used current-state availability wording, so historical local utilization was not used.',
      },
    };
  }
  if (needsFloorplan) {
    const response = await floorUsageReport({ ...args, question, dataDir });
    return {
      ...response,
      tool: 'local_utilization_query',
      routedTool: 'floor_usage_report',
      routing: {
        fromTool: 'local_utilization_query',
        routedTool: 'floor_usage_report',
        routedSkill: 'floorplan',
        intent: 'floorplan_artifact',
        reason: 'Question asked for a spatial floorplan artifact, so the generic chart path was not used.',
      },
    };
  }
  if (dataHealthIntent(question)) {
    const healthIntent = !dataCoverageIntent(question);
    const profile = healthIntent
      ? await dataHealthReport({ dataDir, window: question })
      : await localDataProfile({ dataDir, window: question });
    const firstTimestamp = cleanCoverageValue(profile.freshness?.firstTimestamp);
    const lastTimestamp = cleanCoverageValue(profile.freshness?.lastTimestamp);
    return {
      ...profile,
      tool: 'local_utilization_query',
      routedTool: healthIntent ? 'data_health_report' : 'local_data_profile',
      intent: healthIntent ? 'local_data_health' : 'local_data_coverage',
      routing: {
        fromTool: 'local_utilization_query',
        routedTool: healthIntent ? 'data_health_report' : 'local_data_profile',
        intent: healthIntent ? 'local_data_health' : 'local_data_coverage',
        reason: healthIntent ? 'Question asked about trust, zeros, missing data, or freshness.' : 'Question asked what local historical data is available.',
      },
      question,
      title: profile.ok ? 'Local historical data is available' : 'Local historical data is not ready yet',
      subtitle: firstTimestamp && lastTimestamp
        ? `Local timestamp coverage runs from ${firstTimestamp} to ${lastTimestamp}.`
        : profile.freshness?.reason ?? 'Timestamp coverage could not be confirmed from local Parquet.',
      provenance: localHistoricalProvenance({ dataDir, tool: 'local_utilization_query' }),
    };
  }
  const chartFollowUp = isChartFollowUpQuestion(question) ? priorChart : undefined;
  if (chartFollowUp?.chart || chartFollowUp?.html || chartFollowUp?.png) {
    return {
      ...chartFollowUp,
      ok: true,
      question,
      intent: 'chart_follow_up',
      followUp: {
        type: 'reuse_previous_chart',
        previousQuestion: chartFollowUp.question,
        reason: 'The question asked to show the previous answer as a chart.',
      },
      sourceLayer: SOURCE_LAYERS.localCustomerData,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
      provenance: localHistoricalProvenance({ dataDir, tool: 'local_utilization_query' }),
      benchmarkAffordance: {
        sourceLayer: SOURCE_LAYERS.benchmarkNetworkContext,
        sourceBadge: sourceBadgeFor(SOURCE_LAYERS.benchmarkNetworkContext),
        label: 'Density benchmark network can add peer context when benchmark access is available.',
        tool: 'benchmark_compare',
      },
    };
  }
  const contextualFollowUp = isContextualAnalyticsFollowUp(question) ? priorChart : undefined;
  const effectiveQuestion = contextualFollowUp?.question
    ? rewriteContextualQuestion(question, contextualFollowUp)
    : question;
  const cli = await requireCli();
  const uiAnswer = await runDensity(cli, ['question', effectiveQuestion, '--chart', '--format', 'ui'], { dataDir, allowFailure: true });
  if (uiAnswer.code === 0) {
    const response = await parseQuestionUiAnswer({ question: effectiveQuestion, dataDir, cli, result: uiAnswer, tool: 'local_utilization_query' });
    return {
      ...response,
      question,
      intent: response.intent ?? 'local_utilization',
      followUp: contextualFollowUp?.question
        ? {
            type: 'rewrite_contextual_question',
            previousQuestion: contextualFollowUp.question,
            effectiveQuestion,
            reason: 'The question depended on the previous analytics answer, so the plugin preserved the prior scope and metric context before calling the CLI.',
          }
        : undefined,
      benchmarkAffordance: response.ok === false
        ? undefined
        : {
            sourceLayer: SOURCE_LAYERS.benchmarkNetworkContext,
            sourceBadge: sourceBadgeFor(SOURCE_LAYERS.benchmarkNetworkContext),
            label: 'Density benchmark network can add peer context when benchmark access is available.',
            tool: 'benchmark_compare',
          },
    };
  }
  const result = await askChart({ ...args, question: effectiveQuestion, dataDir });
  return {
    ...result,
    question,
    followUp: contextualFollowUp?.question
      ? {
          type: 'rewrite_contextual_question',
          previousQuestion: contextualFollowUp.question,
          effectiveQuestion,
          reason: 'The question depended on the previous analytics answer, so the plugin preserved the prior scope and metric context before calling the CLI.',
        }
      : undefined,
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    provenance: localHistoricalProvenance({ dataDir, tool: 'local_utilization_query' }),
    benchmarkAffordance: result.ok
      ? {
          sourceLayer: SOURCE_LAYERS.benchmarkNetworkContext,
          sourceBadge: sourceBadgeFor(SOURCE_LAYERS.benchmarkNetworkContext),
          label: 'Density benchmark network can add peer context when benchmark access is available.',
          tool: 'benchmark_compare',
        }
      : undefined,
  };
}

export async function answerDensityQuestion(args = {}) {
  const question = String(args.question || '').trim();
  if (!question) throw new Error('question is required.');
  const response = await localUtilizationQuery({ ...args, question });
  const responseWithReadiness = await attachBuildingReadiness(response, args);
  const routedTool = response.routedTool ?? 'local_utilization_query';
  return {
    ...responseWithReadiness,
    tool: 'answer_density_question',
    entrypoint: 'answer_density_question',
    defaultEntrypoint: true,
    intentHint: args.intentHint,
    routedTool,
    routing: {
      fromTool: 'answer_density_question',
      viaTool: 'local_utilization_query',
      routedTool,
      routedSkill: response.routing?.routedSkill ?? response.routedSkill,
      intent: response.intent,
      reason: response.routing?.reason ?? 'Default front-door route for ordinary Density questions.',
    },
    routerRouting: response.routing,
  };
}

export async function localDataProfile(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const profile = await localDataProfileReport(dataDir);
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
    },
    profile,
    storage,
    nextAction: storage.parquetReady && storage.fastQuestionsReady
      ? undefined
      : {
          id: 'onboard_customer',
          label: 'Prepare local Density data.',
          tool: 'onboard_customer',
          args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true },
        },
    userVisiblePrimaryActions: storage.parquetReady && storage.fastQuestionsReady ? 0 : 1,
  };
}

export async function dataHealthReport(args = {}) {
  const profile = await localDataProfile(args);
  const timestampCoverageChecked = Boolean(profile.profile?.coverage?.firstTimestamp && profile.profile?.coverage?.lastTimestamp);
  return {
    ...profile,
    tool: 'data_health_report',
    checks: [
      { name: 'canonical parquet ready', ok: profile.storage.parquetReady },
      { name: 'fast question parquet ready', ok: profile.storage.fastQuestionsReady },
      { name: 'timestamp coverage checked', ok: timestampCoverageChecked, optional: !timestampCoverageChecked, detail: profile.freshness.reason },
    ],
  };
}

export async function liveWayfindingStatus(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is required.');
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const timeoutMs = args.timeoutMs === undefined ? 5000 : Number(args.timeoutMs);
  const maxAgeSeconds = args.maxAgeSeconds === undefined ? 30 : Number(args.maxAgeSeconds);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number.');
  }
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error('maxAgeSeconds must be a positive number.');
  }
  const command = ['wayfinding', 'local', query, '--format', 'json'];
  if (args.floorId) command.push('--floor', String(args.floorId));
  command.push('--live-timeout-ms', String(timeoutMs));
  command.push('--freshness-minutes', String(maxAgeSeconds / 60));
  const result = await runDensity(cli, command, {
    dataDir,
    allowFailure: true,
    timeoutMs,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      sourceLayer: SOURCE_LAYERS.liveFeed,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.liveFeed),
      liveAvailable: false,
      walkableRecommendation: false,
      query,
      dataDir,
      error: result.timedOut ? 'Live wayfinding timed out.' : oneLine(result.stderr || result.stdout),
      fallbackAvailable: true,
      fallback: 'Use historical utilization only as context; it is not a walkable recommendation.',
      artifactRequired: args.floorplanArtifactRequired ? 'floorplan' : undefined,
      nextAction: {
        id: 'check_live_wayfinding_cli',
        label: 'Update or run a Density CLI with live wayfinding JSON support.',
      },
      userVisiblePrimaryActions: 1,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      sourceLayer: SOURCE_LAYERS.liveFeed,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.liveFeed),
      liveAvailable: false,
      walkableRecommendation: false,
      query,
      dataDir,
      error: `Live wayfinding response was not JSON: ${error.message}`,
      fallbackAvailable: true,
      fallback: 'Use historical utilization only as context; it is not a walkable recommendation.',
      artifactRequired: args.floorplanArtifactRequired ? 'floorplan' : undefined,
      nextAction: {
        id: 'check_live_wayfinding_cli',
        label: 'Update or run a Density CLI with live wayfinding JSON support.',
      },
      userVisiblePrimaryActions: 1,
    };
  }
  const availabilityMode = parsed.availabilityMode;
  const liveAvailable = availabilityMode === 'live';
  const response = {
    ok: true,
    sourceLayer: SOURCE_LAYERS.liveFeed,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.liveFeed),
    liveAvailable,
    walkableRecommendation: liveAvailable,
    query,
    dataDir,
    availabilityMode,
    freshness: {
      source: liveAvailable ? 'live-presence:wayfinding' : availabilityMode ?? 'unknown',
      maxAgeSeconds: liveAvailable ? maxAgeSeconds : 0,
      requestedMaxAgeSeconds: maxAgeSeconds,
      fallbackAvailable: !liveAvailable,
    },
    summary: compactWayfindingSummary(parsed),
    artifact: liveAvailable ? parsed.artifact : undefined,
    html: liveAvailable ? parsed.artifact?.html : undefined,
    panelTarget: liveAvailable ? parsed.panelTarget : undefined,
    fallback: liveAvailable ? undefined : 'This is not live availability; use it only as fallback context, not as a walkable recommendation.',
    explanation: liveAvailable
      ? undefined
      : `The CLI returned ${availabilityMode ?? 'non-live'} wayfinding data, so this response cannot claim current availability or make a walkable recommendation.`,
    artifactRequired: args.floorplanArtifactRequired ? 'floorplan' : undefined,
    nextAction: liveAvailable
      ? undefined
      : {
          id: 'refresh_live_wayfinding',
          label: 'Refresh from a live Density wayfinding source before treating availability as current.',
        },
    userVisiblePrimaryActions: liveAvailable ? 0 : 1,
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

export async function sensorHealthReport(args = {}) {
  return {
    ok: false,
    unsupported: true,
    sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
    message: 'Sensor health is a cloud operational source. Do not infer sensor health from DuckDB, Parquet, or historical utilization data.',
    requestedScope: {
      organizationId: args.organizationId,
      buildingId: args.buildingId,
      floorId: args.floorId,
      spaceIds: args.spaceIds,
    },
    contract: {
      source: 'density_cloud_only',
      noLocalDuckdbFallback: true,
      expectedFields: ['spaceId', 'floorId', 'healthState', 'lastSeenAt', 'uptime', 'mappingStatus', 'impact'],
      healthStates: ['healthy', 'offline', 'unknown', 'degraded', 'stale'],
      impactAreas: ['utilization', 'wayfinding', 'benchmarking'],
    },
    nextAction: {
      id: 'connect_sensor_health_source',
      label: 'Connect a Density sensor-health source.',
    },
    userVisiblePrimaryActions: 1,
  };
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

export async function starterQuestions(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const capabilities = await discoverCliCapabilities(cli, { dataDir });
  const questions = {
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
  };

  if (!capabilities.commands?.questionStarter) {
    return {
      ok: false,
      unsupported: true,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      questions,
      message: 'This Density CLI does not support fast starter-question runs yet.',
      nextAction: {
        id: 'update_cli_for_starter_questions',
        label: 'Update/build a Density CLI that supports density question --starter.',
        command: 'density capabilities --format json',
      },
      userVisiblePrimaryActions: 1,
    };
  }

  const command = ['question', '--starter', '--format', 'json'];
  if (args.chart !== false) command.push('--chart');
  if (args.cached === true) command.push('--cached');
  const answer = await runDensity(cli, command, { dataDir, allowFailure: true });
  if (answer.code !== 0) {
    return {
      ok: false,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      questions,
      error: oneLine(answer.stderr || answer.stdout),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(answer.stdout);
  } catch (error) {
    throw new Error(`Density starter-question response was not JSON: ${error.message}`);
  }

  return {
    ok: true,
    ready: Boolean(parsed.readiness?.ready),
    ...starterUsefulness(parsed.readiness),
    readiness: parsed.readiness,
    dataDir,
    cli: safeCliInfo(cli),
    capabilities,
    questions,
    result: parsed,
  };
}

export async function createDemoCustomer(args = {}) {
  const sourceDir = args.sourceDir || path.join(os.homedir(), '.density-cli-linkedin');
  const outDir = args.outDir || path.join(os.homedir(), '.density-cli-demo-customer');
  const days = boundedGenericDays(args.days);
  return { sourceDir, outDir, days };
}

export async function requireCli() {
  const cli = await resolveDensityCli();
  if (!cli) throw new Error('Density CLI not found. Run install_managed_cli, set DENSITY_CLI_BIN, set DENSITY_CLI_REPO, or install density on PATH.');
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
