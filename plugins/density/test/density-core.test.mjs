import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  answerDensityQuestion,
  askChart,
  authLogin,
  availableBuildings,
  benchmarkCompare,
  boundedGenericDays,
  boundedHistoricalExportDays,
  dataHealthReport,
  floorUsageReport,
  historicalExport,
  historicalIntervalForDays,
  installManagedCli,
  liveWayfindingStatus,
  localDataProfile,
  localUtilizationQuery,
  metricsIntervalForDays,
  onboardCustomer,
  repairFastQuestions,
  sensorHealthReport,
  starterQuestions,
  setup,
  DEFAULT_METRICS_DAYS,
} from '../scripts/density-core.mjs';
import { checkPluginUpdate, managedCliPlatform, resolveDensityCli, storageReport, which } from '../scripts/density-lib.mjs';

const execFileAsync = promisify(execFile);

const callMcp = async (method, params = {}) => {
  const serverPath = new URL('../mcp-server/server.mjs', import.meta.url).pathname;
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for MCP response. stderr: ${stderr}`));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newlineIndex = stdout.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = stdout.slice(0, newlineIndex);
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!stdout.trim()) reject(new Error(`MCP server exited with ${code}. stderr: ${stderr}`));
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
  try {
    const message = await response;
    if (message.error) throw new Error(message.error.message);
    return message.result;
  } finally {
    child.kill();
  }
};

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
const SKILL_NAMES = [
  'benchmarking',
  'data-health',
  'density',
  'floorplan',
  'sensor-health',
  'setup',
  'utilization',
  'wayfinding',
];

test('all Density skills carry the shared interaction contract', async () => {
  for (const skillName of SKILL_NAMES) {
    const text = await readFile(new URL(`../skills/${skillName}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(text, /## Interaction Contract/, `${skillName} is missing the interaction contract`);
    assert.match(text, /## Progress Update Contract/, `${skillName} is missing the progress update contract`);
    assert.match(text, /practical (?:workplace )?answer|practical answer/, `${skillName} should lead with the practical answer`);
    assert.match(text, /tool mechanics|CLI, MCP, shell, cache, and tool-routing mechanics/, `${skillName} should suppress mechanics by default`);
    assert.match(text, /current-versus-historical|current availability versus historical utilization/, `${skillName} should clarify current versus historical scope`);
  }
});

test('plugin manifest version reflects the progress-update interaction patch', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.1.8');
  assert.equal(manifest.managedCli.enabled, true);
  assert.ok(manifest.managedCli.assets['darwin-arm64'].url);
  assert.match(manifest.managedCli.assets['darwin-arm64'].sha256, /^[a-f0-9]{64}$/);
});

test('plugin update check exposes update-at-density prompt and reinstall command', async () => {
  await withTempEnv(async () => {
    process.env.DENSITY_PLUGIN_LATEST_MANIFEST_URL = 'data:application/json,{"version":"99.0.0"}';

    const update = await checkPluginUpdate();

    assert.equal(update.checked, true);
    assert.equal(update.available, true);
    assert.equal(update.current, '0.1.8');
    assert.equal(update.latest, '99.0.0');
    assert.equal(update.userPrompt, 'update @density');
    assert.equal(update.displayPrompt, 'update [@density](plugin://density@densityai)');
    assert.equal(update.pluginSelector, 'density@densityai');
    assert.equal(update.pluginUri, 'plugin://density@densityai');
    assert.match(update.prompt, /update @density/);
    assert.match(update.command, /codex plugin marketplace upgrade densityai/);
    assert.match(update.command, /codex plugin remove density@densityai/);
    assert.match(update.command, /codex plugin add density@densityai/);
  });
});

test('MCP tools/list exposes the default Density front door and routing guidance', async () => {
  const result = await callMcp('tools/list');
  const byName = new Map(result.tools.map((tool) => [tool.name, tool]));
  const frontDoor = byName.get('answer_density_question');

  assert.ok(frontDoor);
  assert.match(frontDoor.description, /Default front door/i);
  assert.match(frontDoor.description, /ordinary Density questions/i);
  assert.match(frontDoor.description, /shell/i);
  assert.match(frontDoor.description, /DuckDB/i);
  assert.match(frontDoor.description, /SQL/i);
  assert.match(frontDoor.description, /manual CLI/i);
  assert.match(frontDoor.description, /pick any building/i);
  assert.match(frontDoor.description, /hand-built chart scripts/i);
  assert.deepEqual(frontDoor.inputSchema.required, ['question']);
  assert.equal(frontDoor.inputSchema.properties.question.type, 'string');
  assert.equal(frontDoor.inputSchema.properties.dataDir.type, 'string');
  assert.equal(frontDoor.inputSchema.properties.intentHint.type, 'string');
  assert.equal(frontDoor.inputSchema.additionalProperties, false);

  assert.match(byName.get('ask_chart').description, /Compatibility-only/i);
  assert.match(byName.get('ask_chart').description, /prefer answer_density_question/i);
  assert.match(byName.get('local_utilization_query').description, /scope is already clear/i);
  assert.match(byName.get('local_utilization_query').description, /answer_density_question first/i);
  for (const name of [
    'local_utilization_query',
    'live_wayfinding_status',
    'floor_usage_report',
    'data_health_report',
    'sensor_health_report',
    'benchmark_compare',
  ]) {
    assert.match(byName.get(name).description, /^Use for/i, `${name} should start with explicit Use-for routing language`);
  }
});

