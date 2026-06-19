#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileExists, run, storageReport, which } from './density-lib.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const daysArg = args.find((arg) => arg.startsWith('--days='));
const sourceArg = args.find((arg) => arg.startsWith('--source='));
const outArg = args.find((arg) => arg.startsWith('--out='));
const days = daysArg ? Number(daysArg.slice('--days='.length)) : 14;
const sourceDir = sourceArg ? sourceArg.slice('--source='.length) : path.join(os.homedir(), '.density-cli-linkedin');
const outDir = outArg ? outArg.slice('--out='.length) : path.join(os.homedir(), '.density-cli-demo-customer');
const sourceParquet = path.join(sourceDir, 'parquet');
const outParquet = path.join(outDir, 'parquet');
const dbFile = path.join(outDir, 'density.duckdb');
const stateFile = path.join(sourceDir, 'state.json');

if (!Number.isInteger(days) || days <= 0 || days > 60) {
  throw new Error('--days must be an integer between 1 and 60.');
}
if (!await fileExists(path.join(sourceParquet, 'resources.parquet'))) {
  throw new Error(`Source Parquet data not found at ${sourceParquet}.`);
}
const duckdb = await which('duckdb');
if (!duckdb) {
  throw new Error('duckdb CLI not found. Install DuckDB or add it to PATH.');
}

const sq = (value) => value.replace(/'/g, "''");
const parquet = (name) => path.join(outParquet, `${name}.parquet`);
const source = (name) => path.join(sourceParquet, `${name}.parquet`);
const sourceTableDir = (name) => path.join(sourceParquet, name);
const sourceRead = async (name) => {
  if (await fileExists(source(name))) return source(name);
  if (await fileExists(sourceTableDir(name))) return path.join(sourceTableDir(name), '**', '*.parquet');
  throw new Error(`Source Parquet table '${name}' not found at ${sourceParquet}.`);
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outParquet, { recursive: true });

if (await fileExists(stateFile)) {
  await run('cp', [stateFile, path.join(outDir, 'state.json')]);
}

const copySql = `
COPY (SELECT * FROM read_parquet('${sq(await sourceRead('resources'))}'))
TO '${sq(parquet('resources'))}' (FORMAT PARQUET);

COPY (SELECT * FROM read_parquet('${sq(await sourceRead('spaces'))}'))
TO '${sq(parquet('spaces'))}' (FORMAT PARQUET);

COPY (SELECT * FROM read_parquet('${sq(await sourceRead('space_labels'))}'))
TO '${sq(parquet('space_labels'))}' (FORMAT PARQUET);

COPY (SELECT * FROM read_parquet('${sq(await sourceRead('space_children'))}'))
TO '${sq(parquet('space_children'))}' (FORMAT PARQUET);

COPY (SELECT * FROM read_parquet('${sq(await sourceRead('data_sources'))}'))
TO '${sq(parquet('data_sources'))}' (FORMAT PARQUET);

COPY (SELECT * FROM read_parquet('${sq(await sourceRead('external_records'))}'))
TO '${sq(parquet('external_records'))}' (FORMAT PARQUET);

COPY (
  WITH bounds AS (SELECT MAX(timestamp) AS max_ts FROM read_parquet('${sq(await sourceRead('space_metrics'))}'))
  SELECT m.*
  FROM read_parquet('${sq(await sourceRead('space_metrics'))}') m, bounds
  WHERE m.timestamp >= bounds.max_ts - INTERVAL ${days} DAY
)
TO '${sq(parquet('space_metrics'))}' (FORMAT PARQUET);

COPY (
  WITH bounds AS (SELECT MAX(timestamp) AS max_ts FROM read_parquet('${sq(await sourceRead('space_occupancy'))}'))
  SELECT o.*
  FROM read_parquet('${sq(await sourceRead('space_occupancy'))}') o, bounds
  WHERE o.timestamp >= bounds.max_ts - INTERVAL ${days} DAY
)
TO '${sq(parquet('space_occupancy'))}' (FORMAT PARQUET);

COPY (SELECT * FROM read_parquet('${sq(await sourceRead('space_counts'))}'))
TO '${sq(parquet('space_counts'))}' (FORMAT PARQUET);

COPY (SELECT * FROM read_parquet('${sq(await sourceRead('space_events'))}'))
TO '${sq(parquet('space_events'))}' (FORMAT PARQUET);
`;

await run(duckdb, ['-c', copySql]);

const viewSql = `
CREATE OR REPLACE VIEW resources AS SELECT * FROM read_parquet('${sq(parquet('resources'))}');
CREATE OR REPLACE VIEW spaces AS SELECT * FROM read_parquet('${sq(parquet('spaces'))}');
CREATE OR REPLACE VIEW space_labels AS SELECT * FROM read_parquet('${sq(parquet('space_labels'))}');
CREATE OR REPLACE VIEW space_children AS SELECT * FROM read_parquet('${sq(parquet('space_children'))}');
CREATE OR REPLACE VIEW space_counts AS SELECT * FROM read_parquet('${sq(parquet('space_counts'))}');
CREATE OR REPLACE VIEW space_events AS SELECT * FROM read_parquet('${sq(parquet('space_events'))}');
CREATE OR REPLACE VIEW space_occupancy AS SELECT * FROM read_parquet('${sq(parquet('space_occupancy'))}');
CREATE OR REPLACE VIEW space_metrics AS SELECT * FROM read_parquet('${sq(parquet('space_metrics'))}');
CREATE OR REPLACE VIEW data_sources AS SELECT * FROM read_parquet('${sq(parquet('data_sources'))}');
CREATE OR REPLACE VIEW external_records AS SELECT * FROM read_parquet('${sq(parquet('external_records'))}');
`;
await run(duckdb, [dbFile, '-c', viewSql]);

await writeFile(path.join(outDir, 'README.txt'), `Density demo customer data dir.

Source: ${sourceDir}
Window: last ${days} day(s) of metrics and occupancy based on source max timestamp.
Storage: canonical Parquet with a tiny DuckDB query catalog of views over Parquet.

Use:
Set DENSITY_CLI_DATA_DIR=${outDir}, ask Codex to set up Density, then ask a chart question.
If chart questions are unsupported by the installed CLI, use density viz --html instead.
`);

const storage = await storageReport(outDir);
const payload = {
  ok: true,
  sourceDir,
  dataDir: outDir,
  days,
  storage,
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`Created demo customer data dir: ${outDir}`);
  console.log(`Window: last ${days} day(s) of metrics and occupancy`);
  console.log(`Storage: DuckDB ${storage.duckdbBytes} bytes, Parquet ${storage.parquetBytes} bytes${storage.ratio ? ` (${storage.ratio}x)` : ''}`);
}
