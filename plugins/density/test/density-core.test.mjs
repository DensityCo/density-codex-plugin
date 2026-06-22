import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  askChart,
  authLogin,
  boundedGenericDays,
  metricsIntervalForDays,
  onboardCustomer,
  repairFastQuestions,
  starterQuestions,
  setup,
  DEFAULT_METRICS_DAYS,
} from '../scripts/density-core.mjs';
import { resolveDensityCli, storageReport } from '../scripts/density-lib.mjs';

const BULK_TABLES = [
  'resources',
  'space_counts',
  'space_events',
  'space_occupancy',
  'space_metrics',
  'data_sources',
  'external_records',
];
const FAST_QUESTION_TABLES = [
  'spaces',
  'space_labels',
  'space_children',
  'space_metrics',
];
const TABLES = [...BULK_TABLES, ...FAST_QUESTION_TABLES.filter((table) => !BULK_TABLES.includes(table))];

const withTempEnv = async (fn) => {
  const prior = {
    DENSITY_CLI_BIN: process.env.DENSITY_CLI_BIN,
    DENSITY_CLI_COMMAND: process.env.DENSITY_CLI_COMMAND,
    DENSITY_CLI_REPO: process.env.DENSITY_CLI_REPO,
    DENSITY_CLI_DATA_DIR: process.env.DENSITY_CLI_DATA_DIR,
    FAKE_CLI_LOG: process.env.FAKE_CLI_LOG,
    FAKE_CHART_SUPPORT: process.env.FAKE_CHART_SUPPORT,
    FAKE_STARTER_SUPPORT: process.env.FAKE_STARTER_SUPPORT,
    FAKE_ZERO_STARTER: process.env.FAKE_ZERO_STARTER,
    FAKE_QUESTION_UI_SUPPORT: process.env.FAKE_QUESTION_UI_SUPPORT,
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
const starterRows = process.env.FAKE_ZERO_STARTER === '1' ? 0 : 2;
if (process.env.FAKE_CLI_LOG) {
  await appendFile(process.env.FAKE_CLI_LOG, JSON.stringify(args) + '\\n');
}
const out = (value) => console.log(JSON.stringify(value));
if (args[0] === 'capabilities') {
  out({
    version: 'fake-1.0.0',
    chartQuestions: process.env.FAKE_CHART_SUPPORT === '1',
    chartContract: process.env.FAKE_CHART_SUPPORT === '1' ? 'ask-chart-json-v1' : undefined,
    generativeUi: process.env.FAKE_QUESTION_UI_SUPPORT === '1' ? { renderer: 'json-render', schemaVersion: 1 } : undefined,
    questionAnswering: process.env.FAKE_STARTER_SUPPORT === '1' ? {
      localFirst: true,
      targetTextAnswerMs: 5000,
      targetChartAnswerMs: 10000,
      scope: {
        supportedFamilies: ['meeting-room used-hours rankings', 'hour-of-day meeting-room demand'],
        fastPathInputs: ['space_metrics parquet', 'atlas_spaces_flat parquet'],
        unsupportedFallback: 'Use Atlas chart/report contracts or ask for a narrower utilization question.'
      },
      starterQuestionCount: 100,
      benchmarkCommand: 'density question --starter --chart --format json'
    } : undefined,
    commands: {
      askChart: process.env.FAKE_CHART_SUPPORT === '1',
      questionUi: process.env.FAKE_QUESTION_UI_SUPPORT === '1',
      questionStarter: process.env.FAKE_STARTER_SUPPORT === '1',
      repairFastQuestions: true,
      vizHtml: true
    },
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
} else if (args[0] === 'repair' && args[1] === 'fast-questions') {
  const dataDir = process.env.DENSITY_CLI_DATA_DIR;
  const parquetDir = path.join(dataDir, 'parquet');
  await mkdir(parquetDir, { recursive: true });
  for (const table of ['spaces', 'space_labels', 'space_children']) {
    await writeFile(path.join(parquetDir, table + '.parquet'), 'rows');
  }
  out({
    kind: 'density.repair.fast-questions',
    repaired: true,
    results: [
      { table: 'space_children', rows: 1 },
      { table: 'space_labels', rows: 1 },
      { table: 'spaces', rows: 1 }
    ],
    parquetDir
  });
} else if (args[0] === 'ask') {
  if (process.env.FAKE_CHART_SUPPORT !== '1') {
    console.error('ask unsupported token=super-secret-token');
    process.exitCode = 1;
  } else {
    out({ title: 'Busiest rooms', subtitle: 'Local fake data', chart: '/tmp/chart.svg', html: '/tmp/chart.html' });
  }
} else if (args[0] === 'question' && args.includes('--starter')) {
  if (process.env.FAKE_STARTER_SUPPORT !== '1') {
    console.error('starter unsupported token=super-secret-token');
    process.exitCode = 1;
  } else {
    out({
      kind: 'density.starter-questions',
      questionCount: 2,
      elapsedMs: 42,
      readiness: {
        ready: true,
        mode: args.includes('--chart') ? 'chart' : 'text',
        targetMs: args.includes('--chart') ? 10000 : 5000,
        targetTextAnswerMs: 5000,
        targetChartAnswerMs: 10000,
        elapsedMs: 42,
        maxQuestionMs: 10,
        nonzeroAnswerCount: starterRows,
        artifactCount: args.includes('--chart') ? 2 : 0
      },
      artifactManifest: args.includes('--chart') ? '/tmp/starter-manifest.json' : undefined,
      cache: {
        hit: args.includes('--cached'),
        manifest: args.includes('--chart') ? '/tmp/starter-manifest.json' : undefined
      },
      answers: [
        {
          question: 'what are the busiest rooms?',
          elapsedMs: 10,
          rowCount: starterRows,
          nonzeroRows: starterRows,
          answer: { title: 'Busiest rooms', subtitle: 'Local fake data' },
          artifact: args.includes('--chart') ? { svgFile: '/tmp/chart.svg', htmlFile: '/tmp/chart.html' } : undefined
        },
        {
          question: 'what time are rooms busiest?',
          elapsedMs: 8,
          rowCount: starterRows,
          nonzeroRows: starterRows,
          answer: { title: 'Peak hours', subtitle: 'Local fake data' },
          artifact: args.includes('--chart') ? { svgFile: '/tmp/hours.svg', htmlFile: '/tmp/hours.html' } : undefined
        }
      ]
    });
  }
} else if (args[0] === 'question') {
  if (process.env.FAKE_QUESTION_UI_SUPPORT !== '1') {
    console.error('question unsupported token=super-secret-token');
    process.exitCode = 1;
  } else {
    const cached = args.includes('--cached');
    out({
      kind: 'density.agent-ui',
      renderer: 'json-render',
      schemaVersion: 1,
      jsonRender: {
        spec: {
          elements: {
            answer: { props: { title: cached ? 'Busiest rooms cached UI' : 'Busiest rooms UI', subtitle: cached ? 'Local fake cached UI data' : 'Local fake UI data' } }
          },
          state: { artifacts: { svg: cached ? '/tmp/cached-ui-chart.svg' : '/tmp/ui-chart.svg', html: cached ? '/tmp/cached-ui-chart.html' : '/tmp/ui-chart.html' } }
        }
      },
      artifacts: { svg: cached ? '/tmp/cached-ui-chart.svg' : '/tmp/ui-chart.svg', html: cached ? '/tmp/cached-ui-chart.html' : '/tmp/ui-chart.html' },
      cache: cached ? { hit: true, manifest: '/tmp/starter-manifest.json' } : undefined
    });
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

test('setup reports fast local question answering when advertised by the CLI', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_AUTH_OK = '1';
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_STARTER_SUPPORT = '1';

    const result = await setup({ dataDir });
    const check = result.checks.find((entry) => entry.name === 'fast local question answering advertised');
    const starterCacheCheck = result.checks.find((entry) => entry.name === 'fast starter answers ready');
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.ok(check);
    assert.equal(check.ok, true);
    assert.match(check.detail, /100 starter questions/);
    assert.ok(starterCacheCheck);
    assert.equal(starterCacheCheck.ok, true);
    assert.equal(starterCacheCheck.optional, true);
    assert.match(starterCacheCheck.detail, /2 answers ready/);
    assert.equal(result.starterCache.ready, true);
    assert.equal(result.starterCache.cache.hit, true);
    assert.equal(result.capabilities.questionAnswering.localFirst, true);
    assert.equal(result.capabilities.questionAnswering.targetTextAnswerMs, 5000);
    assert.equal(result.capabilities.questionAnswering.targetChartAnswerMs, 10000);
    assert.ok(result.capabilities.questionAnswering.scope.supportedFamilies.includes('meeting-room used-hours rankings'));
    assert.deepEqual(result.capabilities.questionAnswering.scope.fastPathInputs, ['space_metrics parquet', 'atlas_spaces_flat parquet']);
    assert.ok(calls.some((args) => args[0] === 'question' && args.includes('--starter') && args.includes('--cached') && args.includes('--cache-only')));
  });
});

test('setup distinguishes a warmed starter cache from useful nonzero utilization answers', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_AUTH_OK = '1';
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_STARTER_SUPPORT = '1';
    process.env.FAKE_ZERO_STARTER = '1';

    const result = await setup({ dataDir });
    const starterCacheCheck = result.checks.find((entry) => entry.name === 'fast starter answers ready');

    assert.equal(result.ok, true);
    assert.ok(starterCacheCheck);
    assert.equal(starterCacheCheck.ok, false);
    assert.equal(starterCacheCheck.optional, true);
    assert.match(starterCacheCheck.detail, /0 nonzero utilization answers/);
    assert.equal(result.starterCache.ready, true);
    assert.equal(result.starterCache.useful, false);
    assert.equal(result.starterCache.nonzeroAnswerCount, 0);
  });
});