const withTempEnv = async (fn) => {
  const prior = {
    DENSITY_CLI_BIN: process.env.DENSITY_CLI_BIN,
    DENSITY_CLI_COMMAND: process.env.DENSITY_CLI_COMMAND,
    DENSITY_CLI_REPO: process.env.DENSITY_CLI_REPO,
    DENSITY_CLI_DATA_DIR: process.env.DENSITY_CLI_DATA_DIR,
    DENSITY_CLI_BUILD_FROM_SOURCE: process.env.DENSITY_CLI_BUILD_FROM_SOURCE,
    DENSITY_MANAGED_CLI_MANIFEST: process.env.DENSITY_MANAGED_CLI_MANIFEST,
    DENSITY_MANAGED_CLI_MANIFEST_PATH: process.env.DENSITY_MANAGED_CLI_MANIFEST_PATH,
    DENSITY_PLUGIN_RUNTIME_DIR: process.env.DENSITY_PLUGIN_RUNTIME_DIR,
    FAKE_CLI_LOG: process.env.FAKE_CLI_LOG,
    FAKE_CHART_SUPPORT: process.env.FAKE_CHART_SUPPORT,
    FAKE_AVAILABLE_BUILDINGS_SUPPORT: process.env.FAKE_AVAILABLE_BUILDINGS_SUPPORT,
    FAKE_STARTER_SUPPORT: process.env.FAKE_STARTER_SUPPORT,
    FAKE_ZERO_STARTER: process.env.FAKE_ZERO_STARTER,
    FAKE_QUESTION_UI_SUPPORT: process.env.FAKE_QUESTION_UI_SUPPORT,
    FAKE_AUTH_OK: process.env.FAKE_AUTH_OK,
    FAKE_DELAY_METRICS: process.env.FAKE_DELAY_METRICS,
    FAKE_WAYFINDING_HELP: process.env.FAKE_WAYFINDING_HELP,
    FAKE_WAYFINDING_FAIL: process.env.FAKE_WAYFINDING_FAIL,
    FAKE_WAYFINDING_LATEST_SYNCED: process.env.FAKE_WAYFINDING_LATEST_SYNCED,
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
  const supportsAvailableBuildings = process.env.FAKE_AVAILABLE_BUILDINGS_SUPPORT !== '0';
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
      ,
      defaultScope: {
        operatingHours: { start: 8, end: 18, label: '8am-6pm', source: 'atlas_default' },
        timezone: 'space/floor/building metadata via atlas_local_metrics.time_zone',
        localTimeFields: ['local_datetime', 'day_id', 'weekday', 'hour'],
        sourceViews: ['atlas_local_metrics', 'atlas_spaces_flat']
      }
    } : undefined,
    commands: {
      availableBuildings: supportsAvailableBuildings,
      askChart: process.env.FAKE_CHART_SUPPORT === '1',
      questionUi: process.env.FAKE_QUESTION_UI_SUPPORT === '1',
      questionStarter: process.env.FAKE_STARTER_SUPPORT === '1',
      repairFastQuestions: true,
      vizHtml: true
    },
    htmlReports: ['building-overview', 'meeting-rooms', 'floor-usage']
  });
} else if (args[0] === 'available-buildings') {
  if (process.env.FAKE_AVAILABLE_BUILDINGS_SUPPORT === '0') {
    console.error('available-buildings unsupported');
    process.exitCode = 1;
  } else {
    out({
      kind: 'density.available-buildings',
      organizationId: 'org_123',
      organizationName: 'Acme HQ',
      buildingCount: 2,
      buildings: [
        {
          id: 'spc_live_building',
          name: 'Live HQ',
          status: 'live',
          rawStatus: 'live',
          capacity: 100,
          goLive: { goLiveState: 'complete', totalFloorplans: 1, liveFloorplans: 1, futureFloorplans: 0 },
          metricCoverage: { rows: 10, spaces: 3, firstDay: '2026-06-01', lastDay: '2026-06-14' },
          geometry: { mappedSpaces: 3, floorplans: 1, hasGeometry: true },
          chartQueryable: true,
          liveWayfindingEligible: true,
          caveats: [],
          reasons: []
        },
        {
          id: 'spc_planning_building',
          name: 'Planning HQ',
          status: 'planning',
          rawStatus: 'planning',
          goLive: { goLiveState: 'future', totalFloorplans: 1, liveFloorplans: 0, futureFloorplans: 1 },
          metricCoverage: { rows: 0, spaces: 0 },
          geometry: { mappedSpaces: 0, floorplans: 1, hasGeometry: false },
          chartQueryable: false,
          liveWayfindingEligible: false,
          caveats: ['building status is planning', 'go-live is in the future'],
          reasons: ['building status is planning', 'go-live is in the future']
        }
      ]
    });
  }
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
    const noScope = process.env.FAKE_QUESTION_NO_SCOPE === '1';
    out({
      kind: 'density.agent-ui',
      renderer: 'json-render',
      schemaVersion: 1,
      jsonRender: {
        spec: {
          elements: {
            answer: {
              props: {
                title: noScope ? 'No matching local scope found' : (cached ? 'Busiest rooms cached UI' : 'Busiest rooms UI'),
                subtitle: noScope ? 'The question named a building or floor that was not found in local Atlas metadata, so the answer should not be treated as scoped.' : (cached ? 'Local fake cached UI data' : 'Local fake UI data')
              }
            }
          },
          state: {
            artifacts: { svg: cached ? '/tmp/cached-ui-chart.svg' : '/tmp/ui-chart.svg', html: cached ? '/tmp/cached-ui-chart.html' : '/tmp/ui-chart.html' },
            effectiveScope: {
              timezone: { value: 'America/New_York', source: 'space_metadata', fallbackUsed: false },
              operatingHours: { start: 8, end: 18, label: '8am-6pm', source: 'atlas_default' },
              sourceViews: ['atlas_local_metrics', 'atlas_spaces_flat']
            },
            freshness: { firstLocalDay: '2026-06-01', lastLocalDay: '2026-06-14', source: 'atlas_local_metrics' },
            confidence: { level: 'high', reasons: ['Used atlas_local_metrics local time projections for hour/day grouping.'] },
            caveats: ['Defaulted to Atlas operating hours (8am-6pm) instead of querying all 24 hours.']
          }
        }
      },
      artifacts: { svg: cached ? '/tmp/cached-ui-chart.svg' : '/tmp/ui-chart.svg', html: cached ? '/tmp/cached-ui-chart.html' : '/tmp/ui-chart.html' },
      cache: cached ? { hit: true, manifest: '/tmp/starter-manifest.json' } : undefined
    });
  }
} else if (args[0] === 'wayfinding' && args[1] === 'local') {
  if (process.env.FAKE_WAYFINDING_FAIL === '1') {
    console.error('live wayfinding unsupported token=super-secret-token');
    process.exitCode = 1;
  } else if (process.env.FAKE_WAYFINDING_HELP === '1') {
    console.log('Density CLI wayfinding help');
  } else if (process.env.FAKE_WAYFINDING_LATEST_SYNCED === '1') {
    out({ availabilityMode: 'latest-synced', spaces: [{ id: 'space_1', available: true }] });
  } else {
    out({
      availabilityMode: 'live',
      result: {
        candidates: [{ name: 'Batik', floorName: '15', available: true, occupied: false }],
        unavailableMatches: [],
        missingAvailabilitySpaceIds: []
      },
      artifact: { html: '/tmp/wayfinding-local.html' },
      panelTarget: { contract: 'density.panel-target.v1', kind: 'local-html', report: 'wayfinding-local', path: '/tmp/wayfinding-local.html' }
    });
  }
} else if (args[0] === 'viz' && args.includes('--html')) {
  const reportIndex = args.indexOf('--report');
  const report = reportIndex >= 0 ? args[reportIndex + 1] : 'building-overview';
  const outIndex = args.indexOf('--out');
  const html = outIndex >= 0 ? args[outIndex + 1] : '/tmp/' + report + '.html';
  out({
    report,
    artifact: { html },
    panelTarget: { contract: 'density.panel-target.v1', kind: 'local-html', mediaType: 'text/html', report, path: html, url: 'file://' + html }
  });
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

const sha256File = async (file) => createHash('sha256')
  .update(await readFile(file))
  .digest('hex');

const tarCommand = process.platform === 'win32' ? 'tar' : '/usr/bin/tar';

const writeManagedCliArchive = async (tempDir) => {
  const runtimeDir = path.join(tempDir, 'fixture-runtime');
  const bin = path.join(runtimeDir, 'bin', 'density');
  const archive = path.join(tempDir, 'density-runtime.tgz');
  await writeFakeCli(bin);
  await execFileAsync(tarCommand, ['-czf', archive, '-C', runtimeDir, '.']);
  return {
    archive,
    sha256: await sha256File(archive),
  };
};

const writeManagedCliManifest = async (tempDir, options = {}) => {
  const manifestPath = path.join(tempDir, 'managed-cli-manifest.json');
  const platform = options.platform ?? managedCliPlatform();
  const asset = options.asset ?? (await writeManagedCliArchive(tempDir));
  const manifest = {
    version: options.version ?? '9.8.7',
    requiredCapabilities: options.requiredCapabilities ?? {
      commands: ['availableBuildings', 'questionStarter', 'repairFastQuestions'],
      questionAnswering: { localFirst: true },
    },
    assets: {
      [platform]: {
        path: asset.archive,
        sha256: options.sha256 ?? asset.sha256,
      },
    },
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath, manifest, platform, asset };
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
    assert.equal(result.capabilities.availableBuildings, true);
    assert.equal(result.capabilities.chartQuestions, false);
    assert.equal(result.nextAction.id, 'chart_unsupported');
    assert.ok(result.checks.some((check) => check.name === 'density chart capability known'));
    assert.ok(result.checks.some((check) => check.name === 'building lifecycle readiness advertised' && check.ok));
    assert.equal(result.nextSteps.length, 1);
  });
});

