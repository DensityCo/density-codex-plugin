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
  renderPng,
  resolveDensityCli,
  runDensity,
  safeCliInfo,
  storageReport,
  supportsAnalyticArtifact,
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
const chartContextCache = new Map();

const oneLine = (value) => String(value ?? '').trim();
const sourceBadgeFor = (sourceLayer) => SOURCE_BADGES[sourceLayer] ?? 'Mixed';
const nowIso = () => new Date().toISOString();
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const resolvePresentation = (value, defaultPresentation) => {
  const presentation = value ?? defaultPresentation;
  if (presentation !== 'slide' && presentation !== 'broadsheet') {
    throw new Error('presentation must be slide or broadsheet.');
  }
  return presentation;
};

// Render-time theme selection value space mirrored from the Density CLI
// (src/analytic-artifact.ts): registry theme ids, accent presets, or a
// 6-digit #RRGGBB brand accent.
const THEME_REGISTRY_IDS = [
  'institutional',
  'product_clean',
  'editorial',
  'swiss',
  'boardroom_dark',
  'ft_editorial',
  'monograph',
  'blueprint',
  'humanist',
  'newsprint_mono',
];
const THEME_PRESETS = ['density_blue', 'indigo', 'deep_teal'];

const resolveTheme = (value) => {
  if (value === undefined || value === null) return undefined;
  const theme = String(value).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(theme)) return theme;
  const name = theme.toLowerCase();
  if (THEME_REGISTRY_IDS.includes(name) || THEME_PRESETS.includes(name)) return name;
  throw new Error(`theme must be one of ${[...THEME_REGISTRY_IDS, ...THEME_PRESETS].join(', ')}, or a 6-digit hex brand accent like #1A6B54.`);
};

const presentationDelivery = ({ requested, slideSupported, response }) => {
  if (requested !== 'slide') return undefined;
  let generated = 'none';
  let delivered = 'none';
  if (response?.analyticState === 'unsupported_mode') generated = delivered = 'text';
  else if (response?.panelTarget?.kind === 'analytic-slide' && response?.analytic?.slideFile) generated = 'slide';
  else if (response?.clarificationRequest) generated = delivered = 'clarification';
  else if (response?.chart || response?.html || response?.png) generated = delivered = 'chart';
  else if (response?.ok) generated = delivered = 'text';

  let reason;
  if (response?.analyticState === 'unsupported_mode') {
    reason = response.message ?? 'The validated response supports text but not a slide for this question.';
  } else if (!slideSupported) {
    reason = 'The installed Density runtime does not advertise validated slide support.';
  } else if (generated === 'slide') {
    reason = 'The validated slide was generated and awaits a user-visible host attachment.';
  } else if (delivered !== 'slide') {
    reason = 'The validated response did not produce a slide artifact.';
  }
  return {
    requested: 'slide',
    ...(generated === 'slide' ? { generated } : {}),
    delivered,
    slideSupported,
    ...(reason ? { reason } : {}),
  };
};

const createHistoricalQuestionDeadline = (value = 5000) => {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number.');
  }
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  return {
    timeoutMs,
    startedAt,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
  };
};

const historicalQuestionTimedOut = ({ question, dataDir, deadline, intent }) => ({
  ok: false,
  timedOut: true,
  question,
  intent,
  sourceLayer: SOURCE_LAYERS.localCustomerData,
  sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
  message: `Density could not complete this question inside the ${deadline.timeoutMs}ms wall-time budget.`,
  performance: { elapsedMs: Date.now() - deadline.startedAt, targetMs: deadline.timeoutMs },
  dataDir,
});

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

const chartContextKey = (dataDir) => path.resolve(dataDir);

const isChartFollowUpQuestion = (question) =>
  /\b(make|turn|render|chart|graph|visuali[sz]e)\b.*\b(that|this|it|same)\b/i.test(question)
  || /\b(that|this|it|same)\b.*\b(as a chart|as chart|chart|graph|visuali[sz]e)\b/i.test(question);

const isContextualAnalyticsFollowUp = (question) =>
  (
    /\b(?:normaliz(?:e|ed|ing)|normalis(?:e|ed|ing)|average|avg|per day)\b.*\b(?:that|this|it|same)\b/i.test(question)
    || /\b(?:that|this|it|same)\b.*\b(?:normaliz(?:e|ed|ing)|normalis(?:e|ed|ing)|average|avg|per day)\b/i.test(question)
    || /\buse\b.+\binstead\b/i.test(question)
    || /\b(what about|how about)\b/i.test(question)
    || /\b(?:that|this|it|same)\b.*\b(?:weekday|hour)\b/i.test(question)
  )
  && !isChartFollowUpQuestion(question);

