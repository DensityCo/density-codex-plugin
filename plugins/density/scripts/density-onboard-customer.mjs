#!/usr/bin/env node
import { defaultDataDir, ensureDensityCliBuilt, resolveDensityCli, runDensity, storageReport } from './density-lib.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dataDirFlag = args.find((arg) => arg.startsWith('--data-dir='));
const orgFlag = args.find((arg) => arg.startsWith('--org='));
const daysFlag = args.find((arg) => arg.startsWith('--days='));
const dataDir = dataDirFlag ? dataDirFlag.slice('--data-dir='.length) : (process.env.DENSITY_CLI_DATA_DIR ?? defaultDataDir());
const orgId = orgFlag?.slice('--org='.length);
const days = daysFlag ? Number(daysFlag.slice('--days='.length)) : 14;

if (!Number.isInteger(days) || days <= 0 || days > 60) {
  throw new Error('--days must be an integer between 1 and 60.');
}

const cli = await resolveDensityCli();
if (!cli) {
  throw new Error('Density CLI not found. Set DENSITY_CLI_BIN, DENSITY_CLI_REPO, or install density on PATH.');
}
await ensureDensityCliBuilt(cli);

const steps = [];
const runStep = async (name, commandArgs) => {
  const startedAt = Date.now();
  const result = await runDensity(cli, commandArgs, { dataDir, allowFailure: true });
  const step = {
    name,
    ok: result.code === 0,
    seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
  steps.push(step);
  if (!step.ok) {
    throw new Error(`${name} failed: ${step.stderr || step.stdout}`);
  }
};

if (orgId) {
  await runStep('select organization', ['org', 'use', orgId]);
}
await runStep('sync spaces', ['sync', '--stream', 'spaces']);
await runStep('sync meeting-room metrics', ['sync', '--stream', 'metrics', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', '15m']);
await runStep('sync occupancy overview', ['sync', '--stream', 'occupancy', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', '1h']);

const storage = await storageReport(dataDir);
const payload = {
  ok: true,
  dataDir,
  days,
  steps,
  storage,
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`Prepared Density customer data: ${dataDir}`);
  for (const step of steps) console.log(`OK ${step.name} (${step.seconds}s)`);
  console.log(`Storage: DuckDB ${storage.duckdbBytes} bytes, Parquet ${storage.parquetBytes} bytes${storage.ratio ? ` (${storage.ratio}x)` : ''}`);
}