test('availableBuildings exposes lifecycle and go-live readiness from the CLI', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;

    const result = await availableBuildings({ dataDir });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'density.available-buildings');
    assert.equal(result.summary.status.live, 1);
    assert.equal(result.summary.status.planning, 1);
    assert.equal(result.summary.goLive.complete, 1);
    assert.equal(result.summary.goLive.future, 1);
    assert.equal(result.summary.chartQueryable, 1);
    assert.equal(result.summary.liveWayfindingEligible, 1);
    assert.equal(result.contract.queryNonLiveAllowed, true);
    assert.equal(result.contract.discloseStatusAndGoLive, true);
    assert.ok(result.buildings.find((building) => building.name === 'Planning HQ')?.caveats.includes('go-live is in the future'));
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
    assert.equal(result.capabilities.availableBuildings, true);
    assert.equal(result.capabilities.questionAnswering.targetTextAnswerMs, 5000);
    assert.equal(result.capabilities.questionAnswering.targetChartAnswerMs, 10000);
    assert.ok(result.capabilities.questionAnswering.scope.supportedFamilies.includes('meeting-room used-hours rankings'));
    assert.deepEqual(result.capabilities.questionAnswering.scope.fastPathInputs, ['space_metrics parquet', 'atlas_spaces_flat parquet']);
    assert.ok(calls.some((args) => args[0] === 'question' && args.includes('--starter') && args.includes('--cached') && args.includes('--cache-only')));
  });
});

test('setup points at a CLI update when building lifecycle readiness is missing', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_AUTH_OK = '1';
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_STARTER_SUPPORT = '1';
    process.env.FAKE_AVAILABLE_BUILDINGS_SUPPORT = '0';

    const result = await setup({ dataDir });
    const lifecycleCheck = result.checks.find((entry) => entry.name === 'building lifecycle readiness advertised');

    assert.equal(result.ok, false);
    assert.equal(lifecycleCheck.ok, false);
    assert.equal(result.capabilities.availableBuildings, false);
    assert.equal(result.nextAction.id, 'update_cli_for_building_lifecycle');
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

test('setup reports one managed install action when no CLI is discoverable', async () => {
  await withTempEnv(async (tempDir) => {
    process.env.HOME = tempDir;
    process.env.PATH = tempDir;
    const { manifestPath } = await writeManagedCliManifest(tempDir);
    process.env.DENSITY_MANAGED_CLI_MANIFEST_PATH = manifestPath;

    const result = await setup({ dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.nextAction.id, 'install_managed_cli');
    assert.equal(result.nextAction.tool, 'install_managed_cli');
    assert.equal(result.userVisiblePrimaryActions, 1);
    assert.equal(result.nextSteps.length, 1);
  });
});

test('setup falls back to configure CLI when no managed asset is available for this platform', async () => {
  await withTempEnv(async (tempDir) => {
    process.env.HOME = tempDir;
    process.env.PATH = tempDir;
    const { manifestPath } = await writeManagedCliManifest(tempDir, { platform: 'not-this-platform' });
    process.env.DENSITY_MANAGED_CLI_MANIFEST_PATH = manifestPath;

    const result = await setup({ dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.nextAction.id, 'configure_cli');
    assert.equal(result.managedCli.runtime.assetAvailable, false);
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
    assert.equal(result.effectiveScope.timezone.value, 'America/New_York');
    assert.equal(result.freshness.source, 'atlas_local_metrics');
    assert.equal(result.confidence.level, 'high');
    assert.match(result.caveats.join(' '), /Atlas operating hours/);
    assert.equal(result.ui.kind, 'density.agent-ui');
    assert.ok(calls.some((args) => args[0] === 'question' && args.includes('--cached') && args.includes('--chart') && args.includes('--format') && args.includes('ui')));
    assert.equal(calls.some((args) => args[0] === 'question' && !args.includes('--cached') && args.includes('--chart') && args.includes('--format') && args.includes('ui')), false);
  });
});

test('askChart routes current availability questions to live wayfinding before cached charts', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await askChart({
      dataDir: path.join(tempDir, 'data'),
      question: 'which meeting rooms are open?',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.intent, 'live_wayfinding');
    assert.equal(result.routedTool, 'live_wayfinding_status');
    assert.equal(result.sourceLayer, 'live_feed');
    assert.equal(result.liveAvailable, true);
    assert.equal(result.chartSuppressed, true);
    assert.equal(calls.some((args) => args[0] === 'question'), false);
    assert.equal(calls.some((args) => args[0] === 'ask'), false);
    assert.equal(calls.some((args) => args[0] === 'capabilities'), false);
    assert.equal(calls.some((args) => args[0] === 'wayfinding' && args[1] === 'local'), true);
  });
});

test('askChart routes floorplan artifact prompts before cached chart routing', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await askChart({
      dataDir: path.join(tempDir, 'data'),
      question: 'show floor 15 utilization on a floorplan',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.intent, 'floorplan_artifact');
    assert.equal(result.routedSkill, 'floorplan');
    assert.equal(result.report, 'floor-usage');
    assert.equal(result.html, '/tmp/floor-usage.html');
    assert.equal(result.artifactRequired, 'floorplan');
    assert.equal(calls.some((args) => args[0] === 'viz' && args.includes('floor-usage')), true);
    assert.equal(calls.some((args) => args[0] === 'question'), false);
    assert.equal(calls.some((args) => args[0] === 'ask'), false);
  });
});

