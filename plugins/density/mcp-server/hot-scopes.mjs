import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_HOT_SCOPES_MAX = 20;
export const DEFAULT_HOT_SCOPES_MAX_AGE_MS = 14 * DAY_MS;
export const DEFAULT_HOT_REFRESH_INTERVAL_MS = HOUR_MS;

const HOT_SCOPE_TYPES = new Set(['building', 'floor', 'space']);

const positiveIntegerSetting = (name, value, fallback) => {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
};

export const resolveHotScopeSettings = (environment = process.env) => ({
  maxScopes: positiveIntegerSetting('DENSITY_HOT_SCOPES_MAX', environment.DENSITY_HOT_SCOPES_MAX, DEFAULT_HOT_SCOPES_MAX),
  maxAgeMs: positiveIntegerSetting('DENSITY_HOT_SCOPES_MAX_AGE_MS', environment.DENSITY_HOT_SCOPES_MAX_AGE_MS, DEFAULT_HOT_SCOPES_MAX_AGE_MS),
  refreshIntervalMs: positiveIntegerSetting('DENSITY_HOT_REFRESH_INTERVAL_MS', environment.DENSITY_HOT_REFRESH_INTERVAL_MS, DEFAULT_HOT_REFRESH_INTERVAL_MS),
  disabled: environment.DENSITY_DISABLE_BACKGROUND_REFRESH === '1',
});

const hotScopesFile = (dataDir) => path.join(dataDir, 'hot-scopes.json');

const normalizedEntry = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value.scopeId !== 'string' || !value.scopeId || !HOT_SCOPE_TYPES.has(value.type)) return undefined;
  if (typeof value.lastAskedAt !== 'string' || !Number.isFinite(Date.parse(value.lastAskedAt))) return undefined;
  if (!Number.isInteger(value.count) || value.count < 1) return undefined;
  return {
    scopeId: value.scopeId,
    type: value.type,
    lastAskedAt: value.lastAskedAt,
    count: value.count,
  };
};

const activeEntries = (entries, now, settings) => {
  const cutoff = now.getTime() - settings.maxAgeMs;
  const byScope = new Map();
  for (const value of entries) {
    const entry = normalizedEntry(value);
    if (!entry || Date.parse(entry.lastAskedAt) < cutoff) continue;
    const previous = byScope.get(entry.scopeId);
    if (!previous || entry.lastAskedAt > previous.lastAskedAt) byScope.set(entry.scopeId, entry);
  }
  return [...byScope.values()]
    .sort((left, right) => right.lastAskedAt.localeCompare(left.lastAskedAt))
    .slice(0, settings.maxScopes);
};

const readDocument = async (dataDir) => {
  try {
    const parsed = JSON.parse(await readFile(hotScopesFile(dataDir), 'utf8'));
    if (parsed?.kind !== 'density.hot-scopes.v1' || !Array.isArray(parsed.scopes)) {
      throw new Error('The hot scope file has an unsupported format.');
    }
    return parsed.scopes;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

const atomicWrite = async (dataDir, scopes) => {
  await mkdir(dataDir, { recursive: true });
  const file = hotScopesFile(dataDir);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ kind: 'density.hot-scopes.v1', scopes }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
};

export const readHotScopes = async (dataDir, options = {}) => {
  const settings = options.settings ?? resolveHotScopeSettings(options.environment);
  const now = options.now ?? new Date();
  return activeEntries(await readDocument(dataDir), now, settings);
};

export const writeHotScope = async (dataDir, scope, options = {}) => {
  if (!scope || !HOT_SCOPE_TYPES.has(scope.type) || typeof scope.scopeId !== 'string' || !scope.scopeId) return false;
  const settings = options.settings ?? resolveHotScopeSettings(options.environment);
  const now = options.now ?? new Date();
  const entries = activeEntries(await readDocument(dataDir), now, settings);
  const previous = entries.find((entry) => entry.scopeId === scope.scopeId);
  const next = activeEntries([
    ...entries.filter((entry) => entry.scopeId !== scope.scopeId),
    {
      scopeId: scope.scopeId,
      type: scope.type,
      lastAskedAt: now.toISOString(),
      count: (previous?.count ?? 0) + 1,
    },
  ], now, settings);
  await atomicWrite(dataDir, next);
  return true;
};

const sameUtcDay = (left, right) => left.slice(0, 10) === right.toISOString().slice(0, 10);

export const createHotScopeManager = ({
  dataDir,
  environment = process.env,
  freshness,
  refreshScope,
  intradayEnabled = () => false,
  now = () => new Date(),
  startInterval = setInterval,
  stopInterval = clearInterval,
}) => {
  const settings = resolveHotScopeSettings(environment);
  let mutation = Promise.resolve();
  let pass = Promise.resolve();
  let timer;
  let started = false;
  let snapshot = { lastRunAt: null, scopes: [] };

  const mutate = (operation) => {
    const result = mutation.then(operation);
    mutation = result.catch(() => undefined);
    return result;
  };

  const record = (scope) => settings.disabled
    ? Promise.resolve(false)
    : mutate(() => writeHotScope(dataDir, scope, { settings, now: now() }));

  const runOnce = async () => {
    const runAt = now();
    const scopes = await mutate(async () => {
      const active = await readHotScopes(dataDir, { settings, now: runAt });
      await atomicWrite(dataDir, active);
      return active;
    });
    const states = [];
    for (const scope of scopes) {
      const freshnessState = await freshness(scope);
      const metrics = freshnessState?.streams?.find((stream) => stream.name === 'metrics');
      if (!metrics || metrics.stale !== true) {
        states.push({
          scopeId: scope.scopeId,
          state: metrics?.stale === false ? 'fresh' : 'unknown',
          coveredThrough: metrics?.observedAt ?? null,
        });
        continue;
      }
      try {
        const result = await refreshScope({
          scope: scope.scopeId,
          scopeType: scope.type,
          streams: ['metrics'],
          wait: false,
          ...(intradayEnabled() && sameUtcDay(scope.lastAskedAt, runAt) ? { intraday: true } : {}),
        });
        states.push({
          scopeId: scope.scopeId,
          state: result?.state ?? (result?.ok === false ? 'failed' : 'running'),
          coveredThrough: result?.coverage?.coverageThrough ?? null,
        });
      } catch {
        states.push({ scopeId: scope.scopeId, state: 'failed', coveredThrough: null });
      }
    }
    snapshot = { lastRunAt: runAt.toISOString(), scopes: states };
    return snapshot;
  };

  const run = () => {
    const result = pass.then(runOnce);
    pass = result.catch(() => undefined);
    return result;
  };

  const start = async () => {
    if (started || settings.disabled) return snapshot;
    started = true;
    await run();
    timer = startInterval(() => void run(), settings.refreshIntervalMs);
    timer?.unref?.();
    return snapshot;
  };

  const stop = () => {
    if (timer !== undefined) stopInterval(timer);
    timer = undefined;
  };

  return {
    record,
    run,
    start,
    stop,
    status: () => structuredClone(snapshot),
    settings,
  };
};