const FLOOR_PATTERN = /\b(?:floor|fl|level)\s+([a-z0-9-]+)\b|\b((?:\d+)(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)\s+floor\b/i;
const BUILDING_NAME_SOURCE = String.raw`[a-z0-9'’.-]+(?:\s+[a-z0-9'’.-]+){0,2}\s+(?:building|bldg|tower|campus|complex|centre|center|plaza|place)`;
const BUILDING_REFERENCE_PATTERN = new RegExp(
  String.raw`\b(?:in|at|on|for|across)\s+(?!(?:the\s+)?(?:first|last|second)\s+place\b)(?:the\s+)?(${BUILDING_NAME_SOURCE})\b`,
  'i',
);
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

const withoutBuildingReference = (value) => cleanSpaces(
  value.replace(new RegExp(String.raw`\b${BUILDING_NAME_SOURCE}\b`, 'ig'), ' ')
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

  const buildingMatch = question.match(BUILDING_REFERENCE_PATTERN);
  if (buildingMatch) {
    next = withoutBuildingReference(next);
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
  if (/\b(?:by|across)\s+weekdays?\s+(?:and|by)\s+hours?\b/i.test(question)) {
    return cleanSpaces(`${withoutPriorDayFilter(rewritten)} by weekday and hour`);
  }
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

const sensorHealthIntent = (question) => {
  const historicalUtilization = /\b(historical|history|trend|over time|last|past|yesterday|weeks?|months?|quarters?|years?)\b/i.test(question)
    && /\b(utili[sz](?:e|ed|ation)|occupancy|occupied|usage|performance|busiest|least used|underused)\b/i.test(question);
  if (historicalUtilization) return false;
  return /\b(sensor(?:s)?|sensor[-\s]?health|live signal|presence signal|health of (?:the )?sensor|signal stale|stale signal)\b/i.test(question);
};

const metadataQuestionIntent = (question) => {
  const lifecycleEntity = /\b(buildings?|sites?|offices?|locations?)\b/i.test(question);
  const lifecycleState = /\b(live|offline|planning|planned|inactive|retired|decommissioned|pre[-\s]?live|go[-\s]?live|lifecycle|status)\b/i.test(question);
  const currentSpaceState = /\b(availability|available|open|free|empty|vacant|occupied)\b/i.test(question)
    && /\b(rooms?|phone booths?|booths?|desks?|seats?|spaces?)\b/i.test(question);
  if (lifecycleEntity && lifecycleState && !currentSpaceState) return 'building_lifecycle';

  const structureEntity = /\b(buildings?|sites?|floors?|spaces?|rooms?|meeting rooms?|conference rooms?|phone booths?|booths?|desks?)\b/i.test(question);
  const historicalPerformanceCount = /\b(historical|history|trend|over time|last|past|yesterday|weekdays?|weekends?|weeks?|months?|quarters?|years?|us(?:e|ed|age)|occupied|occupancy|utili[sz](?:e|ed|ation)|performance|busiest|least used|underused)\b/i.test(question)
    || /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(question)
    || /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(question);
  const structureRepresentation = /\b(represented|inventory)\b/i.test(question);
  const structureCount = structureEntity
    && (/\bhow many\b/i.test(question)
      || /\b(?:total )?(?:count|number) of\b/i.test(question)
      || /\bcount (?:the )?(?:buildings?|sites?|floors?|spaces?|rooms?|meeting rooms?|conference rooms?|phone booths?|booths?|desks?)\b/i.test(question))
    && (structureRepresentation || !/\b(availability|available|open|free|empty|vacant)\b/i.test(question))
    && !historicalPerformanceCount;
  if (structureCount) return 'local_structure';

  const diagnostic = /\b(can (?:we|i) trust|trustworthy|diagnos(?:e|is|tic)|why (?:is|are)|zeros?|missing|gaps?)\b/i.test(question);
  const freshnessSubject = /\b(data|metrics?|dataset|cache|parquet|sync|synced|refresh|refreshed|update|updated)\b/i.test(question);
  const freshness = freshnessSubject && (
    /\bhow fresh\b/i.test(question)
    || /\bwhen (?:was|were|did).*(?:last )?(?:sync|synced|refresh|refreshed|update|updated)\b/i.test(question)
    || /\b(?:last|latest) (?:sync|synced|refresh|refreshed|update|updated)\b/i.test(question)
  );
  if (freshness && !diagnostic) return 'local_data_freshness';

  return undefined;
};

const metadataQuestionRouting = (intent) => intent
  ? {
      fromTool: 'local_utilization_query',
      routedTool: 'local_utilization_query',
      intent,
      reason: {
        building_lifecycle: 'Question asked which buildings or sites match a lifecycle state, so local lifecycle metadata was used instead of live room availability.',
        local_structure: 'Question asked for an inventory count, so local structure metadata was used instead of historical utilization.',
        local_data_freshness: 'Question asked when local data was last observed or synced, so the local metadata chart path was used instead of a diagnostic health report.',
      }[intent],
    }
  : undefined;

const historicalAvailabilityIntent = (question) =>
  /\b(how often|frequency|percent|percentage|share of time|historical|history|trend|over time|last|past|weekday|weekend|rank(?:ing)?|popular|busiest|least used|most occupied|least occupied|utili[sz]ation|used hours?|average|avg|observed|measured)\b/i.test(question);

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
  if (/\bfloor\s*plans?\b|\bfloorplans?\b/i.test(question)) return true;
  if (/\bheat\s*map\b/i.test(question) && /\b(weekday|weekdays|day|days|hour|hours|time)\b/i.test(question)) return false;
  const spatialScope = /\b(floors?|levels?|rooms?|spaces?|desks?|booths?|availability|usage|utili[sz]ation|occupancy)\b/i.test(question);
  return (spatialScope && /\b(map|overlay|spatial|wayfind(?:ing)?|navigate|route)\b/i.test(question))
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

const broadScopeClarificationContract = (question) => ({
  kind: 'density.clarification_request.v1',
  contract: 'density.clarification',
  reason: 'broad_scope_needs_resolution',
  question,
  prompt: 'Which measured building should I use?',
  requiredChoiceCount: 1,
  suggestions: [
    {
      id: 'list_measured_buildings',
      label: 'Show the measured buildings I can choose from.',
    },
    {
      id: 'choose_measured_building',
      label: 'Use a specific measured building.',
    },
  ],
  freeform: {
    enabled: true,
    label: 'Name a measured building, floor, space type, or time window.',
  },
  nextActionAfterAnswer: {
    id: 'answer_density_question',
    label: 'Answer the question with the selected measured scope.',
  },
  responseSemantics: {
    answer: false,
    chart: false,
    benchmark: false,
    writesArtifacts: false,
  },
});

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

const parseQuestionUiAnswer = async ({
  question,
  dataDir,
  cli,
  result,
  tool,
  renderTimeoutMs,
  remember = true,
  analyticArtifactSupported = false,
  analyticCapabilities,
  includePanelTarget = false,
}) => {
  let ui;
  try {
    ui = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Density UI response was not JSON: ${error.message}`);
  }
  if (ui?.clarificationRequest !== undefined) {
    const clarificationRequest = publicClarificationRequest(ui.clarificationRequest);
    if (!clarificationRequest) {
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
      chart: undefined,
      html: undefined,
      png: undefined,
      chartSuppressed: true,
      dataDir,
      cli: safeCliInfo(cli),
    };
  }
  const normalizedAnalytic = analyticArtifactSupported
    ? await normalizeAnalyticPayload({
        analytic: ui.analytic,
        panelTarget: includePanelTarget ? ui.panelTarget : undefined,
        runtimeArtifact: isRecord(ui.artifact) ? ui.artifact : ui.artifacts,
        question,
        requestedMode: includePanelTarget ? 'slide' : undefined,
        capabilities: analyticCapabilities,
      })
    : { ok: true, analytic: undefined, panelTarget: undefined };
  if (!normalizedAnalytic.ok) throw new Error(normalizedAnalytic.reason);
  const answerProps = ui.jsonRender?.spec?.elements?.answer?.props ?? {};
  const state = ui.jsonRender?.spec?.state ?? {};
  const source = validatedQuestionUiSource(answerProps);
  const snapshot = publicQuestionSnapshot(ui.snapshot);
  const {
    snapshot: _privateSnapshot,
    analytic: _privateAnalytic,
    panelTarget: _privatePanelTarget,
    ...uiWithoutPrivatePayloads
  } = ui;
  const svg = ui.artifacts?.svg ?? state.artifacts?.svg;
  const html = ui.artifacts?.html ?? state.artifacts?.html;
  const pngStartedAt = Date.now();
  const png = normalizedAnalytic.unsupportedMode
    ? undefined
    : await renderPng(svg, { timeoutMs: renderTimeoutMs });
  const pngMs = normalizedAnalytic.unsupportedMode ? 0 : Date.now() - pngStartedAt;
  const analytic = normalizedAnalytic.analytic;
  const panelTarget = normalizedAnalytic.panelTarget;
  const analyticElement = uiWithoutPrivatePayloads.jsonRender?.spec?.elements?.analytic;
  const answerElement = uiWithoutPrivatePayloads.jsonRender?.spec?.elements?.answer;
  const analyticOwnsPresentation = analytic !== undefined
    && ['context_needed', 'blocked'].includes(analytic.artifact.confidence)
    && analytic.artifact.chart_data === null;
  const publicUi = {
    ...uiWithoutPrivatePayloads,
    ...(isRecord(uiWithoutPrivatePayloads.jsonRender)
      && isRecord(uiWithoutPrivatePayloads.jsonRender.spec)
      && isRecord(uiWithoutPrivatePayloads.jsonRender.spec.elements)
      ? {
          jsonRender: {
            ...uiWithoutPrivatePayloads.jsonRender,
            spec: {
              ...uiWithoutPrivatePayloads.jsonRender.spec,
              elements: {
                ...uiWithoutPrivatePayloads.jsonRender.spec.elements,
                ...(isRecord(analyticElement)
                  ? analytic
                    ? { analytic: { ...analyticElement, props: analytic } }
                    : { analytic: { ...analyticElement, props: {} } }
                  : {}),
                ...(analyticOwnsPresentation && isRecord(answerElement)
                  ? { answer: { ...answerElement, children: ['analytic'] } }
                  : {}),
              },
            },
          },
        }
      : {}),
    ...(panelTarget ? { panelTarget } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
  const response = {
    ok: normalizedAnalytic.unsupportedMode ? false : true,
    ...source,
    provenance: questionUiProvenance({
      dataDir,
      tool,
      ...source,
      freshness: answerProps.freshness ?? state.freshness,
    }),
    question,
    title: answerProps.title ?? '',
    subtitle: answerProps.subtitle ?? '',
    chart: svg,
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
    performance: { ...(ui.performance ?? {}), pngMs },
    ...(analytic ? { analytic } : {}),
    ...(panelTarget ? { panelTarget } : {}),
    ...(normalizedAnalytic.trustContext ? { trustContext: normalizedAnalytic.trustContext } : {}),
    ...(normalizedAnalytic.analyticState ? { analyticState: normalizedAnalytic.analyticState } : {}),
    ...(normalizedAnalytic.unsupportedMode ? {
      unsupportedMode: true,
      deliveredMode: 'text',
      message: 'Density returned a validated text answer, but this question does not currently support a slide.',
    } : {}),
    ...(normalizedAnalytic.learningRecordId ? { learningRecordId: normalizedAnalytic.learningRecordId } : {}),
    ...(normalizedAnalytic.learningWarning ? { learningWarning: normalizedAnalytic.learningWarning } : {}),
    ...(normalizedAnalytic.reviewNextAction ? { reviewNextAction: { ...normalizedAnalytic.reviewNextAction, args: { ...normalizedAnalytic.reviewNextAction.args, dataDir } } } : {}),
    ui: publicUi,
    dataDir,
    cli: safeCliInfo(cli),
  };
  if (broadScopeSelectionIntent(question) && noMatchingLocalScope(response)) {
    const clarification = broadScopeClarificationContract(question);
    return {
      ...response,
      ok: false,
      ...clarification,
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
  if (remember) rememberChartContext(dataDir, response);
  return response;
};

const verifiedRegularFile = async (file, expectedSha256) => {
  if (typeof file !== 'string' || !file.trim() || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) return false;
  try {
    const [details, contents] = await Promise.all([stat(file), readFile(file)]);
    return details.isFile()
      && details.size > 0
      && createHash('sha256').update(contents).digest('hex') === expectedSha256;
  } catch {
    return false;
  }
};

const cachedQuestionUiIsUsable = async (result) => {
  if (result.code !== 0) return false;
  try {
    const ui = JSON.parse(result.stdout);
    if (ui.cache?.hit !== true) return true;
    const state = ui.jsonRender?.spec?.state ?? {};
    const svg = ui.artifacts?.svg ?? state.artifacts?.svg;
    const html = ui.artifacts?.html ?? state.artifacts?.html;
    const svgSha256 = ui.artifacts?.svgSha256 ?? state.artifacts?.svgSha256;
    const htmlSha256 = ui.artifacts?.htmlSha256 ?? state.artifacts?.htmlSha256;
    const [svgUsable, htmlUsable] = await Promise.all([
      verifiedRegularFile(svg, svgSha256),
      verifiedRegularFile(html, htmlSha256),
    ]);
    return svgUsable && htmlUsable;
  } catch {
    return false;
  }
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
    cli && status?.code === 0 && storage.parquetReady && capabilities.commands?.questionStarter && !storage.fastQuestionsReady && capabilities.commands?.repairFastQuestions && hasResourcesParquet(storage) && {
      id: 'repair_fast_questions',
      label: 'Repair local fast-question metadata from resources.parquet.',
      tool: 'repair_fast_questions',
      args: { dataDir },
      command: 'density repair fast-questions --format json',
    },
    cli && status?.code === 0 && (!storage.parquetReady || (capabilities.commands?.questionStarter && !storage.fastQuestionsReady)) && {
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
    cli && status?.code === 0 && storage.parquetReady && !capabilities.chartQuestions && {
      id: 'chart_unsupported',
      label: 'Update the Density CLI for chart questions, or use local query/viz commands.',
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
        label: `Fetch ${DEFAULT_METRICS_DAYS} days for all locations, then continue deeper history in the background.`,
        tool: 'onboard_customer',
        args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true, backgroundDeepSync: true },
      },
      nextSteps: [`Fetch ${DEFAULT_METRICS_DAYS} days for all locations, then continue deeper history in the background.`],
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
      label: `Fetch ${DEFAULT_METRICS_DAYS} days for all locations, then continue deeper history in the background.`,
      tool: 'onboard_customer',
      args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true, backgroundDeepSync: true },
    },
    nextSteps: storage.fastQuestionsReady ? [] : [`Fetch ${DEFAULT_METRICS_DAYS} days for all locations, then continue deeper history in the background.`],
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
  const backgroundDeepSync = Boolean(args.backgroundDeepSync ?? (fullSync && days === DEFAULT_METRICS_DAYS));
  const backgroundDeepSyncDays = backgroundDeepSync
    ? boundedHistoricalExportDays(args.backgroundDeepSyncDays ?? DEFAULT_BACKGROUND_DEEP_SYNC_DAYS)
    : undefined;
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
    const backgroundJob = backgroundDeepSync && storage.parquetReady && storage.fastQuestionsReady
      ? await startBackgroundDeepSync({
        dataDir,
        orgId: args.orgId,
        days: backgroundDeepSyncDays,
        recentDays: days,
      })
      : undefined;

    return {
      ok: storage.parquetReady && (!prewarmQuestions || storage.fastQuestionsReady),
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

const askChartWithinDeadline = async (args = {}, inheritedDeadline, inheritedCapabilities) => {
  const question = String(args.question || '').trim();
  if (!question) throw new Error('question is required.');
  const presentation = resolvePresentation(args.presentation, 'broadsheet');
  const dataDir = resolveDataDir(args.dataDir);
  const needsFloorplan = floorplanArtifactIntent(question);
  const metadataIntent = metadataQuestionIntent(question);
  const liveIntent = currentAvailabilityIntent(question);
  if (needsFloorplan && !liveIntent) {
    return floorUsageReport({ ...args, question, dataDir });
  }
  if (liveIntent && metadataIntent !== 'building_lifecycle') {
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
  const deadline = inheritedDeadline ?? createHistoricalQuestionDeadline(args.timeoutMs);
  const timedOutResponse = () => historicalQuestionTimedOut({
    question,
    dataDir,
    deadline,
    intent: 'ask_chart_timeout',
  });
  const cli = await requireCli();
  let remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) return timedOutResponse();
  const capabilities = inheritedCapabilities
    ?? await discoverCliCapabilities(cli, { dataDir, timeoutMs: remainingMs });
  if (deadline.remainingMs() <= 0) return timedOutResponse();
  if (!capabilities.checked && /timed out/i.test(capabilities.reason ?? '')) return timedOutResponse();
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
    const useAnalyticSlide = presentation === 'slide' && supportsAnalyticArtifact(capabilities, 'slide');
    const presentationFlag = useAnalyticSlide ? '--slide' : '--chart';
    remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) return timedOutResponse();
    const cachedUiAnswer = await runDensity(cli, ['question', question, '--cached', presentationFlag, '--format', 'ui'], {
      dataDir,
      allowFailure: true,
      timeoutMs: remainingMs,
    });
    if (cachedUiAnswer.timedOut || deadline.remainingMs() <= 0) return timedOutResponse();
    let uiAnswer = cachedUiAnswer;
    if (!await cachedQuestionUiIsUsable(cachedUiAnswer)) {
      remainingMs = deadline.remainingMs();
      if (remainingMs <= 0) return timedOutResponse();
      uiAnswer = await runDensity(cli, ['question', question, presentationFlag, '--format', 'ui'], {
        dataDir,
        allowFailure: true,
        timeoutMs: remainingMs,
      });
    }
    if (uiAnswer.timedOut || deadline.remainingMs() <= 0) return timedOutResponse();
    if (uiAnswer.code === 0) {
      remainingMs = deadline.remainingMs();
      if (remainingMs <= 0) return timedOutResponse();
      const response = await parseQuestionUiAnswer({
        question,
        dataDir,
        cli,
        result: uiAnswer,
        tool: 'ask_chart',
        renderTimeoutMs: remainingMs,
        analyticArtifactSupported: supportsAnalyticArtifact(capabilities),
        analyticCapabilities: capabilities,
        includePanelTarget: useAnalyticSlide,
      });
      if (deadline.remainingMs() <= 0) return timedOutResponse();
      return {
        ...response,
        capabilities,
        ...(presentation === 'slide'
          ? { presentationDelivery: presentationDelivery({ requested: 'slide', slideSupported: useAnalyticSlide, response }) }
          : {}),
      };
    }
  }

  remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) return timedOutResponse();
  const answer = await runDensity(cli, ['ask', question, '--chart', '--format', 'json'], {
    dataDir,
    allowFailure: true,
    timeoutMs: remainingMs,
  });
  if (answer.timedOut || deadline.remainingMs() <= 0) return timedOutResponse();
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
  remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) return timedOutResponse();
  const png = await renderPng(parsed.chart, { timeoutMs: remainingMs });
  if (deadline.remainingMs() <= 0) return timedOutResponse();
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
  if (presentation === 'slide') {
    response.presentationDelivery = presentationDelivery({
      requested: 'slide',
      slideSupported: false,
      response,
    });
  }
  rememberChartContext(dataDir, response);
  return response;
};

export async function askChart(args = {}) {
  return await askChartWithinDeadline(args);
}

const analyticSlideQuestion = (value) => {
  if (typeof value !== 'string') throw new Error('question is required.');
  const question = value.trim();
  if (!question) throw new Error('question is required.');
  if (question.includes('\0')) throw new Error('question must not contain null bytes.');
  if (question.length > 10000) throw new Error('question must be 10000 characters or fewer.');
  return question;
};

const analyticSlideDataDir = (value) => {
  if (value !== undefined && typeof value !== 'string') throw new Error('dataDir must be a path string.');
  const raw = value === undefined ? resolveDataDir() : value.trim();
  if (!raw) throw new Error('dataDir must be a non-empty path string.');
  if (raw.includes('\0')) throw new Error('dataDir must not contain null bytes.');
  return path.resolve(raw);
};

const publicClarificationRequest = (value) => {
  if (!isRecord(value)
    || value.kind !== 'density.clarification_request.v1'
    || value.contract !== 'density.clarification'
    || typeof value.question !== 'string'
    || !value.question.trim()
    || typeof value.prompt !== 'string'
    || !value.prompt.trim()
    || !isRecord(value.responseSemantics)
    || value.responseSemantics.answer !== false
    || value.responseSemantics.chart !== false
    || value.responseSemantics.writesArtifacts !== false) {
    return undefined;
  }
  return {
    kind: value.kind,
    contract: value.contract,
    reason: typeof value.reason === 'string' ? value.reason : undefined,
    question: value.question.trim(),
    prompt: value.prompt.trim(),
    requiredChoiceCount: Number.isInteger(value.requiredChoiceCount) ? value.requiredChoiceCount : undefined,
    suggestions: Array.isArray(value.suggestions) ? value.suggestions : [],
    freeform: isRecord(value.freeform) ? value.freeform : undefined,
    nextActionAfterAnswer: isRecord(value.nextActionAfterAnswer) ? value.nextActionAfterAnswer : undefined,
    responseSemantics: {
      answer: false,
      chart: false,
      benchmark: value.responseSemantics.benchmark === false ? false : undefined,
      writesArtifacts: false,
    },
  };
};

const validatedAnalyticGates = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length !== 5) return undefined;
  const gates = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)
      || entry.gate !== index + 1
      || typeof entry.decision !== 'string'
      || !entry.decision.trim()
      || typeof entry.reason !== 'string'
      || !entry.reason.trim()) {
      return undefined;
    }
    gates.push({ gate: entry.gate, decision: entry.decision.trim(), reason: entry.reason.trim() });
  }
  return gates;
};

const validatedDataProvenance = (value) => {
  const allowedClasses = new Set(['density_native', 'customer_supplied', 'derived', 'unavailable']);
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const entries = [];
  const ids = new Set();
  for (const entry of value) {
    if (!isRecord(entry)
      || typeof entry.input !== 'string'
      || !entry.input.trim()
      || !allowedClasses.has(entry.class)
      || (entry.id !== undefined && (typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id.trim())))
      || (entry.source_detail !== undefined && typeof entry.source_detail !== 'string')) {
      return undefined;
    }
    if (typeof entry.id === 'string') ids.add(entry.id.trim());
    entries.push({
      ...(typeof entry.id === 'string' ? { id: entry.id.trim() } : {}),
      input: entry.input.trim(),
      class: entry.class,
      ...(typeof entry.source_detail === 'string' && entry.source_detail.trim()
        ? { source_detail: entry.source_detail.trim() }
        : {}),
    });
  }
  return entries;
};

const validatedSlideTarget = (analytic, panelTarget, runtimeArtifact) => {
  const runtimeSlideFile = isRecord(runtimeArtifact) ? runtimeArtifact.slideFile : undefined;
  const slideFile = runtimeSlideFile ?? analytic.slideFile;
  if (typeof slideFile !== 'string' || !slideFile.trim()) {
    return { ok: false, reason: 'runtime artifact.slideFile is missing.' };
  }
  const slidePath = slideFile.trim();
  if (analytic.slideFile !== undefined && analytic.slideFile !== slidePath) {
    return { ok: false, reason: 'analytic.slideFile must match runtime artifact.slideFile.' };
  }
  if (!path.isAbsolute(slidePath) || path.normalize(slidePath) !== slidePath) {
    return { ok: false, reason: 'analytic.slideFile must be a normalized absolute path.' };
  }
  if (!isRecord(panelTarget)
    || panelTarget.contract !== 'density.panel-target.v1'
    || panelTarget.kind !== 'analytic-slide') {
    return { ok: false, reason: 'panelTarget must use the density.panel-target.v1 analytic-slide contract.' };
  }
  if (panelTarget.path !== slidePath) {
    return { ok: false, reason: 'panelTarget.path must match analytic.slideFile.' };
  }
  if (panelTarget.url !== undefined) {
    try {
      const targetUrl = new URL(panelTarget.url);
      if (targetUrl.protocol !== 'file:' || fileURLToPath(targetUrl) !== slidePath) {
        return { ok: false, reason: 'panelTarget.url must be a file URL for analytic.slideFile.' };
      }
    } catch {
      return { ok: false, reason: 'panelTarget.url must be a valid file URL for analytic.slideFile.' };
    }
  }
  return {
    ok: true,
    slidePath,
    panelTarget: {
      contract: panelTarget.contract,
      kind: panelTarget.kind,
      ...(typeof panelTarget.title === 'string' ? { title: panelTarget.title } : {}),
      ...(typeof panelTarget.report === 'string' ? { report: panelTarget.report } : {}),
      path: slidePath,
      ...(typeof panelTarget.url === 'string' ? { url: panelTarget.url } : {}),
    },
  };
};

const analyticTrustContext = ({ artifact, capabilities, gates, dataProvenance, evidenceReceipt }) => ({
  contract: capabilities?.analyticArtifact?.contract ?? 'density.analytic-artifact.v1',
  validationState: 'rendered',
  confidence: artifact.confidence,
  responseMode: artifact.response_mode,
  gates,
  dataProvenance,
  source: artifact.source.trim(),
  methodology: artifact.methodology.trim(),
  limitations: artifact.limitations?.map((entry) => entry.trim()) ?? [],
  runtimeVersion: capabilities?.version,
  ...(evidenceReceipt ? { evidenceReceipt } : {}),
  ...(Array.isArray(capabilities?.analyticArtifact?.liveArchetypes)
    && capabilities.analyticArtifact.liveArchetypes.every((value) => typeof value === 'string' && value.trim())
    ? { liveArchetypes: capabilities.analyticArtifact.liveArchetypes.map((value) => value.trim()) }
    : {}),
});

const learningRecordId = (value) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^lr_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return null;
  }
  return value;
};

const reviewLearningNextAction = (id) => id ? {
  id: 'review_analytic_learning',
  label: 'Add customer context or a quality label to this analytic example.',
  tool: 'review_analytic_learning',
  args: { id },
} : undefined;

const ANALYTIC_EVIDENCE_RECEIPT_CONTRACTS = {
  'density.analytic-evidence-receipt.v1': [
    'artifact',
    'receipt',
    'local_evidence',
    'benchmark_evidence_when_used',
  ],
  'density.analytic-evidence-receipt.v2': [
    'artifact',
    'receipt',
    'local_evidence',
    'sensor_evidence_when_used',
    'benchmark_evidence_when_used',
  ],
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const analyticEvidenceSha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const analyticPresentationSha256 = (html) => createHash('sha256').update(html).digest('hex');

const analyticQuestionIdentity = (value) => typeof value === 'string'
  ? value.trim().toLowerCase().replace(/[?.!]+$/g, '').replace(/\s+/g, ' ')
  : '';

const ANALYTIC_DENOMINATOR_KEYS = ['id', 'label', 'coverage'];
const ANALYTIC_DENOMINATOR_COVERAGE = [
  'observed_only',
  'complete_inventory_required',
  'missing_preserved',
  'exact_scope_required',
];
const ANALYTIC_MATERIAL_CAVEAT_KEYS = ['id', 'text', 'affected_claim', 'severity'];
const ANALYTIC_MATERIAL_CAVEAT_AFFECTED_CLAIMS = ['headline', 'subtitle', 'interpretation'];
const ANALYTIC_MATERIAL_CAVEAT_SEVERITIES = ['material', 'routine'];

const unknownAnalyticKeys = (record, allowedKeys) =>
  Object.keys(record).filter((key) => !allowedKeys.includes(key));

const normalizedAnalyticQualityFields = (artifact) => {
  const fields = {};
  if (artifact.metric_unit !== undefined) {
    if (typeof artifact.metric_unit !== 'string' || !artifact.metric_unit.trim()) {
      return { ok: false, reason: 'analytic.artifact.metric_unit must be a non-empty string when present.' };
    }
    fields.metric_unit = artifact.metric_unit.trim();
  }
  if (artifact.denominator !== undefined) {
    if (!isRecord(artifact.denominator)) {
      return { ok: false, reason: 'analytic.artifact.denominator must contain non-empty id, label, and coverage fields.' };
    }
    const unknownKeys = unknownAnalyticKeys(artifact.denominator, ANALYTIC_DENOMINATOR_KEYS);
    if (unknownKeys.length > 0) {
      return { ok: false, reason: `analytic.artifact.denominator contains unknown fields: ${unknownKeys.join(', ')}.` };
    }
    if (typeof artifact.denominator.id !== 'string'
      || !artifact.denominator.id.trim()
      || typeof artifact.denominator.label !== 'string'
      || !artifact.denominator.label.trim()
      || typeof artifact.denominator.coverage !== 'string') {
      return { ok: false, reason: 'analytic.artifact.denominator must contain non-empty id, label, and coverage fields.' };
    }
    if (!ANALYTIC_DENOMINATOR_COVERAGE.includes(artifact.denominator.coverage)) {
      return { ok: false, reason: `analytic.artifact.denominator.coverage must be one of: ${ANALYTIC_DENOMINATOR_COVERAGE.join(', ')}.` };
    }
    fields.denominator = {
      id: artifact.denominator.id.trim(),
      label: artifact.denominator.label.trim(),
      coverage: artifact.denominator.coverage,
    };
  }
  if (artifact.material_caveats !== undefined) {
    if (!Array.isArray(artifact.material_caveats)) {
      return { ok: false, reason: 'analytic.artifact.material_caveats must contain structured caveat objects.' };
    }
    const ids = new Set();
    const caveats = [];
    for (const [index, entry] of artifact.material_caveats.entries()) {
      if (!isRecord(entry)) {
        return { ok: false, reason: 'analytic.artifact.material_caveats must contain structured caveat objects.' };
      }
      const unknownKeys = unknownAnalyticKeys(entry, ANALYTIC_MATERIAL_CAVEAT_KEYS);
      if (unknownKeys.length > 0) {
        return { ok: false, reason: `analytic.artifact.material_caveats[${index}] contains unknown fields: ${unknownKeys.join(', ')}.` };
      }
      if (typeof entry.id !== 'string' || !entry.id.trim()
        || typeof entry.text !== 'string' || !entry.text.trim()) {
        return { ok: false, reason: 'analytic.artifact.material_caveats must contain structured caveat objects.' };
      }
      if (!ANALYTIC_MATERIAL_CAVEAT_AFFECTED_CLAIMS.includes(entry.affected_claim)) {
        return { ok: false, reason: `analytic.artifact.material_caveats[${index}].affected_claim must be one of: ${ANALYTIC_MATERIAL_CAVEAT_AFFECTED_CLAIMS.join(', ')}.` };
      }
      if (!ANALYTIC_MATERIAL_CAVEAT_SEVERITIES.includes(entry.severity)) {
        return { ok: false, reason: `analytic.artifact.material_caveats[${index}].severity must be one of: ${ANALYTIC_MATERIAL_CAVEAT_SEVERITIES.join(', ')}.` };
      }
      const id = entry.id.trim();
      if (ids.has(id)) {
        return { ok: false, reason: `analytic.artifact.material_caveats contains duplicate id '${id}'.` };
      }
      ids.add(id);
      caveats.push({
        id,
        text: entry.text.trim(),
        affected_claim: entry.affected_claim,
        severity: entry.severity,
      });
    }
    fields.material_caveats = caveats;
  }
  return { ok: true, fields };
};

const ANALYTIC_PUBLIC_ARTIFACT_FIELDS = [
  'question',
  'response_mode',
  'confidence',
  'headline',
  'subtitle',
  'measured_observation',
  'interpretation',
  'operational_implication',
  'metric_name',
  'metric_unit',
  'metric_value',
  'denominator',
  'comparison_value',
  'change',
  'analysis_period',
  'population',
  'chart_type',
  'chart_data',
  'annotation',
  'benchmark',
  'uncertainty_reason',
  'follow_up_question',
  'source',
  'methodology',
  'material_caveats',
  'limitations',
  'recommended_action',
  'learning_record',
];

const publicAnalyticArtifact = (artifact, dataProvenance, qualityFields) => {
  const publicArtifact = {};
  for (const field of ANALYTIC_PUBLIC_ARTIFACT_FIELDS) {
    if (Object.hasOwn(artifact, field)) publicArtifact[field] = artifact[field];
  }
  return {
    ...publicArtifact,
    data_provenance: dataProvenance,
    ...qualityFields,
  };
};

const analyticReceiptCapability = (capabilities) => {
  const capability = capabilities?.analyticArtifact?.evidenceReceipt;
  if (capability === undefined) return { ok: true, required: false };
  const companions = isRecord(capability)
    ? ANALYTIC_EVIDENCE_RECEIPT_CONTRACTS[capability.contract]
    : undefined;
  if (!isRecord(capability)
    || !companions
    || capability.requiredForSlide !== true
    || !Array.isArray(capability.companions)
    || companions.some((entry) => !capability.companions.includes(entry))) {
    return { ok: false, reason: 'The runtime advertised an invalid analytic evidence receipt capability.' };
  }
  return { ok: true, required: true, contract: capability.contract };
};

const readJsonCompanion = async (file, label) => {
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
  return parseJsonOutput(contents, label);
};

const requireRegularCompanion = async (value, field, expected, slideDirectory) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`runtime artifact.${field} is missing.`);
  }
  const file = value.trim();
  if (!path.isAbsolute(file) || path.normalize(file) !== file) {
    throw new Error(`runtime artifact.${field} must be a normalized absolute path.`);
  }
  if (path.dirname(file) !== slideDirectory || file !== expected) {
    throw new Error(`runtime artifact.${field} must be ${expected}.`);
  }
  let details;
  try {
    details = await stat(file);
  } catch (error) {
    throw new Error(`runtime artifact.${field} could not be read: ${error.message}`);
  }
  if (!details.isFile()) throw new Error(`runtime artifact.${field} must be a regular file.`);
  return file;
};

const validateReceiptSource = (source, kind, evidenceFile, evidence, requireProvenanceIds) => {
  if (!isRecord(source)
    || source.kind !== kind
    || typeof source.source !== 'string'
    || !source.source.trim()
    || typeof source.scope !== 'string'
    || !source.scope.trim()
    || !isRecord(source.window)
    || typeof source.window.start !== 'string'
    || typeof source.window.end !== 'string'
    || (requireProvenanceIds && (!Array.isArray(source.provenance_ids)
      || source.provenance_ids.length === 0
      || source.provenance_ids.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(source.provenance_ids).size !== source.provenance_ids.length))
    || source.evidence_file !== path.basename(evidenceFile)
    || source.evidence_sha256 !== analyticEvidenceSha256(evidence)) {
    throw new Error(`Analytic evidence receipt source ${kind} did not match ${path.basename(evidenceFile)}.`);
  }
};

const publicReceiptSource = (source) => ({
  kind: source.kind,
  source: source.source.trim(),
  scope: source.scope.trim(),
  window: {
    start: source.window.start,
    end: source.window.end,
  },
  ...(Array.isArray(source.provenance_ids)
    ? { provenance_ids: source.provenance_ids.map((id) => id.trim()) }
    : {}),
  evidence_sha256: source.evidence_sha256,
  evidence_file: source.evidence_file,
});

const validateAnalyticEvidenceCompanions = async ({ artifact, runtimeArtifact, slidePath, receiptContract }) => {
  if (!isRecord(runtimeArtifact)) {
    return { ok: false, reason: 'The runtime did not return the required analytic artifact companion paths.' };
  }
  try {
    const slideDirectory = path.dirname(slidePath);
    await requireRegularCompanion(slidePath, 'slideFile', slidePath, slideDirectory);
    if (runtimeArtifact.slideFile !== slidePath) {
      throw new Error('runtime artifact.slideFile must match analytic.slideFile.');
    }
    const analyticArtifactFile = await requireRegularCompanion(
      runtimeArtifact.analyticArtifactFile,
      'analyticArtifactFile',
      `${slidePath}.artifact.json`,
      slideDirectory,
    );
    const analyticReceiptFile = await requireRegularCompanion(
      runtimeArtifact.analyticReceiptFile,
      'analyticReceiptFile',
      `${slidePath}.evidence.json`,
      slideDirectory,
    );
    const analyticLocalEvidenceFile = await requireRegularCompanion(
      runtimeArtifact.analyticLocalEvidenceFile,
      'analyticLocalEvidenceFile',
      `${slidePath}.local-evidence.json`,
      slideDirectory,
    );
    const analyticSensorEvidenceFile = runtimeArtifact.analyticSensorEvidenceFile !== undefined
      ? await requireRegularCompanion(
          runtimeArtifact.analyticSensorEvidenceFile,
          'analyticSensorEvidenceFile',
          `${slidePath}.sensor-evidence.json`,
          slideDirectory,
        )
      : undefined;
    const analyticBenchmarkEvidenceFile = runtimeArtifact.analyticBenchmarkEvidenceFile !== undefined
      ? await requireRegularCompanion(
          runtimeArtifact.analyticBenchmarkEvidenceFile,
          'analyticBenchmarkEvidenceFile',
          `${slidePath}.benchmark-evidence.json`,
          slideDirectory,
        )
      : undefined;

    const [slideHtml, artifactSnapshot, receipt, localEvidence, sensorEvidence, benchmarkEvidence] = await Promise.all([
      readFile(slidePath, 'utf8'),
      readJsonCompanion(analyticArtifactFile, 'Analytic artifact companion'),
      readJsonCompanion(analyticReceiptFile, 'Analytic evidence receipt'),
      readJsonCompanion(analyticLocalEvidenceFile, 'Analytic local evidence companion'),
      analyticSensorEvidenceFile
        ? readJsonCompanion(analyticSensorEvidenceFile, 'Analytic sensor evidence companion')
        : Promise.resolve(undefined),
      analyticBenchmarkEvidenceFile
        ? readJsonCompanion(analyticBenchmarkEvidenceFile, 'Analytic benchmark evidence companion')
        : Promise.resolve(undefined),
    ]);
    if (!isRecord(artifactSnapshot) || canonicalJson(artifactSnapshot) !== canonicalJson(artifact)) {
      throw new Error('Analytic artifact companion did not match analytic.artifact.');
    }
    if (!isRecord(localEvidence)) throw new Error('Analytic local evidence companion must contain a JSON object.');
    const receiptV2 = receiptContract === 'density.analytic-evidence-receipt.v2';
    if (!isRecord(receipt)
      || receipt.contract !== receiptContract
      || receipt.generated_by !== 'density_question_pipeline'
      || receipt.artifact_sha256 !== analyticEvidenceSha256(artifact)
      || (receiptV2 && (typeof receipt.presentation_sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(receipt.presentation_sha256)))
      || !Array.isArray(receipt.sources)) {
      throw new Error('Analytic evidence receipt did not match the trusted question pipeline contract.');
    }
    if (receiptV2) {
      const receiptScript = /<script type="application\/json" id="density-analytic-evidence-receipt">([\s\S]*?)<\/script>\n?/;
      const embeddedMatch = slideHtml.match(receiptScript);
      if (!embeddedMatch) throw new Error('Analytic slide did not embed its evidence receipt.');
      let embeddedReceipt;
      try {
        embeddedReceipt = JSON.parse(embeddedMatch[1]);
      } catch {
        throw new Error('Analytic slide embedded an invalid evidence receipt.');
      }
      if (canonicalJson(embeddedReceipt) !== canonicalJson(receipt)) {
        throw new Error('Embedded and sidecar analytic evidence receipts did not match.');
      }
      const presentationHtml = slideHtml.replace(receiptScript, '');
      if (receipt.presentation_sha256 !== analyticPresentationSha256(presentationHtml)) {
        throw new Error('Analytic presentation digest did not match the displayed slide.');
      }
    }
    const localSources = receipt.sources.filter((source) => source?.kind === 'local_customer_data');
    const sensorSources = receipt.sources.filter((source) => source?.kind === 'density_sensor_health_api');
    const benchmarkSources = receipt.sources.filter((source) => source?.kind === 'density_benchmark_api');
    const benchmarkEvidenceUsed = benchmarkSources.length === 1;
    const sensorEvidenceUsed = sensorSources.length === 1;
    if (localSources.length !== 1 || sensorSources.length > (receiptV2 ? 1 : 0) || benchmarkSources.length > 1
      || receipt.sources.length !== 1 + sensorSources.length + benchmarkSources.length
      || Boolean(analyticSensorEvidenceFile) !== sensorEvidenceUsed
      || Boolean(analyticBenchmarkEvidenceFile) !== benchmarkEvidenceUsed) {
      throw new Error('Analytic evidence receipt must contain the exact local, sensor-health, and benchmark sources used.');
    }
    validateReceiptSource(localSources[0], 'local_customer_data', analyticLocalEvidenceFile, localEvidence, receiptV2);
    if (sensorEvidenceUsed) {
      if (!isRecord(sensorEvidence)) throw new Error('Analytic sensor evidence companion must contain a JSON object.');
      validateReceiptSource(sensorSources[0], 'density_sensor_health_api', analyticSensorEvidenceFile, sensorEvidence, true);
    }
    if (benchmarkEvidenceUsed) {
      if (!isRecord(benchmarkEvidence)) throw new Error('Analytic benchmark evidence companion must contain a JSON object.');
      validateReceiptSource(benchmarkSources[0], 'density_benchmark_api', analyticBenchmarkEvidenceFile, benchmarkEvidence, receiptV2);
    }
    if (receiptV2) {
      const artifactProvenanceIds = new Set((artifact.data_provenance ?? [])
      .map((entry) => entry?.id)
      .filter((id) => typeof id === 'string' && id.trim()));
      const boundProvenanceIds = new Set();
      for (const source of receipt.sources) {
        for (const id of source.provenance_ids) {
          if (!artifactProvenanceIds.has(id)) {
            throw new Error(`Analytic evidence receipt references unknown provenance id '${id}'.`);
          }
          if (boundProvenanceIds.has(id)) throw new Error(`Analytic evidence receipt repeats provenance id '${id}'.`);
          boundProvenanceIds.add(id);
        }
      }
      if (boundProvenanceIds.size !== artifactProvenanceIds.size) {
        throw new Error('Analytic evidence receipt did not bind every artifact provenance id.');
      }
      if (sensorEvidenceUsed
        && (sensorSources[0].provenance_ids.length !== 1 || sensorSources[0].provenance_ids[0] !== 'sensor_status_live')) {
        throw new Error('Analytic sensor evidence must bind sensor_status_live only.');
      }
      if (benchmarkEvidenceUsed
        && (benchmarkSources[0].provenance_ids.length !== 1 || benchmarkSources[0].provenance_ids[0] !== 'density_benchmark')) {
        throw new Error('Analytic benchmark evidence must bind density_benchmark only.');
      }
      if (localSources[0].provenance_ids.some((id) => id === 'sensor_status_live' || id === 'density_benchmark')) {
        throw new Error('Analytic local evidence cannot bind cloud sensor or benchmark provenance.');
      }
    }
    const paths = {
      slideFile: slidePath,
      analyticArtifactFile,
      analyticReceiptFile,
      analyticLocalEvidenceFile,
      ...(analyticSensorEvidenceFile ? { analyticSensorEvidenceFile } : {}),
      ...(analyticBenchmarkEvidenceFile ? { analyticBenchmarkEvidenceFile } : {}),
    };
    return {
      ok: true,
      paths,
      evidenceReceipt: {
        contract: receipt.contract,
        generated_by: receipt.generated_by,
        artifact_sha256: receipt.artifact_sha256,
        ...(receipt.presentation_sha256 ? { presentation_sha256: receipt.presentation_sha256 } : {}),
        sources: receipt.sources.map(publicReceiptSource),
        ...paths,
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};

const normalizeAnalyticPayload = async ({
  analytic,
  panelTarget,
  runtimeArtifact,
  question,
  requestedMode,
  capabilities,
  required = false,
}) => {
  if (analytic === undefined) {
    return required
      ? { ok: false, reason: 'Density did not return a validated analytic artifact.' }
      : { ok: true, analytic: undefined, panelTarget: undefined };
  }
  if (!isRecord(analytic) || !isRecord(analytic.artifact)) {
    return { ok: false, reason: 'Density did not return a validated analytic artifact.' };
  }
  const artifact = analytic.artifact;
  const privateTopLevelFields = ['provenance', 'raw_provenance']
    .filter((field) => Object.hasOwn(artifact, field));
  if (privateTopLevelFields.length > 0) {
    return {
      ok: false,
      reason: `${privateTopLevelFields.join(', ')} are not part of the analytic artifact contract.`,
    };
  }
  if (!analyticQuestionIdentity(artifact.question)
    || analyticQuestionIdentity(artifact.question) !== analyticQuestionIdentity(question)) {
    return { ok: false, reason: 'analytic.artifact.question did not match the requested question.' };
  }
  if (!['supported', 'context_needed', 'blocked'].includes(artifact.confidence)) {
    return { ok: false, reason: 'analytic.artifact.confidence was not a supported analytic state.' };
  }
  if (!['text', 'chart', 'slide'].includes(artifact.response_mode)) {
    return { ok: false, reason: 'analytic.artifact.response_mode must be text, chart, or slide.' };
  }
  const gates = validatedAnalyticGates(analytic.gates);
  if (gates === undefined) {
    return { ok: false, reason: 'analytic.gates did not contain exactly the ordered gate sequence 1 through 5.' };
  }
  const dataProvenance = validatedDataProvenance(artifact.data_provenance);
  if (!dataProvenance
    || typeof artifact.source !== 'string'
    || !artifact.source.trim()
    || typeof artifact.methodology !== 'string'
    || !artifact.methodology.trim()
    || (artifact.limitations !== undefined
      && (!Array.isArray(artifact.limitations)
        || artifact.limitations.some((entry) => typeof entry !== 'string' || !entry.trim())))) {
    return { ok: false, reason: 'analytic.artifact trust fields did not match the validated artifact contract.' };
  }
  if (artifact.confidence === 'supported'
    && (typeof artifact.headline !== 'string'
      || !artifact.headline.trim()
      || typeof artifact.subtitle !== 'string'
      || !artifact.subtitle.trim())) {
    return { ok: false, reason: 'A supported artifact must include a non-empty headline and subtitle.' };
  }
  if (artifact.confidence === 'context_needed'
    && (typeof artifact.measured_observation !== 'string'
      || !artifact.measured_observation.trim()
      || typeof artifact.follow_up_question !== 'string'
      || !artifact.follow_up_question.trim())) {
    return { ok: false, reason: 'A context_needed artifact must include measured_observation and follow_up_question.' };
  }
  const qualityFields = normalizedAnalyticQualityFields(artifact);
  if (!qualityFields.ok) return qualityFields;
  const publicArtifact = publicAnalyticArtifact(artifact, dataProvenance, qualityFields.fields);
  const recordId = learningRecordId(analytic.learningRecordId);
  if (recordId === null) return { ok: false, reason: 'analytic.learningRecordId did not match the Density learning record id contract.' };
  if (analytic.learningWarning !== undefined
    && (typeof analytic.learningWarning !== 'string' || !analytic.learningWarning.trim())) {
    return { ok: false, reason: 'analytic.learningWarning must be a non-empty string when present.' };
  }

  const supportedSlide = artifact.confidence === 'supported' && artifact.response_mode === 'slide';
  const receiptCapability = supportedSlide
    ? analyticReceiptCapability(capabilities)
    : { ok: true, required: false };
  if (!receiptCapability.ok) return receiptCapability;
  const legacyReceipt = receiptCapability.contract === 'density.analytic-evidence-receipt.v1';

  let normalizedTarget;
  if (analytic.slideFile !== undefined || runtimeArtifact?.slideFile !== undefined || panelTarget !== undefined) {
    const target = validatedSlideTarget(analytic, panelTarget, runtimeArtifact);
    if (!target.ok) return target;
    normalizedTarget = target;
  }
  const unsupportedMode = requestedMode === 'slide'
    && artifact.confidence === 'supported'
    && (artifact.response_mode !== 'slide' || legacyReceipt);
  if (requestedMode === 'slide' && artifact.confidence === 'supported'
    && artifact.response_mode === 'slide' && !normalizedTarget && !legacyReceipt) {
    return { ok: false, reason: 'A supported slide artifact requires a validated slide file and panel target.' };
  }
  let companionValidation;
  if (receiptCapability.required && supportedSlide) {
    if (!normalizedTarget) {
      return { ok: false, reason: 'A trusted analytic evidence receipt requires a validated slide target.' };
    }
    companionValidation = await validateAnalyticEvidenceCompanions({
      artifact,
      runtimeArtifact,
      slidePath: normalizedTarget.slidePath,
      receiptContract: receiptCapability.contract,
    });
    if (!companionValidation.ok) return companionValidation;
  }
  if (legacyReceipt) normalizedTarget = undefined;
  const deliveredMode = normalizedTarget
    ? 'slide'
    : artifact.response_mode === 'chart'
      ? 'chart'
      : 'text';
  const trustContext = analyticTrustContext({
    artifact: publicArtifact,
    capabilities,
    gates,
    dataProvenance,
    evidenceReceipt: companionValidation?.evidenceReceipt,
  });
  return {
    ok: true,
    artifact: publicArtifact,
    gates,
    trustContext,
    learningRecordId: recordId,
    learningWarning: typeof analytic.learningWarning === 'string' ? analytic.learningWarning.trim() : undefined,
    reviewNextAction: reviewLearningNextAction(recordId),
    analyticState: unsupportedMode ? 'unsupported_mode' : artifact.confidence,
    unsupportedMode,
    deliveredMode,
    ...(companionValidation ? {
      companionPaths: companionValidation.paths,
      evidenceReceipt: companionValidation.evidenceReceipt,
    } : {}),
    analytic: {
      artifact: publicArtifact,
      gates,
      ...(typeof analytic.chatHtml === 'string' ? { chatHtml: analytic.chatHtml } : {}),
      ...(typeof analytic.chatHtmlDark === 'string' ? { chatHtmlDark: analytic.chatHtmlDark } : {}),
      ...(recordId ? { learningRecordId: recordId } : {}),
      ...(typeof analytic.learningWarning === 'string' ? { learningWarning: analytic.learningWarning.trim() } : {}),
      ...(normalizedTarget ? { slideFile: normalizedTarget.slidePath } : {}),
      ...(companionValidation ? {
        ...companionValidation.paths,
        evidenceReceipt: companionValidation.evidenceReceipt,
      } : {}),
    },
    panelTarget: normalizedTarget?.panelTarget,
  };
};

export async function analyticSlide(args = {}) {
  const question = analyticSlideQuestion(args.question);
  const dataDir = analyticSlideDataDir(args.dataDir);
  const theme = resolveTheme(args.theme);
  const deadline = createHistoricalQuestionDeadline(args.timeoutMs ?? 30000);
  const base = { question, dataDir, requestedMode: 'slide' };
  const timedOutResponse = () => ({
    ...base,
    ok: false,
    timedOut: true,
    deliveredMode: 'none',
    validationState: 'unavailable',
    analyticState: 'unavailable',
    message: `Density could not produce the analytic slide inside the ${deadline.timeoutMs}ms wall-time budget.`,
    performance: { elapsedMs: Date.now() - deadline.startedAt, targetMs: deadline.timeoutMs },
  });
  const invalidResponse = (message, extra = {}) => ({
    ...base,
    ok: false,
    deliveredMode: 'none',
    validationState: 'invalid',
    analyticState: 'invalid',
    message,
    ...extra,
  });
  const cli = await requireCli();
  let remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) return timedOutResponse();
  const capabilities = await discoverCliCapabilities(cli, { dataDir, timeoutMs: remainingMs });
  if (deadline.remainingMs() <= 0 || (!capabilities.checked && /timed out/i.test(capabilities.reason ?? ''))) {
    return timedOutResponse();
  }
  if (!supportsAnalyticArtifact(capabilities, 'slide')) {
    return {
      ...base,
      ok: false,
      unsupported: true,
      deliveredMode: 'none',
      validationState: 'unavailable',
      analyticState: 'unsupported',
      cli: safeCliInfo(cli),
      capabilities,
      message: 'This Density CLI does not support validated analytic slide artifacts yet.',
    };
  }
  remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) return timedOutResponse();
  const result = await runDensity(cli, ['question', question, '--slide', ...(theme === undefined ? [] : ['--theme', theme]), '--format', 'ui'], {
    dataDir,
    allowFailure: true,
    timeoutMs: remainingMs,
  });
  if (result.timedOut || deadline.remainingMs() <= 0) return timedOutResponse();
  if (result.code !== 0) {
    return {
      ...base,
      ok: false,
      deliveredMode: 'none',
      validationState: 'unavailable',
      analyticState: 'unavailable',
      error: oneLine(result.stderr || result.stdout),
    };
  }
  let ui;
  try {
    ui = parseJsonOutput(result.stdout, 'Density analytic slide response');
  } catch (error) {
    return invalidResponse(error.message);
  }
  if (!isRecord(ui) || ui.kind !== 'density.agent-ui') {
    return invalidResponse('Density analytic slide response did not use the density.agent-ui payload contract.');
  }
  if (ui.clarificationRequest !== undefined) {
    const clarificationRequest = publicClarificationRequest(ui.clarificationRequest);
    if (!clarificationRequest) {
      return invalidResponse('clarificationRequest did not match the density.clarification contract.');
    }
    return {
      ...base,
      ok: false,
      deliveredMode: 'clarification',
      validationState: 'clarification_required',
      analyticState: 'clarification_required',
      clarificationRequest,
      message: clarificationRequest.prompt,
      cli: safeCliInfo(cli),
      capabilities,
    };
  }
  const normalized = await normalizeAnalyticPayload({
    analytic: ui.analytic,
    panelTarget: ui.panelTarget,
    runtimeArtifact: isRecord(ui.artifact) ? ui.artifact : ui.artifacts,
    question,
    requestedMode: 'slide',
    capabilities,
    required: true,
  });
  if (!normalized.ok) return invalidResponse(normalized.reason);
  const { artifact } = normalized;
  const summary = {
    ...base,
    headline: artifact.headline,
    subtitle: artifact.subtitle,
    confidence: artifact.confidence,
    validationState: 'rendered',
    analyticState: normalized.analyticState,
    generatedMode: normalized.deliveredMode,
    trustContext: normalized.trustContext,
    ...(normalized.learningRecordId ? { learningRecordId: normalized.learningRecordId } : {}),
    ...(normalized.learningWarning ? { learningWarning: normalized.learningWarning } : {}),
    ...(normalized.reviewNextAction ? { reviewNextAction: { ...normalized.reviewNextAction, args: { ...normalized.reviewNextAction.args, dataDir } } } : {}),
  };
  if (normalized.unsupportedMode) {
    return {
      ...summary,
      ok: false,
      unsupportedMode: true,
      deliveredMode: 'text',
      message: 'Density returned a validated text answer, but this question does not currently support a slide.',
    };
  }
  if (artifact.confidence === 'context_needed') {
    return {
      ...summary,
      ok: false,
      deliveredMode: normalized.deliveredMode,
      measuredObservation: artifact.measured_observation.trim(),
      followUpQuestion: artifact.follow_up_question.trim(),
      message: artifact.follow_up_question.trim(),
    };
  }
  if (artifact.confidence === 'blocked') {
    return {
      ...summary,
      ok: false,
      deliveredMode: normalized.deliveredMode,
      message: typeof artifact.measured_observation === 'string' && artifact.measured_observation.trim()
        ? artifact.measured_observation.trim()
        : 'The validated analytic result is blocked and did not produce a slide.',
    };
  }
  return {
    ...summary,
    ok: true,
    deliveredMode: 'none',
    deliveryState: 'generated',
    slidePath: normalized.analytic.slideFile,
    panelTarget: normalized.panelTarget,
    ...(normalized.companionPaths ?? {}),
    ...(normalized.evidenceReceipt ? { evidenceReceipt: normalized.evidenceReceipt } : {}),
  };
}

export const ANALYTIC_LEARNING_LABELS = Object.freeze([
  'gold_standard',
  'good_with_fixes',
  'useful_redesign_required',
  'reject',
  'blocked_missing_data',
]);

const DEFAULT_ANALYTIC_LEARNING_LIMIT = 25;
const MAX_ANALYTIC_LEARNING_LIMIT = 100;

const analyticLearningLimit = (value) => {
  if (value === undefined) return DEFAULT_ANALYTIC_LEARNING_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_ANALYTIC_LEARNING_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_ANALYTIC_LEARNING_LIMIT}.`);
  }
  return value;
};

const analyticLearningOffset = (value) => {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('offset must be a non-negative integer.');
  }
  return value;
};

const learningTimeoutMs = (value) => {
  const timeoutMs = value === undefined ? 10000 : Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new Error('timeoutMs must be a positive number no greater than 120000.');
  }
  return timeoutMs;
};