test('floorUsageReport renders a floorplan artifact through the CLI report contract', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await floorUsageReport({
      dataDir: path.join(tempDir, 'data'),
      question: 'Show Empire State Building floor 15 utilization visually on the floor plan',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.intent, 'floorplan_artifact');
    assert.equal(result.routedSkill, 'floorplan');
    assert.equal(result.report, 'floor-usage');
    assert.equal(result.html, '/tmp/floor-usage.html');
    assert.equal(result.panelTarget.report, 'floor-usage');
    assert.equal(result.provenance.tool, 'floor_usage_report');
    assert.equal(calls.some((args) => args[0] === 'viz' && args.includes('--html') && args.includes('--report') && args.includes('floor-usage')), true);
    assert.equal(calls.some((args) => args[0] === 'question'), false);
    assert.equal(calls.some((args) => args[0] === 'ask'), false);
  });
});

test('local utilization query uses one CLI question call per happy-path prompt', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const dataDir = path.join(tempDir, 'data');
    await localUtilizationQuery({ dataDir, question: 'what are the busiest rooms?' });
    await localUtilizationQuery({ dataDir, question: 'what are the busiest phone booths?' });
    const calls = await readFakeLog(logFile);

    assert.equal(calls.filter((args) => args[0] === 'capabilities').length, 0);
    assert.equal(calls.filter((args) => args[0] === 'question').length, 2);
    assert.equal(calls.some((args) => args[0] === 'question' && args.includes('--cached')), false);
  });
});

test('local utilization query does not route metadata caveats to data health', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const question = 'Tell me about utilization of our offices in California over the last two weeks. Include date range, freshness, confidence, and caveats.';
    const result = await localUtilizationQuery({ dataDir: path.join(tempDir, 'data'), question });
    const calls = await readFakeLog(logFile);

    assert.equal(result.intent, 'local_utilization');
    assert.equal(result.routedTool, undefined);
    assert.equal(result.sourceLayer, 'local_customer_data');
    assert.equal(calls.filter((args) => args[0] === 'question').length, 1);
    assert.equal(calls.some((args) => args[0] === 'question' && args[1] === question), true);
    assert.equal(calls.some((args) => args[0] === 'status'), false);
  });
});

test('local utilization query preserves scoped analytics prompts as one-hop CLI questions', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const dataDir = path.join(tempDir, 'data');
    const prompts = [
      'rank the most used conference rooms and phone booths on Empire State Building floor 15 during working hours',
      'normalize conference room size popularity to average occupied hours per day from 6am to 6pm',
      'what is the most popular conference room size in Empire State Building?',
      'what about phone booths?',
      'how often do we run out of phone booths by floor across Empire State Building?',
      'show that as a chart',
    ];

    const startedAt = Date.now();
    for (const question of prompts) {
      const result = await localUtilizationQuery({ dataDir, question });
      assert.equal(result.ok, true);
      assert.equal(result.question, question);
      assert.equal(result.sourceLayer, 'local_customer_data');
      assert.equal(result.effectiveScope.operatingHours.start, 8);
      assert.equal(result.freshness.source, 'atlas_local_metrics');
    }
    const elapsedMs = Date.now() - startedAt;
    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');
    const chartFollowUp = await localUtilizationQuery({ dataDir, question: 'show that as a chart' });
    const expectedCliQuestions = [
      'rank the most used conference rooms and phone booths on Empire State Building floor 15 during working hours',
      'normalize conference room size popularity to average occupied hours per day from 6am to 6pm',
      'what is the most popular conference room size in Empire State Building?',
      'what is the most popular phone booth size in Empire State Building?',
      'how often do we run out of phone booths by floor across Empire State Building?',
    ];

    assert.equal(calls.filter((args) => args[0] === 'capabilities').length, 0);
    assert.equal(questionCalls.length, prompts.length - 1);
    assert.deepEqual(questionCalls.map((args) => args[1]), expectedCliQuestions);
    assert.equal(questionCalls.every((args) => args.includes('--chart') && args.includes('--format') && args.includes('ui')), true);
    assert.equal(questionCalls.some((args) => args.includes('--cached')), false);
    assert.equal(chartFollowUp.intent, 'chart_follow_up');
    assert.equal(chartFollowUp.followUp.previousQuestion, 'how often do we run out of phone booths by floor across Empire State Building?');
    assert.equal(calls.some((args) => args[0] === 'status'), false);
    assert.equal(calls.some((args) => args[0] === 'sync'), false);
    assert.equal(elapsedMs < 5000, true);
  });
});

test('answer density question turns broad scope misses into a fast clarification instead of manual fallback', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_NO_SCOPE = '1';

    const startedAt = Date.now();
    const result = await answerDensityQuestion({
      dataDir: path.join(tempDir, 'data'),
      question: 'can you compare phone booths to meeting rooms with any one LinkedIn building?',
    });
    const elapsedMs = Date.now() - startedAt;
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, false);
    assert.equal(result.intent, 'broad_scope_needs_resolution');
    assert.equal(result.chartSuppressed, true);
    assert.equal(result.nextAction.id, 'clarify_measured_building_scope');
    assert.match(result.subtitle, /manual DuckDB or Parquet work/i);
    assert.deepEqual(result.recovery.avoid, ['shell', 'DuckDB', 'SQL', 'manual Parquet scans', 'hand-built chart scripts']);
    assert.equal(calls.filter((args) => args[0] === 'question').length, 1);
    assert.equal(calls.some((args) => args[0] === 'status'), false);
    assert.equal(calls.some((args) => args[0] === 'sync'), false);
    assert.equal(elapsedMs < 5000, true);
  });
});

test('local utilization query expands contextual normalization follow-ups before calling CLI', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const dataDir = path.join(tempDir, 'data');
    await localUtilizationQuery({ dataDir, question: 'what is the most popular conference room size in Empire State Building?' });
    const normalized = await localUtilizationQuery({ dataDir, question: 'normalize that and use 6am to 6pm instead' });
    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');

    assert.equal(normalized.question, 'normalize that and use 6am to 6pm instead');
    assert.equal(normalized.followUp.type, 'rewrite_contextual_question');
    assert.equal(normalized.followUp.previousQuestion, 'what is the most popular conference room size in Empire State Building?');
    assert.equal(questionCalls[1][1], 'what is the most popular conference room size in Empire State Building? average occupied hours per day from 6am to 6pm');
  });
});

