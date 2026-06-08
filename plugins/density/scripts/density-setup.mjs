#!/usr/bin/env node
import { defaultDataDir, ensureDensityCliBuilt, resolveDensityCli, runDensity, storageReport, which } from './density-lib.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dataDirArg = args.find((arg) => arg.startsWith('--data-dir='));
const dataDir = dataDirArg ? dataDirArg.slice('--data-dir='.length) : (process.env.DENSITY_CLI_DATA_DIR ?? defaultDataDir());

const result = {
  ok: false,
  dataDir,
  checks: [],
  nextSteps: [],
};

const addCheck = (name, ok, detail) => {
  result.checks.push({ name, ok, detail });
};

const cli = await resolveDensityCli();
addCheck('density cli found', Boolean(cli), cli?.source ?? 'Set DENSITY_CLI_BIN or install density on PATH.');

if (cli) {
  const build = await ensureDensityCliBuilt(cli);
  addCheck('density cli built', true, build.reason);
  const status = await runDensity(cli, ['status'], { dataDir, allowFailure: true });
  addCheck('density status runs', status.code === 0, status.code === 0 ? 'status completed' : (status.stderr || status.stdout).trim());
  if (status.code !== 0 && /Token|auth|Authorization|login/i.test(status.stderr || status.stdout)) {
    result.nextSteps.push('Run Density browser auth: density auth login');
  }
}

addCheck('svg to png renderer found', Boolean(await which('rsvg-convert')), 'Used for inline Codex chart previews.');
addCheck('duckdb cli found', Boolean(await which('duckdb')), 'Used for demo customer Parquet slicing.');

const storage = await storageReport(dataDir);
result.storage = storage;
if (storage.parquetBytes > 0) {
  addCheck('canonical parquet present', true, `${storage.parquetBytes} bytes`);
  if (storage.duckdbBytes > storage.parquetBytes * 4) {
    addCheck('duckdb is working cache', true, `DuckDB is ${storage.ratio}x Parquet; keep Parquet as durable source.`);
  }
} else {
  addCheck('canonical parquet present', false, 'No Parquet mirror yet. Sync or create a demo customer dataset.');
  result.nextSteps.push('Sync customer data or run scripts/density-demo-customer.mjs from an existing local data dir.');
}

result.ok = result.checks.every((check) => check.ok || check.name === 'duckdb cli found');

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.ok ? 'Density setup is ready.' : 'Density setup needs attention.');
  for (const check of result.checks) {
    console.log(`${check.ok ? 'OK' : 'NEEDS'} ${check.name}: ${check.detail}`);
  }
  if (result.storage) {
    console.log(`Storage: DuckDB ${result.storage.duckdbBytes} bytes, Parquet ${result.storage.parquetBytes} bytes${result.storage.ratio ? ` (${result.storage.ratio}x)` : ''}`);
  }
  if (result.nextSteps.length > 0) {
    console.log('Next steps:');
    for (const step of result.nextSteps) console.log(`- ${step}`);
  }
}
