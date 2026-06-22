import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const defaultDataDir = () => path.join(os.homedir(), '.density-cli');
export const defaultManagedCliRuntimeRoot = () => process.env.DENSITY_PLUGIN_RUNTIME_DIR
  ?? path.join(defaultDataDir(), 'plugin-runtime');
const latestPluginManifestUrl = () => process.env.DENSITY_PLUGIN_LATEST_MANIFEST_URL
  ?? 'https://raw.githubusercontent.com/DensityCo/density-codex-plugin/main/plugins/density/.codex-plugin/plugin.json';
const capabilityCache = new Map();
const storageCache = new Map();
const scriptDir = () => path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = () => path.resolve(scriptDir(), '..');
const pluginManifestPath = () => path.join(pluginRoot(), '.codex-plugin', 'plugin.json');
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
].filter(Boolean);

export const managedCliPlatform = () => `${process.platform}-${os.arch()}`;

const looksLikeJson = (value) => String(value ?? '').trim().startsWith('{');

const localFilePath = (value) => String(value ?? '').startsWith('file://')
  ? fileURLToPath(value)
  : value;

const commandForCliBin = (bin) => /\.(?:cjs|js|mjs)$/i.test(bin)
  ? { command: process.execPath, args: [bin] }
  : { command: bin, args: [] };

const normalizeManagedCliManifest = (manifest, source) => {
  if (!manifest || typeof manifest !== 'object') return undefined;
  if (manifest.managedCli && typeof manifest.managedCli === 'object') {
    return normalizeManagedCliManifest(manifest.managedCli, source);
  }
  if (manifest.enabled === false) return undefined;
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) return undefined;
  return {
    version: manifest.version,
    requiredCapabilities: manifest.requiredCapabilities ?? {},
    assets: manifest.assets ?? {},
    source,
  };
};

export const loadManagedCliManifest = async (options = {}) => {
  if (options.manifest && typeof options.manifest === 'object') {
    return normalizeManagedCliManifest(options.manifest, 'argument');
  }

  const override = options.manifestPath
    ?? process.env.DENSITY_MANAGED_CLI_MANIFEST_PATH
    ?? process.env.DENSITY_MANAGED_CLI_MANIFEST;
  if (override) {
    const manifest = looksLikeJson(override)
      ? JSON.parse(override)
      : JSON.parse(await readFile(localFilePath(override), 'utf8'));
    return normalizeManagedCliManifest(manifest, override);
  }

  try {
    const pluginManifest = JSON.parse(await readFile(pluginManifestPath(), 'utf8'));
    const managedCli = pluginManifest.managedCli;
    if (!managedCli || Object.keys(managedCli.assets ?? {}).length === 0) return undefined;
    return normalizeManagedCliManifest(managedCli, pluginManifestPath());
  } catch {
    return undefined;
  }
};

export const managedCliInstallDir = (manifest, options = {}) => path.join(
  options.runtimeRoot ?? defaultManagedCliRuntimeRoot(),
  manifest.version,
  options.platform ?? managedCliPlatform()
);

export const managedCliBinPath = (manifest, options = {}) => path.join(
  managedCliInstallDir(manifest, options),
  'bin',
  'density'
);

export const managedCliRuntimeStatus = async (manifest, options = {}) => {
  if (!manifest) {
    return { checked: false, installed: false, reason: 'Managed CLI manifest not configured.' };
  }
  const platform = options.platform ?? managedCliPlatform();
  const runtimeDir = managedCliInstallDir(manifest, { ...options, platform });
  const bin = path.join(runtimeDir, 'bin', 'density');
  const installed = await executable(bin);
  return {
    checked: true,
    installed,
    version: manifest.version,
    platform,
    runtimeDir,
    path: bin,
    manifestSource: manifest.source,
    reason: installed ? 'managed runtime installed' : 'managed runtime not installed',
  };
};

export const missingRequiredCliCapabilities = (capabilities = {}, required = {}) => {
  const missing = [];
  if (!capabilities.checked) {
    missing.push('capabilities');
    return missing;
  }

  if (required.chartQuestions === true && !capabilities.chartQuestions) {
    missing.push('chartQuestions');
  }
  if (required.availableBuildings === true && !capabilities.availableBuildings) {
    missing.push('availableBuildings');
  }
  for (const command of required.commands ?? []) {
    if (!capabilities.commands?.[command]) missing.push(`commands.${command}`);
  }
  if (required.questionAnswering?.localFirst === true && !capabilities.questionAnswering?.localFirst) {
    missing.push('questionAnswering.localFirst');
  }
  return missing;
};

export const resolveDensityCli = async () => {
  if (process.env.DENSITY_CLI_COMMAND) {
    return { command: process.env.DENSITY_CLI_COMMAND, args: [], source: 'DENSITY_CLI_COMMAND', path: process.env.DENSITY_CLI_COMMAND, explicit: true };
  }
  if (process.env.DENSITY_CLI_BIN && await fileExists(process.env.DENSITY_CLI_BIN)) {
    return { ...commandForCliBin(process.env.DENSITY_CLI_BIN), source: 'DENSITY_CLI_BIN', path: process.env.DENSITY_CLI_BIN, explicit: true };
  }
  const managedManifest = await loadManagedCliManifest();
  const managed = await managedCliRuntimeStatus(managedManifest);
  if (managed.installed) {
    return {
      command: managed.path,
      args: [],
      source: 'plugin-managed',
      path: managed.path,
      managed: true,
      version: managed.version,
      platform: managed.platform,
      runtimeDir: managed.runtimeDir,
    };
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
  if (process.env.DENSITY_CLI_BUILD_FROM_SOURCE !== '1') {
    return { built: false, skipped: true, reason: 'source build skipped; set DENSITY_CLI_BUILD_FROM_SOURCE=1 for dev repo builds' };
  }
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
      managed: Boolean(cli.managed),
      version: cli.version,
      platform: cli.platform,
      runtimeDir: cli.runtimeDir,
    }
  : undefined;

const sha256File = async (file) => await new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});