test('local utilization query preserves explicit follow-up scope, day, and time filters', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const dataDir = path.join(tempDir, 'data');
    await localUtilizationQuery({ dataDir, question: 'what is the most popular conference room size on Empire State Building floor 15?' });
    const scopedFollowUp = await localUtilizationQuery({ dataDir, question: 'what about phone booths on floor 16 on Tuesdays after 3pm?' });
    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');
    const effectiveQuestion = questionCalls[1][1];

    assert.equal(scopedFollowUp.followUp.type, 'rewrite_contextual_question');
    assert.match(effectiveQuestion, /phone booth/i);
    assert.match(effectiveQuestion, /floor 16/i);
    assert.match(effectiveQuestion, /Tuesdays/i);
    assert.match(effectiveQuestion, /after 3pm/i);
    assert.doesNotMatch(effectiveQuestion, /floor 15/i);
  });
});

test('local utilization query preserves generic follow-up weekday and hour filters', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const dataDir = path.join(tempDir, 'data');
    await localUtilizationQuery({ dataDir, question: 'rank the busiest meeting rooms during working hours' });
    await localUtilizationQuery({ dataDir, question: 'normalize that for phone booths on weekdays from 7am to 10am' });
    const calls = await readFakeLog(logFile);
    const effectiveQuestion = calls.filter((args) => args[0] === 'question')[1][1];

    assert.match(effectiveQuestion, /phone booth/i);
    assert.match(effectiveQuestion, /average occupied hours per day/i);
    assert.match(effectiveQuestion, /weekdays/i);
    assert.match(effectiveQuestion, /from 7am to 10am/i);
  });
});

test('live wayfinding reports unavailable instead of throwing on non-json CLI output', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_WAYFINDING_HELP = '1';

    const result = await liveWayfindingStatus({
      dataDir: path.join(tempDir, 'data'),
      query: 'Show live wayfinding availability for Empire State floor 15',
      floorId: 'floor_15',
    });

    assert.equal(result.ok, false);
    assert.equal(result.liveAvailable, false);
    assert.equal(result.sourceLayer, 'live_feed');
    assert.match(result.error, /not JSON/);
    assert.equal(result.nextAction.id, 'check_live_wayfinding_cli');
  });
});

test('live wayfinding passes freshness and timeout flags to the CLI', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await liveWayfindingStatus({
      dataDir: path.join(tempDir, 'data'),
      query: 'Show live wayfinding availability for Empire State floor 15',
      floorId: 'floor_15',
      timeoutMs: 4321,
      maxAgeSeconds: 45,
    });
    const calls = await readFakeLog(logFile);
    const wayfindingCall = calls.find((args) => args[0] === 'wayfinding');

    assert.equal(result.ok, true);
    assert.equal(result.liveAvailable, true);
    assert.equal(result.freshness.maxAgeSeconds, 45);
    assert.equal(result.summary.spacesChecked, 1);
    assert.equal(result.summary.counts.available, 1);
    assert.deepEqual(result.summary.spaces, [{ name: 'Batik', state: 'available' }]);
    assert.equal(result.html, '/tmp/wayfinding-local.html');
    assert.equal(result.panelTarget.report, 'wayfinding-local');
    assert.ok(wayfindingCall.includes('--live-timeout-ms'));
    assert.equal(wayfindingCall[wayfindingCall.indexOf('--live-timeout-ms') + 1], '4321');
    assert.ok(wayfindingCall.includes('--freshness-minutes'));
    assert.equal(wayfindingCall[wayfindingCall.indexOf('--freshness-minutes') + 1], '0.75');
  });
});

test('live wayfinding rejects invalid freshness and timeout before invoking the CLI', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    await assert.rejects(
      () => liveWayfindingStatus({
        dataDir: path.join(tempDir, 'data'),
        query: 'Show live wayfinding availability for Empire State floor 15',
        timeoutMs: -1,
      }),
      /timeoutMs must be a positive number/
    );

    await assert.rejects(
      () => liveWayfindingStatus({
        dataDir: path.join(tempDir, 'data'),
        query: 'Show live wayfinding availability for Empire State floor 15',
        maxAgeSeconds: 0,
      }),
      /maxAgeSeconds must be a positive number/
    );

    const calls = await readFakeLog(logFile);
    assert.equal(calls.length, 0);
  });
});

test('live wayfinding failure returns one useful next action', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_WAYFINDING_FAIL = '1';

    const result = await liveWayfindingStatus({
      dataDir: path.join(tempDir, 'data'),
      query: 'Show live wayfinding availability for Empire State floor 15',
      floorId: 'floor_15',
    });

    assert.equal(result.ok, false);
    assert.equal(result.liveAvailable, false);
    assert.equal(result.sourceLayer, 'live_feed');
    assert.equal(result.userVisiblePrimaryActions, 1);
    assert.equal(result.nextAction.id, 'check_live_wayfinding_cli');
    assert.match(result.error, /live wayfinding unsupported/);
    assert.doesNotMatch(result.error, /super-secret-token/);
  });
});

test('live wayfinding marks latest-synced fallback as non-live with one next action', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_WAYFINDING_LATEST_SYNCED = '1';

    const result = await liveWayfindingStatus({
      dataDir: path.join(tempDir, 'data'),
      query: 'Show live wayfinding availability for Empire State floor 15',
      floorId: 'floor_15',
    });

    assert.equal(result.ok, true);
    assert.equal(result.sourceLayer, 'live_feed');
    assert.equal(result.availabilityMode, 'latest-synced');
    assert.equal(result.liveAvailable, false);
    assert.equal(result.walkableRecommendation, false);
    assert.equal(result.result, undefined);
    assert.equal(result.html, undefined);
    assert.equal(result.panelTarget, undefined);
    assert.equal(result.summary.spacesChecked, 1);
    assert.equal(result.summary.counts.available, 1);
    assert.equal(result.userVisiblePrimaryActions, 1);
    assert.equal(result.nextAction.id, 'refresh_live_wayfinding');
    assert.equal(result.nextAction.tool, undefined);
    assert.match(result.explanation, /walkable recommendation/);
    assert.doesNotMatch(JSON.stringify(result), /space_1|floor_15/);
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

test('default onboarding is staged and does not start sync commands', async () => {
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
    assert.equal(calls.some((args) => args[0] === 'sync'), false);
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

test('historical export supports larger local customer-owned history windows', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await historicalExport({
      dataDir: path.join(tempDir, 'data'),
      days: 90,
      timeoutSeconds: 5,
    });
    const calls = await readFakeLog(logFile);
    const metricsCall = calls.find((args) => args[0] === 'sync' && args.includes('metrics'));

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'historical-export');
    assert.equal(result.sourceLayer, 'local_customer_data');
    assert.equal(result.days, 90);
    assert.equal(result.interval, '1h');
    assert.ok(metricsCall);
    assert.equal(metricsCall[metricsCall.indexOf('--since') + 1], '90d');
    assert.equal(metricsCall[metricsCall.indexOf('--interval') + 1], '1h');
    assert.ok(calls.some((args) => args[0] === 'export' && args[1] === 'parquet'));
  });
});

