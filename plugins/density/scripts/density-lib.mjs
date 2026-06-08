import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const defaultDataDir = () => path.join(os.homedir(), '.density-cli');

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

export const run = async (command, args = [], options = {}) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell ?? false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => {
    child.on('close', resolve);
  });
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`);
  }
  return { code, stdout, stderr };
};

const knownCliRepos = () => [
  process.env.DENSITY_CLI_REPO,
  path.join(os.homedir(), 'dev', 'density-cli'),
].filter(Boolean);

export const resolveDensityCli = async () => {
  if (process.env.DENSITY_CLI_COMMAND) {
    return { command: process.env.DENSITY_CLI_COMMAND, args: [], source: 'DENSITY_CLI_COMMAND' };
  }
  if (process.env.DENSITY_CLI_BIN && await fileExists(process.env.DENSITY_CLI_BIN)) {
    return { command: process.execPath, args: [process.env.DENSITY_CLI_BIN], source: 'DENSITY_CLI_BIN' };
  }
  const pathDensity = await which('density');
  if (pathDensity) {
    return { command: pathDensity, args: [], source: 'PATH' };
  }
  for (const repo of knownCliRepos()) {
    const bin = path.join(repo, 'bin', 'density.mjs');
    if (await fileExists(bin)) {
      return { command: process.execPath, args: [bin], source: repo, repo };
    }
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
  return run(cli.command, [...cli.args, ...args], { env, cwd: options.cwd, allowFailure: options.allowFailure });
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
  await run(converter, ['-w', '1400', svgFile, '-o', pngFile]);
  return pngFile;
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
  const parquetBytes = (await Promise.all(tableFiles.map((file) => fileSize(path.join(parquetDir, file)))))
    .reduce((sum, n) => sum + n, 0);
  const duckdbBytes = await fileSize(duckdbFile);
  return {
    dataDir,
    duckdbFile,
    parquetDir,
    duckdbBytes,
    parquetBytes,
    ratio: parquetBytes > 0 ? Number((duckdbBytes / parquetBytes).toFixed(2)) : undefined,
    parquetFirst: parquetBytes > 0,
  };
};
