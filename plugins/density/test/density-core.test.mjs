import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  askChart,
  authLogin,
  boundedGenericDays,
  onboardCustomer,
  setup,
  DEFAULT_METRICS_DAYS,
} from '../scripts/density-core.mjs';
import { resolveDensityCli, storageReport } from '../scripts/density-lib.mjs';

const TABLES = [
  'resources',
  'space_counts',
  'space_events',
  'space_occupancy',
  'space_metrics',
  'data_sources',
  'external_records',
];

const withTempEnv = async (fn) => {
  const prior = {
    DENSITY_CLI_BIN: process.env.DENSITY_CLI_BIN,
    DENSITY_CLI_COMMAND: process.env.DENSITY_CLI_COMMAND,
    DENSITY_CLI_REPO: process.env.DENSITY_CLI_REPO,
    DENSITY_CLI_DATA_DIR: process.env.DENSITY_CLI_DATA_DIR,
    FAKE_CLI_LOG: process.env.FAKE_CLI_LOG,
    FAKE_CHART_SUPPORT: process.env.FAKE_CHART_SUPPORT,
    FAKE_AUTH_OK: process.env.FAKE_AUTH_OK,
    FAKE_DELAY_METRICS: process.env.FAKE_DELAY_METRICS,
    DENSITY_PLUGIN_LATEST_MANIFEST_URL: process.env.DENSITY_PLUGIN_LATEST_MANIFEST_URL,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'density-plugin-test-'));
  process.env.DENSITY_PLUGIN_LATEST_MANIFEST_URL = 'data:application/json,{"version":"0.1.1"}';
  try {
    await fn(tempDir);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  }
};