test('historical export has separate bounds from starter preload', () => {
  assert.equal(boundedHistoricalExportDays(undefined), 90);
  assert.equal(boundedHistoricalExportDays(365), 365);
  assert.throws(() => boundedHistoricalExportDays(366), /between 1 and 365/);
  assert.equal(historicalIntervalForDays(7), '15m');
  assert.equal(historicalIntervalForDays(90), '1h');
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

test('storage cache invalidates when an existing parquet file changes', async () => {
  await withTempEnv(async (tempDir) => {
    const dataDir = path.join(tempDir, 'data');
    await writeParquetTables(dataDir);

    const first = await storageReport(dataDir);
    await writeFile(path.join(dataDir, 'parquet', 'space_metrics.parquet'), 'rows plus more rows');
    const second = await storageReport(dataDir);

    const firstMetrics = first.tables.find((table) => table.table === 'space_metrics');
    const secondMetrics = second.tables.find((table) => table.table === 'space_metrics');
    assert.notEqual(firstMetrics.bytes, secondMetrics.bytes);
    assert.equal(secondMetrics.bytes, 'rows plus more rows'.length);
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

test('storage cache invalidates when a partitioned parquet file changes', async () => {
  await withTempEnv(async (tempDir) => {
    const dataDir = path.join(tempDir, 'data');
    const partitionDir = path.join(dataDir, 'parquet', 'space_metrics', 'organization_id=org_1', 'day_id=2026-06-02');
    await mkdir(partitionDir, { recursive: true });
    const partitionFile = path.join(partitionDir, 'data_0.parquet');
    await writeFile(partitionFile, 'rows');

    const first = await storageReport(dataDir);
    await writeFile(partitionFile, 'rows plus more rows');
    const second = await storageReport(dataDir);

    const firstMetrics = first.tables.find((table) => table.table === 'space_metrics');
    const secondMetrics = second.tables.find((table) => table.table === 'space_metrics');
    assert.notEqual(firstMetrics.bytes, secondMetrics.bytes);
    assert.equal(secondMetrics.bytes, 'rows plus more rows'.length);
  });
});

test('CLI resolution order prefers env overrides, managed runtime, then repo and PATH', async () => {
  await withTempEnv(async (tempDir) => {
    const manifest = {
      version: '7.6.5',
      requiredCapabilities: {},
      assets: {},
    };
    process.env.DENSITY_MANAGED_CLI_MANIFEST = JSON.stringify(manifest);
    process.env.DENSITY_PLUGIN_RUNTIME_DIR = path.join(tempDir, 'runtime-cache');
    const managedCli = path.join(process.env.DENSITY_PLUGIN_RUNTIME_DIR, manifest.version, managedCliPlatform(), 'bin', 'density');
    await writeFakeCli(managedCli);

    const repoCli = path.join(tempDir, 'repo', 'bin', 'density.mjs');
    const pathCli = path.join(tempDir, 'bin', 'density');
    const binCli = path.join(tempDir, 'explicit-density.mjs');
    await writeFakeCli(binCli);
    await writeFakeCli(repoCli);
    await writeFakeCli(pathCli);
    process.env.DENSITY_CLI_REPO = path.join(tempDir, 'repo');
    process.env.PATH = `${path.dirname(pathCli)}${path.delimiter}${process.env.PATH ?? ''}`;

    let cli = await resolveDensityCli();
    assert.equal(cli.path, managedCli);
    assert.equal(cli.source, 'plugin-managed');

    process.env.DENSITY_CLI_BIN = binCli;
    cli = await resolveDensityCli();
    assert.equal(cli.path, binCli);
    assert.equal(cli.source, 'DENSITY_CLI_BIN');

    process.env.DENSITY_CLI_COMMAND = 'density-from-command';
    cli = await resolveDensityCli();
    assert.equal(cli.command, 'density-from-command');
    assert.equal(cli.source, 'DENSITY_CLI_COMMAND');

    delete process.env.DENSITY_CLI_COMMAND;
    delete process.env.DENSITY_CLI_BIN;
    await rm(process.env.DENSITY_PLUGIN_RUNTIME_DIR, { recursive: true, force: true });
    cli = await resolveDensityCli();
    assert.equal(cli.path, repoCli);
    assert.equal(cli.source, path.join(tempDir, 'repo'));

    delete process.env.DENSITY_CLI_REPO;
    cli = await resolveDensityCli();
    assert.equal(cli.path, pathCli);
    assert.equal(cli.source, 'PATH');
  });
});

test('installManagedCli rejects a local fixture with a bad checksum', async () => {
  await withTempEnv(async (tempDir) => {
    process.env.HOME = tempDir;
    process.env.DENSITY_PLUGIN_RUNTIME_DIR = path.join(tempDir, 'runtime-cache');
    process.env.FAKE_STARTER_SUPPORT = '1';
    const { manifestPath, manifest } = await writeManagedCliManifest(tempDir, {
      sha256: '0'.repeat(64),
    });
    process.env.DENSITY_MANAGED_CLI_MANIFEST_PATH = manifestPath;

    const result = await installManagedCli({ dataDir: path.join(tempDir, 'data') });
    const expectedPath = path.join(process.env.DENSITY_PLUGIN_RUNTIME_DIR, manifest.version, managedCliPlatform(), 'bin', 'density');

    assert.equal(result.ok, false);
    assert.match(result.error, /checksum mismatch/i);
    await assert.rejects(readFile(expectedPath), /ENOENT/);
  });
});

test('installManagedCli installs and validates a local fixture runtime', async () => {
  await withTempEnv(async (tempDir) => {
    process.env.HOME = tempDir;
    process.env.DENSITY_PLUGIN_RUNTIME_DIR = path.join(tempDir, 'runtime-cache');
    process.env.FAKE_STARTER_SUPPORT = '1';
    const { manifestPath, manifest, asset } = await writeManagedCliManifest(tempDir);
    process.env.DENSITY_MANAGED_CLI_MANIFEST_PATH = manifestPath;

    const installed = await installManagedCli({ dataDir: path.join(tempDir, 'data') });
    const cli = await resolveDensityCli();

    assert.equal(installed.ok, true);
    assert.equal(installed.version, manifest.version);
    assert.equal(installed.source, asset.archive);
    assert.equal(installed.sourceMode, 'copy');
    assert.equal(installed.sha256, asset.sha256);
    assert.equal(installed.path, path.join(process.env.DENSITY_PLUGIN_RUNTIME_DIR, manifest.version, managedCliPlatform(), 'bin', 'density'));
    assert.equal(installed.capabilities.checked, true);
    assert.equal(installed.capabilities.commands.questionStarter, true);
    assert.equal(cli.source, 'plugin-managed');
    assert.equal(cli.path, installed.path);
  });
});

test('setup asks to update managed CLI when required capabilities are absent', async () => {
  await withTempEnv(async (tempDir) => {
    process.env.HOME = tempDir;
    process.env.DENSITY_PLUGIN_RUNTIME_DIR = path.join(tempDir, 'runtime-cache');
    process.env.FAKE_STARTER_SUPPORT = '0';
    const { manifestPath, manifest } = await writeManagedCliManifest(tempDir);
    process.env.DENSITY_MANAGED_CLI_MANIFEST_PATH = manifestPath;
    const managedCli = path.join(process.env.DENSITY_PLUGIN_RUNTIME_DIR, manifest.version, managedCliPlatform(), 'bin', 'density');
    await writeFakeCli(managedCli);

    const result = await setup({ dataDir: path.join(tempDir, 'data') });

    assert.equal(result.nextAction.id, 'install_managed_cli');
    assert.deepEqual(result.nextAction.missingRequiredCapabilities, ['commands.questionStarter', 'questionAnswering.localFirst']);
    assert.deepEqual(result.managedCli.missingRequiredCapabilities, ['commands.questionStarter', 'questionAnswering.localFirst']);
    assert.equal(result.userVisiblePrimaryActions, 1);
  });
});

test('setup exposes update-at-density as the plugin update action', async () => {
  await withTempEnv(async (tempDir) => {
    process.env.DENSITY_PLUGIN_LATEST_MANIFEST_URL = 'data:application/json,{"version":"99.0.0"}';
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'ready');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_AUTH_OK = '1';
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_STARTER_SUPPORT = '1';

    const result = await setup({ dataDir });

    assert.equal(result.nextAction.id, 'plugin_update');
    assert.equal(result.nextAction.userPrompt, 'update @density');
    assert.equal(result.nextAction.displayPrompt, 'update [@density](plugin://density@densityai)');
    assert.equal(result.nextAction.pluginSelector, 'density@densityai');
    assert.equal(result.nextAction.pluginUri, 'plugin://density@densityai');
    assert.match(result.nextAction.command, /codex plugin remove density@densityai/);
    assert.equal(result.userVisiblePrimaryActions, 1);
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

test('local utilization query declares local provenance and benchmark affordance', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'what are the busiest rooms?',
    });

    assert.equal(result.ok, true);
    assert.equal(result.sourceLayer, 'local_customer_data');
    assert.equal(result.provenance.tool, 'local_utilization_query');
    assert.equal(result.benchmarkAffordance.sourceLayer, 'benchmark_network_context');
  });
});

test('answer density question front door routes common Density intents', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const cases = [
      {
        question: 'rank the most occupied meeting rooms',
        intentHint: 'historical',
        intent: 'local_utilization',
        routedTool: 'local_utilization_query',
      },
      {
        question: 'find me an open meeting room now',
        intentHint: 'live',
        intent: 'live_wayfinding',
        routedTool: 'live_wayfinding_status',
      },
      {
        question: 'map phone booth usage on floor 16',
        intentHint: 'floorplan',
        intent: 'floorplan_artifact',
        routedTool: 'floor_usage_report',
      },
      {
        question: 'diagnose whether this local data is trustworthy or stale because all the charts show zero',
        intentHint: 'data-health',
        intent: 'local_data_health',
        routedTool: 'data_health_report',
      },
      {
        question: 'why is the live signal stale on floor 15 and are the sensors healthy?',
        intentHint: 'sensor-health',
        intent: 'sensor_health',
        routedTool: 'sensor_health_report',
      },
      {
        question: 'what local historical data do we have for Empire State Building?',
        intentHint: 'coverage',
        intent: 'local_data_coverage',
        routedTool: 'local_data_profile',
      },
    ];

    for (const item of cases) {
      const result = await answerDensityQuestion({
        dataDir,
        question: item.question,
        intentHint: item.intentHint,
      });

      assert.equal(result.tool, 'answer_density_question', item.question);
      assert.equal(result.entrypoint, 'answer_density_question', item.question);
      assert.equal(result.defaultEntrypoint, true, item.question);
      assert.equal(result.intentHint, item.intentHint, item.question);
      assert.equal(result.intent, item.intent, item.question);
      assert.equal(result.routedTool, item.routedTool, item.question);
      assert.equal(result.routing.fromTool, 'answer_density_question', item.question);
      assert.equal(result.routing.viaTool, 'local_utilization_query', item.question);
      assert.equal(result.routing.routedTool, item.routedTool, item.question);
    }
  });
});

test('local utilization query routes coverage questions to local data profile', async () => {
  await withTempEnv(async (tempDir) => {
    const dataDir = path.join(tempDir, 'data');
    await writeParquetTables(dataDir);

    const result = await localUtilizationQuery({
      dataDir,
      question: 'what local historical data do we have for Empire State Building?',
    });

    assert.equal(result.intent, 'local_data_coverage');
    assert.equal(result.routedTool, 'local_data_profile');
    assert.equal(result.routing.routedTool, 'local_data_profile');
    assert.equal(result.sourceLayer, 'local_customer_data');
    assert.equal(result.provenance.tool, 'local_utilization_query');
    assert.match(result.title, /Local historical data/);
  });
});

test('local utilization query routes trust and zero questions to data health report', async () => {
  await withTempEnv(async (tempDir) => {
    const dataDir = path.join(tempDir, 'data');
    await writeParquetTables(dataDir, ['resources']);

    const result = await localUtilizationQuery({
      dataDir,
      question: 'diagnose whether this local data is trustworthy or stale because all the charts show zero',
    });

    assert.equal(result.intent, 'local_data_health');
    assert.equal(result.tool, 'local_utilization_query');
    assert.equal(result.routedTool, 'data_health_report');
    assert.equal(result.routing.routedTool, 'data_health_report');
    assert.equal(result.sourceLayer, 'local_customer_data');
    assert.equal(result.checks.some((check) => check.name === 'canonical parquet ready'), true);
    assert.doesNotMatch(result.subtitle, /\bNULL\b/i);
  });
});

test('local utilization query routes sensor health questions to cloud-only sensor health', async () => {
  await withTempEnv(async (tempDir) => {
    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'why is the live signal stale on floor 15 and are the sensors healthy?',
    });

    assert.equal(result.intent, 'sensor_health');
    assert.equal(result.routedTool, 'sensor_health_report');
    assert.equal(result.routing.routedTool, 'sensor_health_report');
    assert.equal(result.sourceLayer, 'cloud_sensor_health');
    assert.equal(result.sourceBadge, 'Sensor Health');
    assert.equal(result.contract.noLocalDuckdbFallback, true);
    assert.doesNotMatch(JSON.stringify(result), /local_customer_data/);
  });
});