test('setup suggests repairing normalized fast-question parquet from resources when starter questions are supported', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir, BULK_TABLES);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_AUTH_OK = '1';
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_STARTER_SUPPORT = '1';

    const result = await setup({ dataDir });
    const fastQuestionCheck = result.checks.find((entry) => entry.name === 'fast question parquet ready');
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, false);
    assert.ok(fastQuestionCheck);
    assert.equal(fastQuestionCheck.ok, false);
    assert.match(fastQuestionCheck.detail, /spaces/);
    assert.equal(result.nextAction.id, 'repair_fast_questions');
    assert.deepEqual(result.nextAction.args, { dataDir });
    assert.match(result.nextAction.command, /repair fast-questions/);
    assert.equal(result.starterCache, undefined);
    assert.equal(calls.some((args) => args[0] === 'question' && args.includes('--starter')), false);
  });
});

test('repairFastQuestions materializes normalized metadata and refreshes storage readiness', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir, BULK_TABLES);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await repairFastQuestions({ dataDir });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.repair.kind, 'density.repair.fast-questions');
    assert.equal(result.storage.fastQuestionsReady, true);
    assert.equal(result.userVisiblePrimaryActions, 0);
    assert.equal(calls.some((args) => args[0] === 'repair' && args[1] === 'fast-questions'), true);
  });
});