const writeFakeCli = async (file) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) {
  await appendFile(process.env.FAKE_CLI_LOG, JSON.stringify(args) + '\\n');
}
const out = (value) => console.log(JSON.stringify(value));
if (args[0] === 'capabilities') {
  out({
    version: 'fake-1.0.0',
    chartQuestions: process.env.FAKE_CHART_SUPPORT === '1',
    chartContract: process.env.FAKE_CHART_SUPPORT === '1' ? 'ask-chart-json-v1' : undefined,
    commands: { askChart: process.env.FAKE_CHART_SUPPORT === '1', vizHtml: true },
    htmlReports: ['building-overview', 'meeting-rooms']
  });
} else if (args[0] === 'status') {
  if (process.env.FAKE_AUTH_OK === '0') {
    console.error('Token missing jwt=eyJsecret.payload.signature token=super-secret-token');
    process.exitCode = 1;
  } else {
    console.log('status ok');
  }
} else if (args[0] === 'auth' && args[1] === 'login') {
  console.log('Saved Atlas session jwt=eyJsecret.payload.signature token=super-secret-token');
} else if (args[0] === 'sync') {
  if (args.includes('metrics') && process.env.FAKE_DELAY_METRICS === '1') {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log('synced ' + args.join(' '));
} else if (args[0] === 'export' && args[1] === 'parquet') {
  const outIndex = args.indexOf('--out');
  const outDir = args[outIndex + 1];
  await mkdir(outDir, { recursive: true });
  for (const table of ${JSON.stringify(TABLES)}) {
    await writeFile(path.join(outDir, table + '.parquet'), 'rows');
  }
  console.log('exported parquet');
} else if (args[0] === 'ask') {
  if (process.env.FAKE_CHART_SUPPORT !== '1') {
    console.error('ask unsupported token=super-secret-token');
    process.exitCode = 1;
  } else {
    out({ title: 'Busiest rooms', subtitle: 'Local fake data', chart: '/tmp/chart.svg', html: '/tmp/chart.html' });
  }
} else {
  console.error('unknown ' + args.join(' '));
  process.exitCode = 1;
}
`);
  await chmod(file, 0o755);
};

const readFakeLog = async (file) => {
  try {
    return (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const writeParquetTables = async (dataDir, tables = TABLES) => {
  const parquetDir = path.join(dataDir, 'parquet');
  await mkdir(parquetDir, { recursive: true });
  for (const table of tables) {
    await writeFile(path.join(parquetDir, `${table}.parquet`), 'rows');
  }
};

test('setup reports unsupported chart capability without claiming chart readiness', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_AUTH_OK = '1';
    process.env.FAKE_CHART_SUPPORT = '0';

    const result = await setup({ dataDir });

    assert.equal(result.capabilities.checked, true);
    assert.equal(result.capabilities.chartQuestions, false);
    assert.equal(result.nextAction.id, 'chart_unsupported');
    assert.ok(result.checks.some((check) => check.name === 'density chart capability known'));
    assert.equal(result.nextSteps.length, 1);
  });
});

test('setup reports one configure action when no CLI is discoverable', async () => {
  await withTempEnv(async (tempDir) => {
    process.env.HOME = tempDir;
    process.env.PATH = tempDir;

    const result = await setup({ dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.nextAction.id, 'configure_cli');
    assert.equal(result.userVisiblePrimaryActions, 1);
    assert.equal(result.nextSteps.length, 1);
  });
});

test('askChart returns precise unsupported capability response', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '0';

    const result = await askChart({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
    assert.match(result.message, /does not support chart questions/);
    assert.equal(result.nextAction.id, 'update_cli_for_chart_questions');
  });
});

test('askChart consumes supported JSON chart contract', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';

    const result = await askChart({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, true);
    assert.equal(result.title, 'Busiest rooms');
    assert.equal(result.subtitle, 'Local fake data');
    assert.equal(result.chart, '/tmp/chart.svg');
    assert.equal(result.html, '/tmp/chart.html');
  });
});

test('default onboarding is staged and does not start all-spaces metrics sync', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await onboardCustomer({ dataDir: path.join(tempDir, 'data') });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'staged');
    assert.equal(result.days, DEFAULT_METRICS_DAYS);
    assert.equal(result.nextAction.id, 'run_full_sync');
    assert.ok(calls.some((args) => args[0] === 'sync' && args.includes('spaces')));
    assert.equal(calls.some((args) => args[0] === 'sync' && args.includes('metrics')), false);
  });
});

test('onboarding rejects invalid 15-minute metrics window before sync', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    await assert.rejects(
      onboardCustomer({ dataDir: path.join(tempDir, 'data'), days: 14 }),
      /between 1 and 7/
    );
    assert.deepEqual(await readFakeLog(logFile), []);
  });
});

test('generic demo customer windows remain bounded separately from metrics windows', () => {
  assert.equal(boundedGenericDays(undefined), 14);
  assert.equal(boundedGenericDays(60), 60);
  assert.throws(() => boundedGenericDays(61), /between 1 and 60/);
});

test('full sync timeout returns partial phase report and does not start later phases', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_DELAY_METRICS = '1';

    const result = await onboardCustomer({
      dataDir: path.join(tempDir, 'data'),
      fullSync: true,
      timeoutSeconds: 1,
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, false);
    assert.ok(result.steps.some((step) => step.name === 'sync meeting-room metrics' && step.timedOut));
    assert.equal(calls.some((args) => args[0] === 'sync' && args.includes('occupancy')), false);
    assert.equal(calls.some((args) => args[0] === 'export'), false);
  });
});

test('setup and auth output redact token-looking values', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_AUTH_OK = '0';

    const setupResult = await setup({ dataDir: path.join(tempDir, 'data') });
    const authResult = await authLogin({ dataDir: path.join(tempDir, 'data') });
    const text = JSON.stringify({ setupResult, authResult });

    assert.doesNotMatch(text, /super-secret-token/);
    assert.doesNotMatch(text, /eyJsecret/);
    assert.match(text, /REDACTED/);
  });
});

test('Parquet readiness requires all expected tables', async () => {
  await withTempEnv(async (tempDir) => {
    const dataDir = path.join(tempDir, 'data');
    await writeParquetTables(dataDir, ['resources']);

    const report = await storageReport(dataDir);

    assert.equal(report.parquetBytes > 0, true);
    assert.equal(report.parquetReady, false);
    assert.equal(report.tables.find((table) => table.table === 'resources').present, true);
    assert.equal(report.tables.find((table) => table.table === 'space_metrics').present, false);
  });
});

test('repo-local CLI is preferred over PATH and provenance is reported', async () => {
  await withTempEnv(async (tempDir) => {
    const repoCli = path.join(tempDir, 'repo', 'bin', 'density.mjs');
    const pathCli = path.join(tempDir, 'bin', 'density');
    await writeFakeCli(repoCli);
    await writeFakeCli(pathCli);
    process.env.DENSITY_CLI_REPO = path.join(tempDir, 'repo');
    process.env.PATH = `${path.dirname(pathCli)}${path.delimiter}${process.env.PATH ?? ''}`;

    const cli = await resolveDensityCli();

    assert.equal(cli.path, repoCli);
    assert.equal(cli.source, path.join(tempDir, 'repo'));
  });
});

test('setup exposes at most one primary next action', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_AUTH_OK = '1';
    process.env.FAKE_CHART_SUPPORT = '0';

    const blocked = await setup({ dataDir: path.join(tempDir, 'blocked') });
    assert.equal(blocked.userVisiblePrimaryActions, 1);
    assert.equal(blocked.nextSteps.length, 1);

    const readyDataDir = path.join(tempDir, 'ready');
    await writeParquetTables(readyDataDir);
    const ready = await setup({ dataDir: readyDataDir });
    assert.equal(ready.userVisiblePrimaryActions <= 1, true);
    assert.equal(ready.nextSteps.length <= 1, true);
  });
});