test('local utilization query routes current availability questions to live wayfinding', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'find me an open meeting room now',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.intent, 'live_wayfinding');
    assert.equal(result.routedTool, 'live_wayfinding_status');
    assert.equal(result.sourceLayer, 'live_feed');
    assert.equal(result.sourceBadge, 'Live');
    assert.equal(result.liveAvailable, true);
    assert.equal(calls.some((args) => args[0] === 'question'), false);
    assert.equal(calls.some((args) => args[0] === 'wayfinding' && args[1] === 'local'), true);
  });
});

test('local utilization query keeps ranking and popularity prompts historical', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'rank the most occupied meeting rooms',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.intent, 'local_utilization');
    assert.equal(result.sourceLayer, 'local_customer_data');
    assert.equal(calls.some((args) => args[0] === 'question'), true);
    assert.equal(calls.some((args) => args[0] === 'wayfinding'), false);
  });
});

test('local utilization query treats open availability without now as live wayfinding', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'which phone booths are open?',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.intent, 'live_wayfinding');
    assert.equal(result.routedTool, 'live_wayfinding_status');
    assert.equal(result.sourceLayer, 'live_feed');
    assert.equal(result.liveAvailable, true);
    assert.equal(result.chartSuppressed, true);
    assert.equal(calls.some((args) => args[0] === 'question'), false);
    assert.equal(calls.some((args) => args[0] === 'ask'), false);
    assert.equal(calls.some((args) => args[0] === 'wayfinding' && args[1] === 'local'), true);
  });
});