test('setup does not check starter cache when the CLI lacks starter support', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_AUTH_OK = '1';
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_STARTER_SUPPORT = '0';

    const result = await setup({ dataDir });
    const calls = await readFakeLog(logFile);

    assert.equal(result.starterCache, undefined);
    assert.equal(result.checks.some((entry) => entry.name === 'fast starter answers ready'), false);
    assert.equal(calls.some((args) => args[0] === 'question' && args.includes('--starter')), false);
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

test('setup reports Node version mismatch before local CLI npm install', async () => {
  await withTempEnv(async (tempDir) => {
    delete process.env.DENSITY_CLI_BIN;
    delete process.env.DENSITY_CLI_COMMAND;
    process.env.HOME = tempDir;

    const repo = path.join(tempDir, 'density-cli');
    await mkdir(path.join(repo, 'bin'), { recursive: true });
    await writeFile(path.join(repo, 'bin', 'density.mjs'), '#!/usr/bin/env node\n');
    process.env.DENSITY_CLI_REPO = repo;

    const fakeBin = path.join(tempDir, 'bin');
    await mkdir(fakeBin, { recursive: true });
    const fakeNode = path.join(fakeBin, 'node');
    await writeFile(fakeNode, '#!/bin/sh\nprintf "v25.6.0\\n"\n');
    await chmod(fakeNode, 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`;

    const result = await setup({ dataDir: path.join(tempDir, 'data') });
    const buildCheck = result.checks.find((check) => check.name === 'density cli built');

    assert.equal(result.ok, false);
    assert.equal(buildCheck.ok, false);
    assert.match(buildCheck.detail, /requires Node\.js >=24 <25/);
    assert.match(buildCheck.detail, /duckdb/);
    assert.equal(result.nextAction.id, 'install_supported_node');
    assert.equal(result.userVisiblePrimaryActions, 1);
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

test('askChart prefers supported structured UI chart contract', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await askChart({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.title, 'Busiest rooms cached UI');
    assert.equal(result.subtitle, 'Local fake cached UI data');
    assert.equal(result.chart, '/tmp/cached-ui-chart.svg');
    assert.equal(result.html, '/tmp/cached-ui-chart.html');
    assert.equal(result.cache.hit, true);
    assert.equal(result.cache.manifest, '/tmp/starter-manifest.json');
    assert.equal(result.ui.kind, 'density.agent-ui');
    assert.ok(calls.some((args) => args[0] === 'question' && args.includes('--cached') && args.includes('--chart') && args.includes('--format') && args.includes('ui')));
    assert.equal(calls.some((args) => args[0] === 'question' && !args.includes('--cached') && args.includes('--chart') && args.includes('--format') && args.includes('ui')), false);
  });
});

test('starterQuestions runs supported fast CLI starter contract with chart artifacts', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_STARTER_SUPPORT = '1';

    const result = await starterQuestions({ dataDir: path.join(tempDir, 'data') });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.ready, true);
    assert.equal(result.readiness.ready, true);
    assert.equal(result.readiness.targetMs, 10000);
    assert.equal(result.result.kind, 'density.starter-questions');
    assert.equal(result.result.questionCount, 2);
    assert.equal(result.result.elapsedMs, 42);
    assert.equal(result.result.readiness.ready, true);
    assert.equal(result.result.readiness.mode, 'chart');
    assert.equal(result.result.readiness.targetMs, 10000);
    assert.equal(result.result.readiness.artifactCount, 2);
    assert.equal(result.result.artifactManifest, '/tmp/starter-manifest.json');
    assert.equal(result.result.cache.hit, false);
    assert.equal(result.result.answers[0].artifact.svgFile, '/tmp/chart.svg');
    assert.ok(calls.some((args) => args[0] === 'question' && args.includes('--starter') && args.includes('--chart')));

    const cached = await starterQuestions({ dataDir: path.join(tempDir, 'data'), cached: true });
    const cachedCalls = await readFakeLog(logFile);
    assert.equal(cached.ok, true);
    assert.equal(cached.result.cache.hit, true);
    assert.ok(cachedCalls.some((args) => args[0] === 'question' && args.includes('--starter') && args.includes('--cached')));
  });
});

test('starterQuestions returns static suggestions and update action when CLI lacks starter support', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_STARTER_SUPPORT = '0';

    const result = await starterQuestions({ dataDir: path.join(tempDir, 'data') });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
    assert.equal(result.nextAction.id, 'update_cli_for_starter_questions');
    assert.ok(result.questions.known.includes('what are the busiest rooms?'));
    assert.equal(calls.some((args) => args[0] === 'question' && args.includes('--starter')), false);
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
    assert.match(result.nextAction.command, /--since 14d/);
    assert.match(result.nextAction.command, /--interval 1h/);
    assert.ok(calls.some((args) => args[0] === 'sync' && args.includes('spaces')));
    assert.equal(calls.some((args) => args[0] === 'sync' && args.includes('metrics')), false);
  });
});

test('full onboarding uses 15-minute metrics for explicit 7-day windows', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await onboardCustomer({
      dataDir: path.join(tempDir, 'data'),
      days: 7,
      fullSync: true,
    });
    const calls = await readFakeLog(logFile);
    const metricsCall = calls.find((args) => args[0] === 'sync' && args.includes('metrics'));

    assert.equal(result.ok, true);
    assert.ok(metricsCall);
    assert.equal(metricsCall[metricsCall.indexOf('--since') + 1], '7d');
    assert.equal(metricsCall[metricsCall.indexOf('--interval') + 1], '15m');
  });
});

test('full onboarding uses hourly metrics for two-week windows', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await onboardCustomer({
      dataDir: path.join(tempDir, 'data'),
      days: 14,
      fullSync: true,
    });
    const calls = await readFakeLog(logFile);
    const metricsCall = calls.find((args) => args[0] === 'sync' && args.includes('metrics'));

    assert.equal(result.ok, true);
    assert.equal(result.starterQuestions.skipped, true);
    assert.ok(metricsCall);
    assert.equal(metricsCall[metricsCall.indexOf('--since') + 1], '14d');
    assert.equal(metricsCall[metricsCall.indexOf('--interval') + 1], '1h');
  });
});

test('full onboarding prewarms starter questions when supported', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_STARTER_SUPPORT = '1';

    const result = await onboardCustomer({
      dataDir: path.join(tempDir, 'data'),
      days: 14,
      fullSync: true,
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.starterQuestions.ok, true);
    assert.equal(result.starterQuestions.ready, true);
    assert.equal(result.starterQuestions.questionCount, 2);
    assert.equal(result.starterQuestions.artifactManifest, '/tmp/starter-manifest.json');
    assert.ok(result.steps.some((step) => step.name === 'prewarm starter questions' && step.ok === true && step.optional === true));
    assert.ok(calls.some((args) => args[0] === 'question' && args.includes('--starter') && args.includes('--chart')));
  });
});

test('onboarding rejects invalid metrics window before sync', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    await assert.rejects(
      onboardCustomer({ dataDir: path.join(tempDir, 'data'), days: 15 }),
      /between 1 and 14/
    );
    assert.deepEqual(await readFakeLog(logFile), []);
  });
});

test('metrics preload interval chooses high resolution only for short windows', () => {
  assert.equal(metricsIntervalForDays(7), '15m');
  assert.equal(metricsIntervalForDays(8), '1h');
  assert.equal(metricsIntervalForDays(14), '1h');
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
    assert.equal(report.fastQuestionsReady, false);
    assert.equal(report.tables.find((table) => table.table === 'resources').present, true);
    assert.equal(report.tables.find((table) => table.table === 'space_metrics').present, false);
  });
});

test('fast-question readiness accepts partitioned normalized parquet tables', async () => {
  await withTempEnv(async (tempDir) => {
    const dataDir = path.join(tempDir, 'data');
    const parquetDir = path.join(dataDir, 'parquet');
    for (const table of FAST_QUESTION_TABLES) {
      await mkdir(path.join(parquetDir, table, 'organization_id=org_1'), { recursive: true });
      await writeFile(path.join(parquetDir, table, 'organization_id=org_1', 'data_0.parquet'), 'rows');
    }

    const report = await storageReport(dataDir);

    assert.equal(report.fastQuestionsReady, true);
    assert.equal(report.fastQuestionTables.every((table) => table.files === 1), true);
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