const optionalLearningText = (value, field) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${field} must be a non-empty string without null bytes.`);
  }
  if (value.length > 10000) throw new Error(`${field} must be 10000 characters or fewer.`);
  return value.trim();
};

const validatedLearningRecord = (record) => {
  if (!isRecord(record)) return undefined;
  const id = learningRecordId(record.id);
  if (!id
    || typeof record.recorded_at !== 'string'
    || Number.isNaN(Date.parse(record.recorded_at))
    || !['clarification', 'artifact_review'].includes(record.record_type)
    || typeof record.measured_observation !== 'string'
    || !record.measured_observation.trim()
    || typeof record.artifact_ref !== 'string'
    || !/^sha256:[0-9a-f]{64}$/i.test(record.artifact_ref)) {
    return undefined;
  }
  return {
    ...record,
    id,
    measured_observation: record.measured_observation.trim(),
  };
};

const compactLearningRecord = (record) => ({
  id: record.id,
  recorded_at: record.recorded_at,
  record_type: record.record_type,
  measured_observation: record.measured_observation,
  ...(record.follow_up_question !== undefined ? { follow_up_question: record.follow_up_question } : {}),
  artifact_ref: record.artifact_ref,
  ...(record.customer_answer !== undefined ? { customer_answer: record.customer_answer } : {}),
  ...(record.final_interpretation !== undefined ? { final_interpretation: record.final_interpretation } : {}),
  ...(record.reviewer_label !== undefined ? { reviewer_label: record.reviewer_label } : {}),
  ...(record.resolved_at !== undefined ? { resolved_at: record.resolved_at } : {}),
});

export async function listAnalyticLearningRecords(args = {}) {
  const dataDir = analyticSlideDataDir(args.dataDir);
  const timeoutMs = learningTimeoutMs(args.timeoutMs);
  const limit = analyticLearningLimit(args.limit);
  const offset = analyticLearningOffset(args.offset);
  const cli = await requireCli();
  const result = await runDensity(cli, [
    'learning',
    'list',
    '--data-dir', dataDir,
    '--compact',
    '--limit', String(limit),
    '--offset', String(offset),
    '--format', 'json',
  ], {
    dataDir,
    allowFailure: true,
    timeoutMs,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      unsupported: !result.timedOut,
      dataDir,
      error: result.timedOut ? 'Density analytic learning list timed out.' : oneLine(result.stderr || result.stdout),
      nextAction: { id: 'update_cli_for_analytic_learning', label: 'Update the Density runtime to use the analytic learning workflow.' },
    };
  }
  const payload = parseJsonOutput(result.stdout, 'Density analytic learning response');
  if (!isRecord(payload) || !Array.isArray(payload.records) || !Array.isArray(payload.corruptLines)) {
    throw new Error('Density analytic learning response did not match the list contract.');
  }
  const validatedRecords = payload.records.map(validatedLearningRecord);
  if (validatedRecords.some((record) => record === undefined)) {
    throw new Error('Density analytic learning response contained a malformed record.');
  }
  if (!Number.isSafeInteger(payload.total)
    || payload.total < 0
    || payload.limit !== limit
    || payload.offset !== offset
    || typeof payload.hasMore !== 'boolean') {
    throw new Error('Density analytic learning response did not include valid pagination metadata.');
  }
  if (validatedRecords.length > limit) {
    throw new Error('Density analytic learning response exceeded the requested limit.');
  }
  const records = validatedRecords.map(compactLearningRecord);
  if (payload.hasMore
    && (!Number.isSafeInteger(payload.nextOffset)
      || payload.nextOffset !== offset + records.length
      || payload.nextOffset <= offset)) {
    throw new Error('Density analytic learning response did not include an actionable nextOffset.');
  }
  if (!payload.hasMore && payload.nextOffset !== undefined) {
    throw new Error('Density analytic learning response included nextOffset without additional records.');
  }
  return {
    ok: true,
    dataDir,
    limit,
    offset,
    total: payload.total,
    hasMore: payload.hasMore,
    ...(payload.hasMore ? { nextOffset: payload.nextOffset } : {}),
    records,
    corruptLines: payload.corruptLines,
    cli: safeCliInfo(cli),
  };
}

export async function reviewAnalyticLearningRecord(args = {}) {
  const id = learningRecordId(args.id);
  if (!id) throw new Error('id must be a valid Density analytic learning record id.');
  const answer = optionalLearningText(args.answer, 'answer');
  const interpretation = optionalLearningText(args.interpretation, 'interpretation');
  const label = args.label === undefined ? undefined : String(args.label);
  if (label !== undefined && !ANALYTIC_LEARNING_LABELS.includes(label)) {
    throw new Error(`label must be one of: ${ANALYTIC_LEARNING_LABELS.join(', ')}.`);
  }
  if (answer === undefined && interpretation === undefined && label === undefined) {
    throw new Error('An analytic learning review requires an answer, interpretation, or label.');
  }
  const dataDir = analyticSlideDataDir(args.dataDir);
  const timeoutMs = learningTimeoutMs(args.timeoutMs);
  const cli = await requireCli();
  const command = ['learning', 'review', '--id', id, '--data-dir', dataDir];
  if (answer !== undefined) command.push('--answer', answer);
  if (interpretation !== undefined) command.push('--interpretation', interpretation);
  if (label !== undefined) command.push('--label', label);
  const result = await runDensity(cli, command, { dataDir, allowFailure: true, timeoutMs });
  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      unsupported: !result.timedOut,
      id,
      dataDir,
      error: result.timedOut ? 'Density analytic learning review timed out.' : oneLine(result.stderr || result.stdout),
    };
  }
  return {
    ok: true,
    id,
    dataDir,
    ...(label ? { label } : {}),
    reviewed: true,
    message: oneLine(result.stdout) || `Reviewed learning record ${id}.`,
    cli: safeCliInfo(cli),
  };
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
  const presentation = resolvePresentation(args.presentation, 'slide');
  const theme = resolveTheme(args.theme);
  const dataDir = resolveDataDir(args.dataDir);
  const priorChart = readChartContext(dataDir);
  const chartFollowUp = isChartFollowUpQuestion(question) ? priorChart : undefined;
  const contextualFollowUp = isContextualAnalyticsFollowUp(question) ? priorChart : undefined;
  const needsFloorplan = floorplanArtifactIntent(question);
  const metadataIntent = metadataQuestionIntent(question);
  const metadataRouting = metadataQuestionRouting(metadataIntent);
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
  if (currentAvailabilityIntent(question) && !metadataIntent && !contextualFollowUp && !chartFollowUp) {
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
  if (dataHealthIntent(question) && metadataIntent !== 'local_data_freshness') {
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
  if (args.includeAnalyticArtifact !== true && (chartFollowUp?.chart || chartFollowUp?.html || chartFollowUp?.png)) {
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
  const effectiveQuestion = chartFollowUp?.question
    ?? (contextualFollowUp?.question
    ? rewriteContextualQuestion(question, contextualFollowUp)
    : question);
  const followUp = chartFollowUp?.question
    ? {
        type: 'reuse_previous_chart',
        previousQuestion: chartFollowUp.question,
        effectiveQuestion,
        reason: 'The question asked to show the previous answer as a chart, so the plugin reused the prior analytic question and reattached its canonical slide.',
      }
    : contextualFollowUp?.question
      ? {
          type: 'rewrite_contextual_question',
          previousQuestion: contextualFollowUp.question,
          effectiveQuestion,
          reason: 'The question depended on the previous analytics answer, so the plugin preserved the prior scope and metric context before calling the CLI.',
        }
      : undefined;
  const deadline = createHistoricalQuestionDeadline(args.timeoutMs);
  const remainingWallMs = deadline.remainingMs;
  const timedOutResponse = () => historicalQuestionTimedOut({
    question,
    dataDir,
    deadline,
    intent: 'local_utilization_timeout',
  });
  const cli = await requireCli();
  let analyticCapabilities;
  if (presentation === 'slide' || args.includeAnalyticArtifact === true) {
    const capabilityRemainingMs = remainingWallMs();
    if (capabilityRemainingMs <= 0) return timedOutResponse();
    analyticCapabilities = await discoverCliCapabilities(cli, { dataDir, timeoutMs: capabilityRemainingMs });
  }
  const initialRemainingMs = remainingWallMs();
  if (initialRemainingMs <= 0) return timedOutResponse();
  const analyticArtifactSupported = supportsAnalyticArtifact(analyticCapabilities);
  const useAnalyticSlide = presentation === 'slide' && supportsAnalyticArtifact(analyticCapabilities, 'slide');
  const presentationFlag = useAnalyticSlide ? '--slide' : '--chart';
  const themeArgs = theme === undefined ? [] : ['--theme', theme];
  const cachedUiAnswer = await runDensity(cli, ['question', effectiveQuestion, '--cached', presentationFlag, ...themeArgs, '--format', 'ui'], {
    dataDir,
    allowFailure: true,
    timeoutMs: initialRemainingMs,
  });
  if (cachedUiAnswer.timedOut) return timedOutResponse();
  let uiAnswer = cachedUiAnswer;
  if (!await cachedQuestionUiIsUsable(cachedUiAnswer)) {
    const remainingMs = remainingWallMs();
    if (remainingMs <= 0) return timedOutResponse();
    uiAnswer = await runDensity(cli, ['question', effectiveQuestion, presentationFlag, ...themeArgs, '--format', 'ui'], {
      dataDir,
      allowFailure: true,
      timeoutMs: remainingMs,
    });
  }
  if (uiAnswer.timedOut) return timedOutResponse();
  if (uiAnswer.code === 0) {
    const remainingMs = remainingWallMs();
    if (remainingMs <= 0) return timedOutResponse();
    const response = await parseQuestionUiAnswer({
      question: effectiveQuestion,
      dataDir,
      cli,
      result: uiAnswer,
      tool: 'local_utilization_query',
      renderTimeoutMs: remainingMs,
      analyticArtifactSupported,
      analyticCapabilities,
      includePanelTarget: useAnalyticSlide,
    });
    if (remainingWallMs() <= 0) return timedOutResponse();
    const responseWithRouting = {
      ...response,
      ...(analyticCapabilities ? { capabilities: analyticCapabilities } : {}),
      question,
      intent: metadataIntent ?? response.intent ?? 'local_utilization',
      routedTool: metadataRouting?.routedTool ?? response.routedTool,
      routing: metadataRouting ?? response.routing,
      followUp,
      benchmarkAffordance: response.ok === false || metadataIntent
        ? undefined
        : {
            sourceLayer: SOURCE_LAYERS.benchmarkNetworkContext,
            sourceBadge: sourceBadgeFor(SOURCE_LAYERS.benchmarkNetworkContext),
            label: 'Density benchmark network can add peer context when benchmark access is available.',
            tool: 'benchmark_compare',
          },
    };
    return {
      ...responseWithRouting,
      ...(presentation === 'slide'
        ? {
            presentationDelivery: presentationDelivery({
              requested: 'slide',
              slideSupported: useAnalyticSlide,
              response: responseWithRouting,
            }),
          }
        : {}),
    };
  }
  const questionUiSupported = analyticCapabilities?.generativeUi?.renderer === 'json-render'
    || analyticCapabilities?.commands?.questionUi;
  if (questionUiSupported) {
    return {
      ok: false,
      blocked: true,
      question,
      effectiveQuestion,
      intent: 'local_utilization_blocked',
      routedTool: 'local_utilization_query',
      sourceLayer: SOURCE_LAYERS.localCustomerData,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
      error: oneLine(uiAnswer.stderr || uiAnswer.stdout) || 'Density question UI failed after one recovery attempt.',
      retryBudget: { attempts: 2, exhausted: true },
      recovery: {
        avoid: ['shell', 'DuckDB', 'SQL', 'manual Parquet scans', 'hand-built chart scripts'],
      },
    };
  }
  const result = await askChartWithinDeadline(
    { ...args, question: effectiveQuestion, dataDir, presentation },
    deadline,
    analyticCapabilities,
  );
  if (result.timedOut) return timedOutResponse();
  return {
    ...result,
    question,
    intent: metadataIntent ?? result.intent,
    routedTool: metadataRouting?.routedTool ?? result.routedTool,
    routing: metadataRouting ?? result.routing,
    followUp,
    sourceLayer: SOURCE_LAYERS.localCustomerData,
    sourceBadge: sourceBadgeFor(SOURCE_LAYERS.localCustomerData),
    provenance: localHistoricalProvenance({ dataDir, tool: 'local_utilization_query' }),
    benchmarkAffordance: result.ok && !metadataIntent
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
  const clarificationAnswer = String(args.clarificationAnswer || '').trim();
  const effectiveQuestion = clarificationAnswer
    ? `${question} User clarification: ${clarificationAnswer}`
    : question;
  const presentation = resolvePresentation(args.presentation, 'slide');
  const response = await localUtilizationQuery({
    ...args,
    question: effectiveQuestion,
    presentation,
    includeAnalyticArtifact: presentation === 'slide',
  });
  const responseWithReadiness = response.intent === 'sensor_health' || response.ui || response.timedOut || response.blocked
    ? response
    : await attachBuildingReadiness(response, args);
  const routedTool = response.routedTool ?? 'local_utilization_query';
  return {
    ...responseWithReadiness,
    question,
    ...(clarificationAnswer ? { clarificationAnswer } : {}),
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
          label: `Fetch ${DEFAULT_METRICS_DAYS} days for all locations, then continue deeper history in the background.`,
          tool: 'onboard_customer',
          args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true, backgroundDeepSync: true },
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

const normalizedScopeName = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/\b(?:the|building|site|office|location|floor)\b/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const SENSOR_STATUS_PREPOSITIONAL_PHRASE = /\b(?:in|at)\s+(?:(?:an?|the)\s+)?(?:errors?(?:\s+(?:state|status|condition))?|(?:good|bad|poor)\s+health|healthy|unhealthy|online|offline|unconfigured|stale|(?:in\s+)?need(?:ing)?\s+(?:of\s+)?attention|risk)(?=\b)/gi;

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
  const startedAt = Date.now();
  const dataDir = resolveDataDir(args.dataDir);
  const contract = {
    source: 'density_cloud_only',
    noLocalDuckdbFallback: true,
    rawStatusPreserved: true,
    lifecycleMappingSource: ['sensor_locations', 'atlas_spaces_flat'],
    benchmark: 'not_comparable',
  };
  if (args.organizationId || args.buildingId || args.floorId || (Array.isArray(args.spaceIds) && args.spaceIds.length > 0)) {
    return {
      ok: false,
      unsupported: true,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      contract,
      message: 'The current CLI sensor-health contract is organization-wide. Explicit ID scope was not applied, so no broader result was returned.',
      nextAction: {
        id: 'ask_organization_sensor_health',
        label: 'Ask for organization-wide sensor health, or wait for scoped sensor-health support.',
      },
      userVisiblePrimaryActions: 1,
    };
  }

  const question = String(args.question || '').trim();
  if (requestsHistoricalSensorSnapshot(question)) {
    return {
      ok: false,
      unsupported: true,
      currentOnly: true,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      contract,
      message: 'Sensor health currently supports only the latest cloud snapshot; historical sensor-status questions are not available.',
      nextAction: {
        id: 'ask_current_sensor_health',
        label: 'Ask for the current sensor-health snapshot instead.',
      },
      userVisiblePrimaryActions: 1,
    };
  }
  if (requestsUnapprovedSignalDiagnosis(question)) {
    return {
      ok: false,
      unsupported: true,
      currentOnly: true,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      contract: {
        ...contract,
        staleThreshold: 'not_defined',
      },
      message: 'No approved heartbeat-age threshold is available for classifying a sensor as healthy, stale, or offline.',
      nextAction: {
        id: 'use_raw_sensor_status',
        label: 'Ask for the current raw cloud sensor-status counts instead.',
      },
      userVisiblePrimaryActions: 1,
    };
  }
  const cliQuestion = /\bsensors?\b/i.test(question) && /\b(?:online|offline|error|errors|unconfigured|health|healthy|unhealthy|heartbeat|heartbeats|reporting|stale|attention)\b/i.test(question)
    ? question
    : 'How many sensors are online, are any reporting errors or unconfigured, and where?';
  const timeoutMs = args.timeoutMs === undefined ? 5000 : Number(args.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive number.');
  const deadline = startedAt + timeoutMs;
  const cli = await requireCli();
  const capabilityTimeoutMs = Math.min(deadline - Date.now(), 1500);
  if (capabilityTimeoutMs <= 0) {
    return {
      ok: false,
      unsupported: false,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      contract,
      error: 'Sensor health capability check is unavailable because the request deadline elapsed.',
    };
  }
  const capabilities = await discoverCliCapabilities(cli, {
    dataDir,
    timeoutMs: capabilityTimeoutMs,
  });
  if (!capabilities.checked) {
    return {
      ok: false,
      unsupported: false,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      contract,
      error: 'Density sensor-health capability is temporarily unavailable.',
    };
  }
  if (!capabilities.commands?.questionSensorHealth) {
    return {
      ok: false,
      unsupported: true,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      contract,
      capabilities,
      message: 'This Density CLI does not support first-class sensor-health questions yet.',
      nextAction: {
        id: 'update_cli_for_sensor_health',
        label: 'Update/build a Density CLI with questionSensorHealth capability.',
      },
      userVisiblePrimaryActions: 1,
    };
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return {
      ok: false,
      unsupported: false,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      contract,
      error: 'Sensor health request timed out before the cloud question could run.',
    };
  }
  const result = await runDensity(cli, ['question', cliQuestion, '--chart', '--format', 'ui'], {
    dataDir,
    allowFailure: true,
    timeoutMs: remainingMs,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      unsupported: false,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      contract,
      error: result.timedOut ? 'Sensor health request timed out.' : 'Density sensor health request failed.',
    };
  }

  let response;
  try {
    const renderTimeoutMs = deadline - Date.now();
    if (renderTimeoutMs <= 0) throw new Error('Sensor health request deadline elapsed before PNG rendering.');
    const parsedResponse = await parseQuestionUiAnswer({
      question: question || cliQuestion,
      dataDir,
      cli,
      result,
      tool: 'sensor_health_report',
      renderTimeoutMs,
      remember: false,
    });
    if (Date.now() > deadline) throw new Error('Sensor health request deadline elapsed during PNG rendering.');
    response = await validateAndAllowlistSensorResponse({
      response: parsedResponse,
      question: question || cliQuestion,
      elapsedMs: Date.now() - startedAt,
      targetMs: timeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      unsupported: false,
      sourceLayer: SOURCE_LAYERS.cloudSensorHealth,
      sourceBadge: sourceBadgeFor(SOURCE_LAYERS.cloudSensorHealth),
      sourceLabel: 'Density Sensor Health',
      contract,
      error: error?.code === 'SCOPE_MISMATCH'
        ? 'Density sensor health response scope did not match the requested scope.'
        : 'Density sensor health response could not be validated.',
    };
  }
  if (!response.png) {
    return {
      ...response,
      ok: false,
      partial: true,
      unsupported: false,
      contract,
      error: 'PNG renderer is unavailable; the validated answer and SVG chart are still available.',
      nextAction: {
        id: 'install_png_renderer',
        label: 'Install rsvg-convert to generate the required PNG chart.',
      },
      userVisiblePrimaryActions: 1,
    };
  }
  return {
    ...response,
    unsupported: false,
    contract,
    capabilities,
    userVisiblePrimaryActions: 0,
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
  const sourceDir = args.sourceDir || defaultDemoSourceDir();
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