test('local utilization query does not treat open collaboration spaces as availability by default', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'show open collaboration spaces',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.intent, 'local_utilization');
    assert.equal(result.sourceLayer, 'local_customer_data');
    assert.equal(calls.some((args) => args[0] === 'question'), true);
    assert.equal(calls.some((args) => args[0] === 'wayfinding'), false);
  });
});

test('local utilization query routes floorplan artifact prompts to floor usage report', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'map phone booth usage on floor 16',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.intent, 'floorplan_artifact');
    assert.equal(result.routedTool, 'floor_usage_report');
    assert.equal(result.routedSkill, 'floorplan');
    assert.equal(result.report, 'floor-usage');
    assert.equal(result.html, '/tmp/floor-usage.html');
    assert.equal(result.artifactRequired, 'floorplan');
    assert.equal(result.routing.routedTool, 'floor_usage_report');
    assert.equal(result.routing.routedSkill, 'floorplan');
    assert.equal(calls.some((args) => args[0] === 'viz' && args.includes('floor-usage')), true);
    assert.equal(calls.some((args) => args[0] === 'question'), false);
    assert.equal(calls.some((args) => args[0] === 'ask'), false);
  });
});

test('benchmark compare refuses to invent peer context from local data', async () => {
  const result = await benchmarkCompare({ metric: 'floor_utilization', cohort: { metro: 'sf' } });

  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.equal(result.sourceLayer, 'benchmark_network_context');
  assert.equal(result.sourceBadge, 'Benchmark');
  assert.equal(result.displaySafe, true);
  assert.deepEqual(result.cohort, { metro: 'sf' });
  assert.ok(result.contract.forbiddenOutput.includes('peerRows'));
  assert.match(result.message, /Do not infer peer context/);
});

test('benchmark compare strips forbidden peer-shaped fields from caller input', async () => {
  const result = await benchmarkCompare({
    metric: 'floor_utilization',
    cohort: {
      metro: 'nyc',
      peerRows: [{ orgId: 'peer_org_1' }],
      peerOrgIds: ['peer_org_1'],
      rawDistributions: [1, 2],
      histogramBuckets: [{ start: 0, count: 3 }],
    },
  });
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.cohort, { metro: 'nyc' });
  assert.doesNotMatch(serialized, /peer_org_1/);
  assert.equal(result.cohort.peerRows, undefined);
  assert.equal(result.cohort.rawDistributions, undefined);
  assert.equal(result.cohort.histogramBuckets, undefined);
  assert.match(serialized, /forbiddenOutput/);
});

test('sensor health report refuses to turn missing health into usage truth', async () => {
  const result = await sensorHealthReport({ floorId: 'floor_1', spaceIds: ['space_1'] });

  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.equal(result.sourceLayer, 'cloud_sensor_health');
  assert.equal(result.sourceBadge, 'Sensor Health');
  assert.equal(result.contract.source, 'density_cloud_only');
  assert.equal(result.contract.noLocalDuckdbFallback, true);
  assert.ok(result.contract.healthStates.includes('degraded'));
  assert.match(result.message, /Do not infer sensor health from DuckDB/);
});

test('data health report exposes local readiness checks', async () => {
  await withTempEnv(async (tempDir) => {
    const dataDir = path.join(tempDir, 'data');
    await writeParquetTables(dataDir, ['resources']);

    const result = await dataHealthReport({ dataDir });

    assert.equal(result.sourceLayer, 'local_customer_data');
    assert.equal(result.ok, false);
    assert.equal(result.checks.some((check) => check.name === 'canonical parquet ready'), true);
    assert.equal(result.checks.some((check) => check.name === 'fast question parquet ready'), true);
    assert.equal(result.userVisiblePrimaryActions, 1);
  });
});

test('local data profile reads timestamp coverage from real Parquet when DuckDB is available', async () => {
  await withTempEnv(async (tempDir) => {
    const duckdb = await which('duckdb');
    if (!duckdb) return;
    const dataDir = path.join(tempDir, 'data');
    const parquetDir = path.join(dataDir, 'parquet');
    await mkdir(parquetDir, { recursive: true });
    const metricsFile = path.join(parquetDir, 'space_metrics.parquet');
    await execFileAsync(duckdb, ['-c', `
      COPY (
        SELECT
          'org_1'::VARCHAR AS organization_id,
          'space_1'::VARCHAR AS space_id,
          TIMESTAMP '2026-06-01 09:00:00' AS timestamp,
          1.0::DOUBLE AS occupancy_avg,
          1.0::DOUBLE AS time_used_raw,
          0.99::DOUBLE AS up_time
        UNION ALL
        SELECT
          'org_1'::VARCHAR AS organization_id,
          'space_2'::VARCHAR AS space_id,
          TIMESTAMP '2026-06-02 10:00:00' AS timestamp,
          NULL::DOUBLE AS occupancy_avg,
          0.0::DOUBLE AS time_used_raw,
          0.5::DOUBLE AS up_time
      ) TO '${metricsFile.replace(/'/g, "''")}' (FORMAT PARQUET);
    `]);

    const result = await localDataProfile({ dataDir });
    const metrics = result.profile.tables.find((table) => table.table === 'space_metrics');

    assert.equal(result.profile.checked, true);
    assert.equal(result.freshness.windowCoverage, 'profiled');
    assert.match(result.freshness.firstTimestamp, /2026-06-01/);
    assert.match(result.freshness.lastTimestamp, /2026-06-02/);
    assert.equal(metrics.rows, 2);
    assert.equal(metrics.organizations, 1);
    assert.equal(metrics.spaces, 2);
    assert.equal(metrics.lowUptimeRows, 1);
    assert.equal(metrics.nullRates.occupancyAvg, 0.5);
    assert.equal(metrics.zeroRates.timeUsed, 0.5);
  });
});
