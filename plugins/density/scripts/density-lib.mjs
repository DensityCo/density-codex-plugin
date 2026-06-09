import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const defaultDataDir = () => path.join(os.homedir(), '.density-cli');
const latestPluginManifestUrl = () => process.env.DENSITY_PLUGIN_LATEST_MANIFEST_URL
  ?? 'https://raw.githubusercontent.com/DensityCo/density-codex-plugin/main/plugins/density/.codex-plugin/plugin.json';

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

export const discoverCliCapabilities = async (cli, options = {}) => {
  if (!cli) {
    return { checked: false, chartQuestions: false, reason: 'Density CLI not found.' };
  }
  const result = await runDensity(cli, ['capabilities', '--format', 'json'], {
    allowFailure: true,
    timeoutMs: options.timeoutMs ?? 5000,
    dataDir: options.dataDir,
  });
  if (result.code !== 0) {
    return {
      checked: false,
      chartQuestions: false,
      reason: result.timedOut ? 'Capability check timed out.' : (result.stderr || result.stdout || 'Capability check failed.'),
    };
  }
  try {
    const payload = JSON.parse(result.stdout);
    return {
      checked: true,
      version: typeof payload.version === 'string' ? payload.version : undefined,
      chartQuestions: Boolean(payload.chartQuestions || payload.commands?.askChart),
      chartContract: payload.chartContract,
      htmlReports: Array.isArray(payload.htmlReports) ? payload.htmlReports : [],
      commands: payload.commands ?? {},
    };
  } catch (error) {
    return {
      checked: false,
      chartQuestions: false,
      reason: `Capability JSON was not parseable: ${error.message}`,
    };
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

export const storageReport = async (dataDir) => {
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
  const tables = await Promise.all(tableFiles.map(async (file) => {
    const tablePath = path.join(parquetDir, file);
    const bytes = await fileSize(tablePath);
    let modifiedAt;
    try {
      modifiedAt = (await stat(tablePath)).mtime.toISOString();
    } catch {
      modifiedAt = undefined;
    }
    return {
      table: path.basename(file, '.parquet'),
      file: tablePath,
      present: bytes > 0,
      bytes,
      modifiedAt,
    };
  }));
  const parquetBytes = tables.reduce((sum, table) => sum + table.bytes, 0);
  const duckdbBytes = await fileSize(duckdbFile);
  const parquetReady = tables.every((table) => table.present);
  return {
    dataDir,
    duckdbFile,
    parquetDir,
    duckdbBytes,
    parquetBytes,
    tables,
    expectedTables: tables.map((table) => table.table),
    parquetReady,
    ratio: parquetBytes > 0 ? Number((duckdbBytes / parquetBytes).toFixed(2)) : undefined,
    parquetFirst: parquetReady,
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
