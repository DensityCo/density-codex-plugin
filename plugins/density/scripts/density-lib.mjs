import { access, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const defaultDataDir = () => path.join(os.homedir(), '.density-cli');
const latestPluginManifestUrl = () => process.env.DENSITY_PLUGIN_LATEST_MANIFEST_URL
  ?? 'https://raw.githubusercontent.com/DensityCo/density-codex-plugin/main/plugins/density/.codex-plugin/plugin.json';
const capabilityCache = new Map();
const storageCache = new Map();
const CACHE_FINGERPRINT_TABLES = [
  'resources',
  'space_counts',
  'space_events',
  'space_occupancy',
  'space_metrics',
  'data_sources',
  'external_records',
  'spaces',
  'space_labels',
  'space_children',
];

export const fileExists = async (file) => {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const fileSize = async (file) => {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
};

const executable = async (file) => {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const which = async (name) => {
  const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = path.join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
};

export const redactSecrets = (value) => String(value ?? '')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
  .replace(/\b((?:access|refresh|id|auth|api|density)?_?token|jwt|authorization)(=|:)\s*([^\s"',}]+)/gi, '$1$2 [REDACTED]')
  .replace(/\b(sk|pk|dens)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]');

export const run = async (command, args = [], options = {}) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell ?? false,
    detached: options.detached ?? false,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timeout = Number(options.timeoutMs ?? 0);
  const timer = timeout > 0
    ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeout)
    : undefined;
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => {
    child.on('close', resolve);
  });
  if (timer) clearTimeout(timer);
  const result = {
    code,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
    timedOut,
  };
  if (code !== 0 && !options.allowFailure) {
    const reason = timedOut ? `timed out after ${timeout}ms` : (result.stderr || result.stdout);
    throw new Error(redactSecrets(`${command} ${args.join(' ')} failed (${code}): ${reason}`));
  }
  return result;
};

const knownCliRepos = () => [
  process.env.DENSITY_CLI_REPO,
  path.join(os.homedir(), 'dev', 'density-cli'),
].filter(Boolean);

export const resolveDensityCli = async () => {
  if (process.env.DENSITY_CLI_COMMAND) {
    return { command: process.env.DENSITY_CLI_COMMAND, args: [], source: 'DENSITY_CLI_COMMAND', path: process.env.DENSITY_CLI_COMMAND, explicit: true };
  }
  if (process.env.DENSITY_CLI_BIN && await fileExists(process.env.DENSITY_CLI_BIN)) {
    return { command: process.execPath, args: [process.env.DENSITY_CLI_BIN], source: 'DENSITY_CLI_BIN', path: process.env.DENSITY_CLI_BIN, explicit: true };
  }
  for (const repo of knownCliRepos()) {
    const bin = path.join(repo, 'bin', 'density.mjs');
    if (await fileExists(bin)) {
      return { command: process.execPath, args: [bin], source: repo, path: bin, repo };
    }
  }
  const pathDensity = await which('density');
  if (pathDensity) {
    return { command: pathDensity, args: [], source: 'PATH', path: pathDensity, ambiguous: true };
  }
  return undefined;
};

export const ensureDensityCliBuilt = async (cli) => {
  if (!cli?.repo) return { built: false, reason: 'not a local repo cli' };
  const dist = path.join(cli.repo, 'dist', 'cli.js');
  if (await fileExists(dist)) return { built: false, reason: 'already built' };
  await run('npm', ['install'], { cwd: cli.repo });
  await run('npm', ['run', 'build'], { cwd: cli.repo });
  return { built: true, reason: 'built local repo cli' };
};

export const runDensity = async (cli, args, options = {}) => {
  const env = {
    ...process.env,
    ...(options.dataDir ? { DENSITY_CLI_DATA_DIR: options.dataDir } : {}),
  };
  return run(cli.command, [...cli.args, ...args], {
    env,
    cwd: options.cwd,
    allowFailure: options.allowFailure,
    timeoutMs: options.timeoutMs,
  });
};

export const safeCliInfo = (cli) => cli
  ? {
      source: cli.source,
      path: cli.path,
      command: cli.command,
      args: cli.args,
      explicit: Boolean(cli.explicit),
      ambiguous: Boolean(cli.ambiguous),
    }
  : undefined;

const parquetFreshnessKey = async (dataDir) => {
  const parquetDir = path.join(dataDir ?? defaultDataDir(), 'parquet');
  try {
    const parts = [];
    for (const table of CACHE_FINGERPRINT_TABLES) {
      const flat = await summarizeParquetTarget(path.join(parquetDir, `${table}.parquet`));
      const partitioned = await summarizeParquetTarget(path.join(parquetDir, table));
      const files = flat.files + partitioned.files;
      const bytes = flat.bytes + partitioned.bytes;
      const modifiedAt = [flat.modifiedAt, partitioned.modifiedAt].filter(Boolean).sort().at(-1) ?? 'missing';
      parts.push(`${table}:${files}:${bytes}:${modifiedAt}`);
    }
    return parts.join('|');
  } catch {
    return 'missing';
  }
};

export const discoverCliCapabilities = async (cli, options = {}) => {
  if (!cli) {
    return { checked: false, chartQuestions: false, reason: 'Density CLI not found.' };
  }
  const dataDir = options.dataDir ?? defaultDataDir();
  const freshnessKey = await parquetFreshnessKey(dataDir);
  const cacheKey = JSON.stringify({
    cli: cli.path ?? cli.command,
    dataDir,
    freshnessKey,
  });
  if (capabilityCache.has(cacheKey)) return capabilityCache.get(cacheKey);
  const result = await runDensity(cli, ['capabilities', '--format', 'json'], {
    allowFailure: true,
    timeoutMs: options.timeoutMs ?? 5000,
    dataDir,
  });
  if (result.code !== 0) {
    const failed = {
      checked: false,
      chartQuestions: false,
      reason: result.timedOut ? 'Capability check timed out.' : (result.stderr || result.stdout || 'Capability check failed.'),
    };
    capabilityCache.set(cacheKey, failed);
    return failed;
  }
  try {
    const payload = JSON.parse(result.stdout);
    const availableBuildings = Boolean(
      payload.commands?.availableBuildings
      || payload.availableBuildings === true
      || payload.availableBuildings?.supported === true
    );
    const capabilities = {
      checked: true,
      version: typeof payload.version === 'string' ? payload.version : undefined,
      availableBuildings,
      chartQuestions: Boolean(payload.chartQuestions || payload.commands?.askChart),
      chartContract: payload.chartContract,
      htmlReports: Array.isArray(payload.htmlReports) ? payload.htmlReports : [],
      generativeUi: payload.generativeUi,
      questionAnswering: payload.questionAnswering,
      commands: payload.commands ?? {},
    };
    capabilityCache.set(cacheKey, capabilities);
    return capabilities;
  } catch (error) {
    const failed = {
      checked: false,
      chartQuestions: false,
      reason: `Capability JSON was not parseable: ${error.message}`,
    };
    capabilityCache.set(cacheKey, failed);
    return failed;
  }
};

export const parseAskOutput = (stdout) => {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const chartLine = lines.find((line) => line.startsWith('Chart: '));
  const htmlLine = lines.find((line) => line.startsWith('HTML: '));
  const prose = lines.filter((line) => !line.startsWith('Chart: ') && !line.startsWith('HTML: '));
  return {
    title: prose[0] ?? '',
    subtitle: prose[1] ?? '',
    chart: chartLine?.slice('Chart: '.length),
    html: htmlLine?.slice('HTML: '.length),
    raw: stdout,
  };
};

export const renderPng = async (svgFile) => {
  if (!svgFile) return undefined;
  const converter = await which('rsvg-convert');
  if (!converter) return undefined;
  const outDir = path.join(path.dirname(svgFile), 'png');
  await mkdir(outDir, { recursive: true });
  const pngFile = path.join(outDir, `${path.basename(svgFile, '.svg')}.png`);
  const result = await run(converter, ['-w', '1400', svgFile, '-o', pngFile], { allowFailure: true });
  return result.code === 0 ? pngFile : undefined;
};

async function summarizeParquetTarget(target) {
  let targetStat;
  try {
    targetStat = await stat(target);
  } catch {
    return { files: 0, bytes: 0, modifiedAt: undefined };
  }

  if (targetStat.isFile()) {
    return { files: 1, bytes: targetStat.size, modifiedAt: targetStat.mtime.toISOString() };
  }
  if (!targetStat.isDirectory()) {
    return { files: 0, bytes: 0, modifiedAt: undefined };
  }

  let files = 0;
  let bytes = 0;
  let newestMtime = targetStat.mtimeMs;
  const visit = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.parquet')) continue;
      const entryStat = await stat(entryPath);
      files += 1;
      bytes += entryStat.size;
      newestMtime = Math.max(newestMtime, entryStat.mtimeMs);
    }
  };
  await visit(target);

  return {
    files,
    bytes,
    modifiedAt: files > 0 ? new Date(newestMtime).toISOString() : undefined,
  };
}

const summarizeParquetTable = async (parquetDir, table) => {
  const flat = await summarizeParquetTarget(path.join(parquetDir, `${table}.parquet`));
  const partitioned = await summarizeParquetTarget(path.join(parquetDir, table));
  const modifiedAt = [flat.modifiedAt, partitioned.modifiedAt].filter(Boolean).sort().at(-1);
  return {
    table,
    file: path.join(parquetDir, `${table}.parquet`),
    directory: path.join(parquetDir, table),
    present: flat.files + partitioned.files > 0,
    files: flat.files + partitioned.files,
    bytes: flat.bytes + partitioned.bytes,
    modifiedAt,
  };
};

export const storageReport = async (dataDir) => {
  const freshnessKey = await parquetFreshnessKey(dataDir);
  const cacheKey = JSON.stringify({ dataDir, freshnessKey });
  if (storageCache.has(cacheKey)) return storageCache.get(cacheKey);
  const duckdbFile = path.join(dataDir, 'density.duckdb');
  const parquetDir = path.join(dataDir, 'parquet');
  const tableFiles = [
    'resources.parquet',
    'space_counts.parquet',
    'space_events.parquet',
    'space_occupancy.parquet',
    'space_metrics.parquet',
    'data_sources.parquet',
    'external_records.parquet',
  ];
  const tables = await Promise.all(tableFiles.map(async (file) => summarizeParquetTable(parquetDir, path.basename(file, '.parquet'))));
  const fastQuestionTables = await Promise.all([
    'spaces',
    'space_labels',
    'space_children',
    'space_metrics',
  ].map(async (table) => summarizeParquetTable(parquetDir, table)));
  const parquetBytes = tables.reduce((sum, table) => sum + table.bytes, 0);
  const fastQuestionBytes = fastQuestionTables.reduce((sum, table) => sum + table.bytes, 0);
  const duckdbBytes = await fileSize(duckdbFile);
  const parquetReady = tables.every((table) => table.present);
  const fastQuestionsReady = fastQuestionTables.every((table) => table.present);
  const report = {
    dataDir,
    duckdbFile,
    parquetDir,
    duckdbBytes,
    parquetBytes,
    tables,
    expectedTables: tables.map((table) => table.table),
    parquetReady,
    fastQuestionTables,
    expectedFastQuestionTables: fastQuestionTables.map((table) => table.table),
    fastQuestionBytes,
    fastQuestionsReady,
    ratio: parquetBytes > 0 ? Number((duckdbBytes / parquetBytes).toFixed(2)) : undefined,
    parquetFirst: parquetReady,
  };
  storageCache.set(cacheKey, report);
  return report;
};

const sq = (value) => String(value).replace(/'/g, "''");

const parquetRelation = async (parquetDir, table) => {
  const flat = path.join(parquetDir, `${table}.parquet`);
  if (await fileExists(flat)) return `read_parquet('${sq(flat)}')`;
  const directory = path.join(parquetDir, table);
  if (await fileExists(directory)) return `read_parquet('${sq(path.join(directory, '**', '*.parquet'))}', hive_partitioning = true)`;
  return undefined;
};

const csvFields = (stdout) => String(stdout ?? '').trim().split(',').map((field) => field.trim());

const duckdbCsv = async (duckdb, sql) => {
  const result = await run(duckdb, ['-csv', '-noheader', '-c', sql], {
    allowFailure: true,
    timeoutMs: 10000,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      error: result.timedOut ? 'DuckDB profile query timed out.' : (result.stderr || result.stdout || 'DuckDB profile query failed.'),
    };
  }
  return { ok: true, fields: csvFields(result.stdout) };
};

const numberField = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const profileCount = async (duckdb, relation, table) => {
  const result = await duckdbCsv(duckdb, `SELECT COUNT(*) FROM ${relation};`);
  if (!result.ok) return { table, ok: false, error: result.error };
  return { table, ok: true, rows: numberField(result.fields[0]) ?? 0 };
};

const profileTimestampTable = async (duckdb, relation, table) => {
  const result = await duckdbCsv(duckdb, `
    SELECT
      COUNT(*) AS rows,
      CAST(MIN(timestamp) AS VARCHAR) AS first_timestamp,
      CAST(MAX(timestamp) AS VARCHAR) AS last_timestamp,
      COUNT(DISTINCT organization_id) AS organizations,
      COUNT(DISTINCT space_id) AS spaces
    FROM ${relation};
  `);
  if (!result.ok) return { table, ok: false, error: result.error };
  const [rows, firstTimestamp, lastTimestamp, organizations, spaces] = result.fields;
  return {
    table,
    ok: true,
    rows: numberField(rows) ?? 0,
    firstTimestamp: firstTimestamp || undefined,
    lastTimestamp: lastTimestamp || undefined,
    organizations: numberField(organizations),
    spaces: numberField(spaces),
  };
};

const profileSpaceMetrics = async (duckdb, relation) => {
  const result = await duckdbCsv(duckdb, `
    SELECT
      COUNT(*) AS rows,
      CAST(MIN(timestamp) AS VARCHAR) AS first_timestamp,
      CAST(MAX(timestamp) AS VARCHAR) AS last_timestamp,
      COUNT(DISTINCT organization_id) AS organizations,
      COUNT(DISTINCT space_id) AS spaces,
      SUM(CASE WHEN occupancy_avg IS NULL THEN 1 ELSE 0 END) AS occupancy_avg_null_rows,
      SUM(CASE WHEN COALESCE(time_used_raw, 0) = 0 THEN 1 ELSE 0 END) AS time_used_zero_rows,
      SUM(CASE WHEN up_time IS NOT NULL AND up_time <= 0.8 THEN 1 ELSE 0 END) AS low_uptime_rows
    FROM ${relation};
  `);
  if (!result.ok) return { table: 'space_metrics', ok: false, error: result.error };
  const [
    rows,
    firstTimestamp,
    lastTimestamp,
    organizations,
    spaces,
    occupancyAvgNullRows,
    timeUsedZeroRows,
    lowUptimeRows,
  ] = result.fields;
  return {
    table: 'space_metrics',
    ok: true,
    rows: numberField(rows) ?? 0,
    firstTimestamp: firstTimestamp || undefined,
    lastTimestamp: lastTimestamp || undefined,
    organizations: numberField(organizations),
    spaces: numberField(spaces),
    nullRates: {
      occupancyAvg: numberField(rows) ? Number(((numberField(occupancyAvgNullRows) ?? 0) / numberField(rows)).toFixed(4)) : undefined,
    },
    zeroRates: {
      timeUsed: numberField(rows) ? Number(((numberField(timeUsedZeroRows) ?? 0) / numberField(rows)).toFixed(4)) : undefined,
    },
    lowUptimeRows: numberField(lowUptimeRows) ?? 0,
  };
};

export const localDataProfileReport = async (dataDir) => {
  const storage = await storageReport(dataDir);
  const duckdb = await which('duckdb');
  if (!duckdb) {
    return {
      checked: false,
      reason: 'DuckDB CLI not found; file-level storage readiness is still available.',
      storage,
    };
  }

  const tableProfiles = [];
  for (const table of storage.tables) {
    if (!table.present) continue;
    const relation = await parquetRelation(storage.parquetDir, table.table);
    if (!relation) continue;
    if (table.table === 'space_metrics') {
      tableProfiles.push(await profileSpaceMetrics(duckdb, relation));
    } else if (['space_occupancy', 'space_counts', 'space_events'].includes(table.table)) {
      tableProfiles.push(await profileTimestampTable(duckdb, relation, table.table));
    } else {
      tableProfiles.push(await profileCount(duckdb, relation, table.table));
    }
  }

  const timestamped = tableProfiles.filter((table) => table.ok && table.firstTimestamp && table.lastTimestamp);
  const firstTimestamp = timestamped.map((table) => table.firstTimestamp).sort()[0];
  const lastTimestamp = timestamped.map((table) => table.lastTimestamp).sort().at(-1);
  const failedProfiles = tableProfiles.filter((table) => !table.ok);
  return {
    checked: true,
    reason: timestamped.length > 0
      ? 'DuckDB profiled local Parquet timestamps and row counts.'
      : failedProfiles.length > 0
        ? 'DuckDB was available, but timestamp coverage could not be profiled from local Parquet.'
        : 'DuckDB found no timestamped local Parquet tables to profile.',
    storage,
    duckdb,
    tables: tableProfiles,
    coverage: {
      firstTimestamp,
      lastTimestamp,
      timestampTables: timestamped.map((table) => table.table),
    },
  };
};

export const checkPluginUpdate = async () => {
  const current = await pluginVersion();
  if (!current) {
    return { checked: false, available: false, reason: 'Could not read installed Density plugin version.' };
  }
  try {
    const response = await fetch(latestPluginManifestUrl());
    if (!response.ok) {
      return { checked: false, available: false, current, reason: `Could not fetch latest version (${response.status}).` };
    }
    const latestManifest = await response.json();
    const latest = typeof latestManifest.version === 'string' ? latestManifest.version : undefined;
    if (!latest) {
      return { checked: false, available: false, current, reason: 'Latest manifest did not include a version.' };
    }
    const available = compareVersions(current, latest) < 0;
    return {
      checked: true,
      available,
      current,
      latest,
      command: 'codex plugin marketplace upgrade densityai && codex plugin add density@densityai',
      prompt: available ? 'A newer version of the Density plugin is available. Would you like to install the latest?' : undefined,
    };
  } catch (error) {
    return { checked: false, available: false, current, reason: `Could not check for updates: ${error.message}` };
  }
};

export const pluginVersion = async () => {
  const manifestPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.codex-plugin', 'plugin.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
};

const compareVersions = (left, right) => {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
    const diff = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const versionParts = (version) => version
  .split('+', 1)[0]
  .split('-', 1)[0]
  .split('.')
  .map((part) => Number.parseInt(part, 10))
  .map((part) => Number.isFinite(part) ? part : 0);