const assetSource = (asset = {}) => asset.url ?? asset.file ?? asset.path;
const tarCommand = () => process.env.DENSITY_TAR_COMMAND
  ?? (process.platform === 'win32' ? 'tar' : '/usr/bin/tar');

const fetchOrCopyAsset = async (asset, outFile) => {
  const source = assetSource(asset);
  if (!source) throw new Error('Managed CLI asset is missing url, file, or path.');
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Managed CLI download failed (${response.status}).`);
    if (!response.body) throw new Error('Managed CLI download returned an empty response body.');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(outFile));
    return { source, mode: 'download' };
  }
  await cp(localFilePath(source), outFile);
  return { source, mode: 'copy' };
};

const validateTarMembers = async (archiveFile) => {
  const listed = await run(tarCommand(), ['-tf', archiveFile], { allowFailure: true });
  if (listed.code !== 0) throw new Error(listed.stderr || listed.stdout || 'Managed CLI archive could not be listed.');
  for (const entry of listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const parts = entry.split('/').filter(Boolean);
    if (path.isAbsolute(entry) || parts.includes('..')) {
      throw new Error(`Managed CLI archive contains unsafe path: ${entry}`);
    }
  }
};

const assertSafeSymlinks = async (dir, root = dir) => {
  for (const entry of await readdir(dir)) {
    const entryPath = path.join(dir, entry);
    const details = await lstat(entryPath);
    if (details.isSymbolicLink()) {
      const target = await readlink(entryPath);
      const resolvedTarget = path.resolve(path.dirname(entryPath), target);
      const relativeTarget = path.relative(root, resolvedTarget);
      if (path.isAbsolute(target) || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
        throw new Error(`Managed CLI archive contains unsafe symlink: ${path.relative(root, entryPath)} -> ${target}`);
      }
      continue;
    }
    if (details.isDirectory()) await assertSafeSymlinks(entryPath, root);
  }
};

const replaceDirectoryAtomically = async (fromDir, toDir) => {
  await mkdir(path.dirname(toDir), { recursive: true });
  const backup = `${toDir}.previous-${process.pid}-${Date.now()}`;
  const hadExisting = await fileExists(toDir);
  if (hadExisting) await rename(toDir, backup);
  try {
    await rename(fromDir, toDir);
    if (hadExisting) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    const targetMissing = !await fileExists(toDir);
    const backupExists = await fileExists(backup);
    if (hadExisting && targetMissing && backupExists) {
      await rename(backup, toDir);
    }
    throw error;
  }
};

export const installManagedCliRuntime = async (options = {}) => {
  const manifest = await loadManagedCliManifest(options);
  if (!manifest) throw new Error('Managed CLI manifest is not configured.');
  const platform = options.platform ?? managedCliPlatform();
  const asset = manifest.assets?.[platform];
  if (!asset) throw new Error(`No managed CLI asset for ${platform} in manifest version ${manifest.version}.`);
  if (!asset.sha256) throw new Error(`Managed CLI asset for ${platform} is missing sha256.`);

  const runtimeRoot = options.runtimeRoot ?? defaultManagedCliRuntimeRoot();
  await mkdir(runtimeRoot, { recursive: true });
  const tempRoot = await mkdtemp(path.join(runtimeRoot, '.install-'));
  const archiveFile = path.join(tempRoot, 'density-cli-runtime.tgz');
  const extractDir = path.join(tempRoot, 'runtime');

  try {
    const fetched = await fetchOrCopyAsset(asset, archiveFile);
    const actualSha256 = await sha256File(archiveFile);
    if (actualSha256.toLowerCase() !== String(asset.sha256).toLowerCase()) {
      throw new Error(`Managed CLI checksum mismatch: expected ${asset.sha256}, got ${actualSha256}.`);
    }

    await mkdir(extractDir, { recursive: true });
    await validateTarMembers(archiveFile);
    await run(tarCommand(), ['-xf', archiveFile, '-C', extractDir]);
    await assertSafeSymlinks(extractDir);

    const extractedBin = path.join(extractDir, 'bin', 'density');
    if (!await fileExists(extractedBin)) {
      throw new Error('Managed CLI archive must contain bin/density.');
    }
    await chmod(extractedBin, 0o755);

    const cli = { command: extractedBin, args: [], source: 'plugin-managed-install', path: extractedBin };
    const capabilities = await discoverCliCapabilities(cli, { dataDir: options.dataDir, timeoutMs: options.timeoutMs ?? 5000 });
    const missing = missingRequiredCliCapabilities(capabilities, manifest.requiredCapabilities);
    if (missing.length > 0) {
      throw new Error(`Managed CLI is missing required capabilities: ${missing.join(', ')}.`);
    }

    const runtimeDir = managedCliInstallDir(manifest, { runtimeRoot, platform });
    await replaceDirectoryAtomically(extractDir, runtimeDir);
    const installedPath = path.join(runtimeDir, 'bin', 'density');
    return {
      ok: true,
      path: installedPath,
      source: fetched.source,
      sourceMode: fetched.mode,
      version: manifest.version,
      platform,
      runtimeDir,
      sha256: actualSha256,
      capabilities,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

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
