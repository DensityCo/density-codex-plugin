import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import semver from 'semver';
import {
  analyticSlide,
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
  listAnalyticLearningRecords,
  historicalIntervalForDays,
  installManagedCli,
  liveWayfindingStatus,
  localDataProfile,
  localUtilizationQuery,
  metricsIntervalForDays,
  onboardCustomer,
  onboardingStatus,
  repairFastQuestions,
  reviewAnalyticLearningRecord,
  sensorHealthReport,
  starterQuestions,
  setup,
  DEFAULT_BACKGROUND_DEEP_SYNC_DAYS,
  DEFAULT_METRICS_DAYS,
} from '../scripts/density-core.mjs';
import {
  checkPluginUpdate,
  discoverCliCapabilities,
  loadManagedCliManifest,
  managedCliBinPath,
  managedCliPlatform,
  missingRequiredCliCapabilities,
  renderHtmlPreview,
  resolveDensityCli,
  storageReport,
  supportsAnalyticArtifact,
  which,
} from '../scripts/density-lib.mjs';

const execFileAsync = promisify(execFile);

const canonicalArtifactJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalArtifactJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalArtifactJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const analyticArtifactSha256 = (value) => createHash('sha256')
  .update(canonicalArtifactJson(value))
  .digest('hex');

const callMcpRequests = async (requests) => {
  const serverPath = new URL('../mcp-server/server.mjs', import.meta.url).pathname;
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const messages = [];
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let newlineIndex;
    while ((newlineIndex = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, newlineIndex);
      stdout = stdout.slice(newlineIndex + 1);
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const nextMessage = () => messages.length > 0
    ? Promise.resolve(messages.shift())
    : new Promise((resolve) => waiters.push(resolve));
  try {
    const results = [];
    for (const [index, request] of requests.entries()) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, ...request })}\n`);
      const message = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for MCP response. stderr: ${stderr}`)),
          5000,
        );
        nextMessage().then((value) => {
          clearTimeout(timeout);
          resolve(value);
        }, reject);
      });
      if (message.error) throw new Error(message.error.message);
      results.push(message.result);
    }
    return results;
  } finally {
    child.kill();
  }
};

const callMcp = async (method, params = {}) => (
  await callMcpRequests([{ method, params }])
)[0];

const writeFakeHtmlScreenshotCommand = async (file) => {
  await writeFile(file, `#!/usr/bin/env node
const fs = require('node:fs');
const zlib = require('node:zlib');
const args = process.argv.slice(2);
const screenshot = args.find((arg) => arg.startsWith('--screenshot='));
if (!screenshot) process.exit(2);
if (process.env.FAKE_HTML_SCREENSHOT_SKIP_WRITE === '1') {
  if (process.env.FAKE_HTML_SCREENSHOT_LOG) fs.appendFileSync(process.env.FAKE_HTML_SCREENSHOT_LOG, JSON.stringify(args) + '\\n');
  process.exit(0);
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const name = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
};
const width = 1920;
const height = 1080;
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc((width * 4 + 1) * height);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(screenshot.slice('--screenshot='.length), png);
if (process.env.FAKE_HTML_SCREENSHOT_LOG) fs.appendFileSync(process.env.FAKE_HTML_SCREENSHOT_LOG, JSON.stringify(args) + '\\n');
const stallMs = Number(process.env.FAKE_HTML_SCREENSHOT_STALL_MS ?? 0);
if (stallMs > 0) {
  process.on('SIGTERM', () => {});
  setTimeout(() => process.exit(0), stallMs);
}
`);
  await chmod(file, 0o755);
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

test('plugin manifest exposes a strict SemVer version and managed runtime contract', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  const parsedVersion = semver.parse(manifest.version, { loose: false });
  assert.ok(parsedVersion);
  assert.equal(semver.valid(manifest.version), manifest.version);
  assert.equal(parsedVersion.build.length, 0);
  assert.equal(manifest.managedCli.enabled, true);
  assert.equal(manifest.managedCli.requiredCapabilities.commands.includes('questionSnapshotRefresh'), false);
  assert.ok(manifest.managedCli.optionalCapabilities.commands.includes('questionAnalyticArtifact'));
  assert.equal(manifest.managedCli.requiredCapabilities.commands.includes('questionAnalyticArtifact'), false);
  assert.ok(manifest.managedCli.assets['darwin-arm64'].url);
  assert.match(manifest.managedCli.assets['darwin-arm64'].sha256, /^[a-f0-9]{64}$/);
});

test('installed pinned runtime satisfies every required manifest capability', async (t) => {
  const manifest = await loadManagedCliManifest();
  const bin = managedCliBinPath(manifest);
  try {
    await access(bin);
  } catch {
    t.skip(`Pinned runtime is not installed at ${bin}`);
    return;
  }

  const capabilities = await discoverCliCapabilities({ command: bin, args: [], path: bin }, { refresh: true });
  assert.deepEqual(missingRequiredCliCapabilities(capabilities, manifest.requiredCapabilities), []);
});

test('capability discovery caches by runtime identity, invalidates on runtime change, and retries failures', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    const cli = { command: process.execPath, args: [fakeCli], path: fakeCli };

    const first = await discoverCliCapabilities(cli, { dataDir });
    const cached = await discoverCliCapabilities(cli, { dataDir });
    assert.equal(first.chartQuestions, true);
    assert.deepEqual(cached, first);
    assert.equal((await readFakeLog(logFile)).filter((args) => args[0] === 'capabilities').length, 1);

    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    await appendFile(fakeCli, '\n');
    const afterRuntimeChange = await discoverCliCapabilities(cli, { dataDir });
    assert.equal(supportsAnalyticArtifact(afterRuntimeChange, 'slide'), true);
    assert.equal((await readFakeLog(logFile)).filter((args) => args[0] === 'capabilities').length, 2);

    process.env.FAKE_CAPABILITIES_FAIL = '1';
    await appendFile(fakeCli, '\n');
    const failed = await discoverCliCapabilities(cli, { dataDir });
    assert.equal(failed.checked, false);

    delete process.env.FAKE_CAPABILITIES_FAIL;
    const retried = await discoverCliCapabilities(cli, { dataDir });
    assert.equal(retried.checked, true);
    assert.equal((await readFakeLog(logFile)).filter((args) => args[0] === 'capabilities').length, 4);
  });
});

test('plugin update check exposes update-at-density prompt and reinstall command', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  await withTempEnv(async () => {
    process.env.DENSITY_PLUGIN_LATEST_MANIFEST_URL = 'data:application/json,{"version":"99.0.0"}';

    const update = await checkPluginUpdate();

    assert.equal(update.checked, true);
    assert.equal(update.available, true);
    assert.equal(update.current, manifest.version);
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
  assert.match(frontDoor.description, /Pass the user question verbatim/i);
  assert.match(frontDoor.description, /Do not add metrics, freshness checks, time windows/i);
  assert.match(frontDoor.description, /ordinary Density questions/i);
  assert.match(frontDoor.description, /shell/i);
  assert.match(frontDoor.description, /DuckDB/i);
  assert.match(frontDoor.description, /SQL/i);
  assert.match(frontDoor.description, /manual CLI/i);
  assert.match(frontDoor.description, /broad delegated-scope prompts/i);
  assert.match(frontDoor.description, /hand-built chart scripts/i);
  assert.deepEqual(frontDoor.inputSchema.required, ['question']);
  assert.equal(frontDoor.inputSchema.properties.question.type, 'string');
  assert.equal(frontDoor.inputSchema.properties.dataDir.type, 'string');
  assert.equal(frontDoor.inputSchema.properties.intentHint.type, 'string');
  assert.deepEqual(frontDoor.inputSchema.properties.presentation.enum, ['slide', 'broadsheet']);
  assert.equal(frontDoor.inputSchema.additionalProperties, false);

  const askChartTool = byName.get('ask_chart');
  assert.match(askChartTool.description, /Compatibility-only/i);
  assert.match(askChartTool.description, /prefer answer_density_question/i);
  assert.deepEqual(askChartTool.inputSchema.properties.presentation.enum, ['slide', 'broadsheet']);
  const localUtilizationTool = byName.get('local_utilization_query');
  assert.deepEqual(localUtilizationTool.inputSchema.properties.presentation.enum, ['slide', 'broadsheet']);
  const analyticSlideTool = byName.get('analytic_slide');
  assert.ok(analyticSlideTool);
  assert.match(analyticSlideTool.description, /slide|presentation-ready/i);
  assert.deepEqual(analyticSlideTool.inputSchema.required, ['question']);
  assert.equal(analyticSlideTool.inputSchema.properties.dataDir.type, 'string');
  assert.equal(analyticSlideTool.inputSchema.properties.timeoutMs.type, 'number');
  assert.match(analyticSlideTool.inputSchema.properties.timeoutMs.description, /wall|deadline/i);
  assert.equal(analyticSlideTool.inputSchema.additionalProperties, false);
  const learningList = byName.get('analytic_learning_records');
  assert.ok(learningList);
  assert.equal(learningList.inputSchema.properties.dataDir.type, 'string');
  assert.deepEqual(learningList.inputSchema.properties.limit, {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 25,
    description: 'Maximum records to return, newest first. Defaults to 25.',
  });
  assert.deepEqual(learningList.inputSchema.properties.offset, {
    type: 'integer',
    minimum: 0,
    default: 0,
    description: 'Zero-based record offset. Defaults to 0.',
  });
  const learningReview = byName.get('review_analytic_learning');
  assert.ok(learningReview);
  assert.deepEqual(learningReview.inputSchema.required, ['id']);
  assert.deepEqual(learningReview.inputSchema.properties.label.enum, [
    'gold_standard',
    'good_with_fixes',
    'useful_redesign_required',
    'reject',
    'blocked_missing_data',
  ]);
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
  const sensorHealth = byName.get('sensor_health_report');
  assert.doesNotMatch(sensorHealth.description, /["'](?:pick|choose|select) any/i);
  assert.equal(sensorHealth.inputSchema.properties.question.type, 'string');
  assert.equal(sensorHealth.inputSchema.properties.dataDir.type, 'string');
  assert.equal(sensorHealth.inputSchema.properties.timeoutMs.type, 'number');
  assert.deepEqual(Object.keys(sensorHealth.inputSchema.properties).sort(), ['dataDir', 'question', 'timeoutMs']);
  assert.equal(sensorHealth.inputSchema.required, undefined);
});

test('analytic artifact capability checks the v1 contract and requested mode', () => {
  assert.equal(supportsAnalyticArtifact({
    analyticArtifact: { contract: 'density.analytic-artifact.v1', modes: ['text', 'chart', 'slide'] },
  }), true);
  assert.equal(supportsAnalyticArtifact({
    analyticArtifact: { contract: 'density.analytic-artifact.v1', modes: ['text', 'chart'] },
  }), true);
  assert.equal(supportsAnalyticArtifact({
    analyticArtifact: { contract: 'density.analytic-artifact.v1', modes: ['text', 'chart'] },
  }, 'slide'), false);
  assert.equal(supportsAnalyticArtifact({}), false);
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
    DENSITY_HTML_SCREENSHOT_COMMAND: process.env.DENSITY_HTML_SCREENSHOT_COMMAND,
    FAKE_HTML_SCREENSHOT_LOG: process.env.FAKE_HTML_SCREENSHOT_LOG,
    FAKE_HTML_SCREENSHOT_SKIP_WRITE: process.env.FAKE_HTML_SCREENSHOT_SKIP_WRITE,
    FAKE_HTML_SCREENSHOT_STALL_MS: process.env.FAKE_HTML_SCREENSHOT_STALL_MS,
    FAKE_CLI_LOG: process.env.FAKE_CLI_LOG,
    FAKE_CHART_SUPPORT: process.env.FAKE_CHART_SUPPORT,
    FAKE_AVAILABLE_BUILDINGS_SUPPORT: process.env.FAKE_AVAILABLE_BUILDINGS_SUPPORT,
    FAKE_STARTER_SUPPORT: process.env.FAKE_STARTER_SUPPORT,
    FAKE_ZERO_STARTER: process.env.FAKE_ZERO_STARTER,
    FAKE_QUESTION_UI_SUPPORT: process.env.FAKE_QUESTION_UI_SUPPORT,
    FAKE_ANALYTIC_SUPPORT: process.env.FAKE_ANALYTIC_SUPPORT,
    FAKE_ANALYTIC_CANONICAL_QUESTION: process.env.FAKE_ANALYTIC_CANONICAL_QUESTION,
    FAKE_ANALYTIC_NO_SLIDE: process.env.FAKE_ANALYTIC_NO_SLIDE,
    FAKE_QUESTION_UI_ARTIFACT_FREE: process.env.FAKE_QUESTION_UI_ARTIFACT_FREE,
    FAKE_QUESTION_UI_ARTIFACT_STATE: process.env.FAKE_QUESTION_UI_ARTIFACT_STATE,
    FAKE_QUESTION_UI_PREPARED_CACHE: process.env.FAKE_QUESTION_UI_PREPARED_CACHE,
    FAKE_QUESTION_CACHE_MISS: process.env.FAKE_QUESTION_CACHE_MISS,
    FAKE_QUESTION_NO_SCOPE: process.env.FAKE_QUESTION_NO_SCOPE,
    FAKE_QUESTION_MIXED: process.env.FAKE_QUESTION_MIXED,
    FAKE_QUESTION_SNAPSHOT: process.env.FAKE_QUESTION_SNAPSHOT,
    FAKE_QUESTION_DELAY_MS: process.env.FAKE_QUESTION_DELAY_MS,
    FAKE_QUESTION_UI_FAIL: process.env.FAKE_QUESTION_UI_FAIL,
    FAKE_CAPABILITY_DELAY_MS: process.env.FAKE_CAPABILITY_DELAY_MS,
    FAKE_ASK_DELAY_MS: process.env.FAKE_ASK_DELAY_MS,
    FAKE_QUESTION_CLARIFICATION: process.env.FAKE_QUESTION_CLARIFICATION,
    FAKE_ANALYTIC_CONTEXT_NEEDED: process.env.FAKE_ANALYTIC_CONTEXT_NEEDED,
    FAKE_ANALYTIC_MALFORMED: process.env.FAKE_ANALYTIC_MALFORMED,
    FAKE_ANALYTIC_BAD_TARGET: process.env.FAKE_ANALYTIC_BAD_TARGET,
    FAKE_ANALYTIC_BAD_GATES: process.env.FAKE_ANALYTIC_BAD_GATES,
    FAKE_ANALYTIC_NO_GATES: process.env.FAKE_ANALYTIC_NO_GATES,
    FAKE_ANALYTIC_SUPPORTED_TEXT: process.env.FAKE_ANALYTIC_SUPPORTED_TEXT,
    FAKE_ANALYTIC_LEARNING_ID: process.env.FAKE_ANALYTIC_LEARNING_ID,
    FAKE_ANALYTIC_BAD_LEARNING_ID: process.env.FAKE_ANALYTIC_BAD_LEARNING_ID,
    FAKE_ANALYTIC_ARCHETYPES: process.env.FAKE_ANALYTIC_ARCHETYPES,
    FAKE_ANALYTIC_QUALITY_FIELDS: process.env.FAKE_ANALYTIC_QUALITY_FIELDS,
    FAKE_ANALYTIC_INVALID_QUALITY_FIELD: process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD,
    FAKE_ANALYTIC_DENOMINATOR_COVERAGE: process.env.FAKE_ANALYTIC_DENOMINATOR_COVERAGE,
    FAKE_ANALYTIC_CAVEAT_CLAIM: process.env.FAKE_ANALYTIC_CAVEAT_CLAIM,
    FAKE_ANALYTIC_CAVEAT_SEVERITY: process.env.FAKE_ANALYTIC_CAVEAT_SEVERITY,
    FAKE_ANALYTIC_STALE_ROOT_CHILDREN: process.env.FAKE_ANALYTIC_STALE_ROOT_CHILDREN,
    FAKE_ANALYTIC_LEARNING_COUNT: process.env.FAKE_ANALYTIC_LEARNING_COUNT,
    FAKE_ANALYTIC_NO_RECEIPT_CAPABILITY: process.env.FAKE_ANALYTIC_NO_RECEIPT_CAPABILITY,
    FAKE_ANALYTIC_RECEIPT_V1: process.env.FAKE_ANALYTIC_RECEIPT_V1,
    FAKE_ANALYTIC_RECEIPT_FAILURE: process.env.FAKE_ANALYTIC_RECEIPT_FAILURE,
    FAKE_ANALYTIC_BENCHMARK_SHOWN: process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN,
    FAKE_ANALYTIC_BENCHMARK_NOT_COMPARABLE: process.env.FAKE_ANALYTIC_BENCHMARK_NOT_COMPARABLE,
    FAKE_RSVG_LOG: process.env.FAKE_RSVG_LOG,
    FAKE_SNAPSHOT_REFRESH_SUPPORT: process.env.FAKE_SNAPSHOT_REFRESH_SUPPORT,
    FAKE_SENSOR_HEALTH_UI: process.env.FAKE_SENSOR_HEALTH_UI,
    FAKE_SENSOR_PRIVATE_UI: process.env.FAKE_SENSOR_PRIVATE_UI,
    FAKE_SENSOR_INVALID_CONTRACT: process.env.FAKE_SENSOR_INVALID_CONTRACT,
    FAKE_SENSOR_SCOPE_LABEL: process.env.FAKE_SENSOR_SCOPE_LABEL,
    FAKE_OPERATING_HOURS: process.env.FAKE_OPERATING_HOURS,
    FAKE_CAPABILITIES_FAIL: process.env.FAKE_CAPABILITIES_FAIL,
    FAKE_THEME_CAPABILITY: process.env.FAKE_THEME_CAPABILITY,
    FAKE_THEME_UNSET: process.env.FAKE_THEME_UNSET,
    FAKE_THEME_LIST_MALFORMED: process.env.FAKE_THEME_LIST_MALFORMED,
    FAKE_THEME_GET_MALFORMED: process.env.FAKE_THEME_GET_MALFORMED,
    FAKE_THEME_SET_FAIL: process.env.FAKE_THEME_SET_FAIL,
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
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
const starterRows = process.env.FAKE_ZERO_STARTER === '1' ? 0 : 2;
if (process.env.FAKE_CLI_LOG) {
  await appendFile(process.env.FAKE_CLI_LOG, JSON.stringify(args) + '\\n');
}
const out = (value) => console.log(JSON.stringify(value));
const canonicalJson = (value) => {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
};
const analyticSha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const themeRegistry = [
  { value: 'product_clean', label: 'Product Clean' },
  { value: 'editorial', label: 'Editorial' },
  { value: 'swiss', label: 'Swiss' },
  { value: 'boardroom_dark', label: 'Boardroom Dark' },
  { value: 'ft_editorial', label: 'FT Editorial' },
  { value: 'monograph', label: 'Monograph' },
  { value: 'blueprint', label: 'Blueprint' },
  { value: 'humanist', label: 'Humanist' },
  { value: 'newsprint_mono', label: 'Newsprint Mono' },
  { value: 'alpine_grid', label: 'Alpine Grid' }
];
const themePresets = [
  { value: 'density_blue', accent: '#1F4E9C' },
  { value: 'indigo', accent: '#635BFF' },
  { value: 'deep_teal', accent: '#1A6B54' }
];
const themeStateFile = path.join(process.env.DENSITY_CLI_DATA_DIR || '/tmp', 'fake-theme-preference.json');
const themeSelection = (value) => {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return { brand_accent: value };
  if (themePresets.some((entry) => entry.value === value)) return { preset: value };
  if (themeRegistry.some((entry) => entry.value === value)) return { theme: value };
  return undefined;
};
const readThemeValue = async () => {
  try {
    return JSON.parse(await readFile(themeStateFile, 'utf8')).value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return process.env.FAKE_THEME_UNSET === '1' ? null : 'product_clean';
  }
};
if (args[0] === 'capabilities') {
  if (Number(process.env.FAKE_CAPABILITY_DELAY_MS) > 0) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CAPABILITY_DELAY_MS)));
  }
  if (process.env.FAKE_CAPABILITIES_FAIL === '1') {
    console.error('capability failure token=super-secret-capability');
    process.exit(1);
  }
  const supportsAvailableBuildings = process.env.FAKE_AVAILABLE_BUILDINGS_SUPPORT !== '0';
  out({
    version: 'fake-1.0.0',
    chartQuestions: process.env.FAKE_CHART_SUPPORT === '1',
    chartContract: process.env.FAKE_CHART_SUPPORT === '1' ? 'ask-chart-json-v1' : undefined,
    analyticArtifact: process.env.FAKE_ANALYTIC_SUPPORT === '1' ? {
      contract: 'density.analytic-artifact.v1',
      modes: ['text', 'chart', 'slide'],
      ...(process.env.FAKE_ANALYTIC_ARCHETYPES === '1' ? { liveArchetypes: ['ranked_bars_variability', 'utilization_heatmap', 'scorecard'] } : {}),
      ...(process.env.FAKE_ANALYTIC_NO_RECEIPT_CAPABILITY === '1' ? {} : {
        evidenceReceipt: {
          contract: process.env.FAKE_ANALYTIC_RECEIPT_V1 === '1'
            ? 'density.analytic-evidence-receipt.v1'
            : 'density.analytic-evidence-receipt.v2',
          requiredForSlide: true,
          companions: process.env.FAKE_ANALYTIC_RECEIPT_V1 === '1'
            ? ['artifact', 'receipt', 'local_evidence', 'benchmark_evidence_when_used']
            : ['artifact', 'receipt', 'local_evidence', 'sensor_evidence_when_used', 'benchmark_evidence_when_used']
        }
      })
    } : undefined,
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
      questionSensorHealth: process.env.FAKE_SENSOR_HEALTH_UI === '1',
      questionSnapshotRefresh: process.env.FAKE_SNAPSHOT_REFRESH_SUPPORT !== '0',
      analyticThemePreference: process.env.FAKE_THEME_CAPABILITY !== '0',
      repairFastQuestions: true,
      vizHtml: true
    },
    htmlReports: ['building-overview', 'meeting-rooms', 'floor-usage']
  });
} else if (args[0] === 'theme' && args[1] === 'list') {
  if (process.env.FAKE_THEME_LIST_MALFORMED === '1') {
    out({ kind: 'density.analytic-theme-selections.v0', registry: themeRegistry });
  } else {
    out({
      kind: 'density.analytic-theme-selections.v1',
      registry: themeRegistry,
      presets: themePresets,
      customBrandAccent: { format: '#RRGGBB' }
    });
  }
} else if (args[0] === 'theme' && args[1] === 'get') {
  if (process.env.FAKE_THEME_GET_MALFORMED === '1') {
    out({ kind: 'density.analytic-theme-preference.v1', selected: true, selection: { theme: 'unknown' }, value: 'unknown' });
  } else {
    const value = await readThemeValue();
    out({
      kind: 'density.analytic-theme-preference.v1',
      selected: value !== null,
      selection: value === null ? null : themeSelection(value),
      value
    });
  }
} else if (args[0] === 'theme' && args[1] === 'set') {
  if (process.env.FAKE_THEME_SET_FAIL === '1') {
    console.error('theme set failed');
    process.exitCode = 1;
  } else {
    const value = String(args[2] || '');
    const selection = themeSelection(value);
    if (!selection) {
      console.error('unknown theme');
      process.exitCode = 1;
    } else {
      await mkdir(path.dirname(themeStateFile), { recursive: true });
      await writeFile(themeStateFile, JSON.stringify({ value }));
      out({ kind: 'density.analytic-theme-preference.v1', selected: true, selection, value });
    }
  }
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
          metricCoverage: { rows: 10, spaces: 3, firstDay: '2000-01-01', lastDay: '2000-01-02' },
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
  if (Number(process.env.FAKE_ASK_DELAY_MS) > 0) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_ASK_DELAY_MS)));
  }
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
  if (Number(process.env.FAKE_QUESTION_DELAY_MS) > 0) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_QUESTION_DELAY_MS)));
  }
  if (process.env.FAKE_QUESTION_UI_SUPPORT !== '1') {
    console.error('question unsupported token=super-secret-token');
    process.exitCode = 1;
  } else {
    if (process.env.FAKE_QUESTION_UI_FAIL === '1') {
      console.error('question failed');
      process.exitCode = 1;
    } else if (process.env.FAKE_QUESTION_CLARIFICATION === '1') {
      out({
        kind: 'density.agent-ui',
        renderer: 'json-render',
        schemaVersion: 1,
        clarificationRequest: {
          kind: 'density.clarification_request.v1',
          contract: 'density.clarification',
          reason: 'broad_scope_needs_resolution',
          question: 'Which measured building should I use?',
          prompt: 'Choose one measured building.',
          requiredChoiceCount: 1,
          suggestions: [{ id: 'choose_measured_building', label: 'Choose a measured building' }],
          freeform: { enabled: true, label: 'Building' },
          nextActionAfterAnswer: { id: 'answer_density_question', label: 'Answer the question' },
          responseSemantics: { answer: false, chart: false, benchmark: false, writesArtifacts: false }
        },
        jsonRender: {
          spec: {
            elements: { answer: { props: { title: 'Choose a measured building', subtitle: 'I need one building before I can build the slide.' } } },
            state: {}
          }
        },
        artifacts: { svg: null, html: null }
      });
      process.exit(0);
    }
    const cached = args.includes('--cached');
    const mixedBenchmark = process.env.FAKE_QUESTION_MIXED === '1';
    const noScope = process.env.FAKE_QUESTION_NO_SCOPE === '1';
    const cacheHit = cached && !noScope && process.env.FAKE_QUESTION_CACHE_MISS !== '1';
    const question = String(args[1] ?? '');
    const sensorHealth = process.env.FAKE_SENSOR_HEALTH_UI === '1'
      && /\\bsensors?\\b/i.test(question)
      && /\\b(?:online|offline|errors?|unconfigured|health|healthy|unhealthy|heartbeat|reporting|stale|attention)\\b/i.test(question);
    if (sensorHealth) {
      const invalidContract = process.env.FAKE_SENSOR_INVALID_CONTRACT;
      const scopeLabel = process.env.FAKE_SENSOR_SCOPE_LABEL;
      const artifactDir = path.join(process.env.DENSITY_CLI_DATA_DIR, 'artifacts', 'sensor-health');
      const svg = path.join(artifactDir, 'sensor-health.svg');
      const html = path.join(artifactDir, 'sensor-health.html');
      await mkdir(artifactDir, { recursive: true });
      await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text x="2" y="20">Example Company sensor health</text></svg>');
      await writeFile(html, '<!doctype html><title>Example Company sensor health</title>');
      out({
        kind: 'density.agent-ui',
        renderer: 'json-render',
        schemaVersion: 1,
        jsonRender: {
          spec: {
            elements: {
              answer: {
                props: {
                  title: '2 of 12 eligible Example Company sensors need attention',
                  subtitle: '10 online; 1 error; 1 unconfigured.',
                  sourceBadge: 'Live',
                  sourceLayer: 'cloud_sensor_health',
                  sourceLabel: invalidContract === 'sourceLabel' ? 'Untrusted Sensor Source' : 'Density Sensor Health',
                  effectiveScope: { organizationName: 'Example Company' },
                  freshness: {
                    source: invalidContract === 'freshness' ? 'atlas_local_metrics' : 'sensor_health_api',
                    observedAt: '2000-02-01T12:00:00.000Z',
                    mappingSnapshotAt: '2000-01-02T12:00:00.000Z'
                  },
                  confidence: { level: 'medium', reasons: ['Complete cloud response; local mapping is 30 days old.'] },
                  caveats: ['Excluded sensors without a lifecycle-eligible location path.'],
                  benchmark: { state: 'not_comparable', summary: 'Sensor health is not a utilization benchmark.' }
                  ,
                  ...(process.env.FAKE_SENSOR_PRIVATE_UI === '1' ? {
                    serial_number: 'private-serial',
                    organization_id: 'private-org',
                    secret: 'super-secret-ui'
                  } : {})
                }
              }
            },
            state: {
              answer: {
                title: invalidContract === 'answer' ? 'Mismatched title' : '2 of 12 eligible Example Company sensors need attention',
                subtitle: '10 online; 1 error; 1 unconfigured.'
              },
              chartSpec: scopeLabel ? { filters: { scope: { label: scopeLabel, type: /floor/i.test(scopeLabel) ? 'floor' : 'building' } } } : { filters: {} },
              rows: [{
                label: 'Example HQ · Multiple floors',
                value: 1,
                detail: 'Unconfigured: 1',
                ...(process.env.FAKE_SENSOR_PRIVATE_UI === '1' ? { space_id: 'private-row-space', sensor_id: 'private-row-sensor' } : {})
              }],
              sensorHealth: {
                cloudSensorCount: 15,
                eligibleSensorCount: invalidContract === 'aggregate' ? 11 : 12,
                excludedSensorCount: 3,
                statusCounts: [
                  { status: 'online', count: 10 },
                  { status: 'error', count: 1 },
                  { status: 'unconfigured', count: 1 }
                ],
                complete: invalidContract === 'complete' ? false : true,
                pageCount: 1
              },
              benchmark: { state: invalidContract === 'benchmark' ? 'unavailable' : 'not_comparable', summary: 'Sensor health is not a utilization benchmark.' },
              ...(process.env.FAKE_SENSOR_PRIVATE_UI === '1' ? {
                rawSensors: [{ uuid: 'private-uuid', mac_address: 'aa:bb:cc:dd', ip_address: '10.0.0.7', space_id: 'private-space' }]
              } : {}),
              artifacts: { svg, html }
            }
          }
        },
        artifacts: { svg, html },
        performance: { elapsedMs: 2170, targetMs: 5000 }
      });
      process.exit(0);
    }
    const metadataKind = /\\b(?:buildings?|sites?|offices?)\\b/i.test(question) && /\\b(?:live|offline|planning|planned|inactive|retired|pre[-\\s]?live|go[-\\s]?live|lifecycle|status)\\b/i.test(question)
      ? 'building_lifecycle'
      : /\\b(?:how many|count|number of)\\b/i.test(question)
          && /\\b(?:buildings?|sites?|floors?|spaces?|rooms?|phone booths?|desks?)\\b/i.test(question)
          && !/\\b(?:historical|history|trend|over time|last|past|yesterday|weekdays?|weekends?|weeks?|months?|quarters?|years?|us(?:e|ed|age)|occupied|occupancy|utili[sz](?:e|ed|ation)|performance|busiest|least used|underused|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b/i.test(question)
        ? 'local_structure'
        : /\\b(?:how fresh|last (?:sync|synced|refresh|refreshed|update|updated)|when (?:was|were).*(?:synced|refreshed|updated))\\b/i.test(question)
          ? 'local_data_freshness'
          : undefined;
    const metadataAnswer = metadataKind === 'building_lifecycle'
      ? {
          title: /\\boffline\\b/i.test(question) ? 'One Example Company site is offline' : 'Three Example Company buildings are live',
          subtitle: /\\boffline\\b/i.test(question)
            ? 'The lifecycle inventory marks one site offline.'
            : 'Example HQ, Example North, and Example South are live and past go-live; Example Future Site remains planning.',
          rows: /\\boffline\\b/i.test(question)
            ? [{ label: 'Offline site', value: 1, status: 'offline' }]
            : [
                { label: 'Example HQ', value: 1, status: 'live' },
                { label: 'Example North', value: 1, status: 'live' },
                { label: 'Example South', value: 1, status: 'live' },
                { label: 'Example Future Site', value: 0, status: 'planning' }
              ]
        }
      : metadataKind === 'local_structure'
        ? {
            title: /\\bmeeting rooms?\\b/i.test(question) ? 'Example HQ has 3 meeting rooms' : 'Example Company has 12 usable spaces',
            subtitle: /\\bmeeting rooms?\\b/i.test(question)
              ? 'The count covers live, post-go-live meeting rooms in Example HQ.'
              : 'The count covers live, post-go-live leaf spaces in the selected Example Company scope.',
            rows: /\\bmeeting rooms?\\b/i.test(question)
              ? [{ label: 'Meeting rooms', value: 3, unit: 'spaces' }]
              : [{ label: 'Usable spaces', value: 12, unit: 'leaf_spaces' }]
          }
        : metadataKind === 'local_data_freshness'
          ? {
              title: 'Example Company data is fresh through January 2',
              subtitle: 'The latest complete local metric day is January 2, 2000.',
              rows: [{ label: 'Latest complete local day', value: '2000-01-02' }]
            }
          : undefined;
    const cachedArtifactDir = path.join(process.env.DENSITY_CLI_DATA_DIR || '/tmp', 'artifacts', 'question-cache');
    const cachedSvg = path.join(cachedArtifactDir, 'cached-ui-chart.svg');
    const cachedHtml = path.join(cachedArtifactDir, 'cached-ui-chart.html');
    if (cacheHit && process.env.FAKE_QUESTION_UI_ARTIFACT_FREE !== '1') {
      const artifactState = process.env.FAKE_QUESTION_UI_ARTIFACT_STATE || 'regular';
      await mkdir(cachedArtifactDir, { recursive: true });
      if (artifactState === 'empty') {
        await writeFile(cachedSvg, '');
        await writeFile(cachedHtml, '');
      } else if (artifactState === 'directory') {
        await mkdir(cachedSvg, { recursive: true });
        await mkdir(cachedHtml, { recursive: true });
      } else if (artifactState === 'regular') {
        await writeFile(cachedSvg, '<svg>cached chart</svg>');
        await writeFile(cachedHtml, '<!doctype html><title>Cached chart</title>');
      } else if (artifactState === 'wrong_content') {
        await writeFile(cachedSvg, '<svg>replaced chart</svg>');
        await writeFile(cachedHtml, '<!doctype html><title>Replaced chart</title>');
      }
    }
    const regularCachedArtifact = cacheHit
      && ['regular', 'wrong_content'].includes(process.env.FAKE_QUESTION_UI_ARTIFACT_STATE || 'regular');
    const chartArtifacts = noScope
      ? {}
      : cacheHit && process.env.FAKE_QUESTION_UI_ARTIFACT_FREE === '1'
      ? {}
      : {
          svg: cacheHit ? cachedSvg : '/tmp/ui-chart.svg',
          html: cacheHit ? cachedHtml : '/tmp/ui-chart.html',
          ...(regularCachedArtifact
            ? {
                svgSha256: createHash('sha256').update('<svg>cached chart</svg>').digest('hex'),
                htmlSha256: createHash('sha256').update('<!doctype html><title>Cached chart</title>').digest('hex')
              }
            : {})
        };
    const analyticSlideFile = path.join(process.env.DENSITY_CLI_DATA_DIR || '/tmp', 'artifacts', 'busiest-rooms.slide.html');
    const analytic = process.env.FAKE_ANALYTIC_SUPPORT === '1' ? {
      artifact: {
        question: process.env.FAKE_ANALYTIC_MALFORMED === '1'
          ? 'a different question'
          : process.env.FAKE_ANALYTIC_CANONICAL_QUESTION === '1'
            ? 'what are the busiest rooms?'
            : question,
        response_mode: process.env.FAKE_ANALYTIC_NO_SLIDE === '1'
          || process.env.FAKE_ANALYTIC_CONTEXT_NEEDED === '1'
          || process.env.FAKE_ANALYTIC_SUPPORTED_TEXT === '1'
          ? 'text'
          : args.includes('--slide')
            ? 'slide'
            : 'chart',
        confidence: process.env.FAKE_ANALYTIC_NO_SLIDE === '1'
          ? 'blocked'
          : process.env.FAKE_ANALYTIC_CONTEXT_NEEDED === '1'
            ? 'context_needed'
            : 'supported',
        headline: 'Lincoln is the busiest room',
        subtitle: 'The validated local result supports this conclusion.',
        measured_observation: 'Lincoln recorded 42 occupied hours.',
        follow_up_question: process.env.FAKE_ANALYTIC_CONTEXT_NEEDED === '1'
          ? 'Was Lincoln reserved for a team event?'
          : null,
        data_provenance: [
          {
            id: 'local_utilization',
            input: 'atlas_local_metrics',
            class: 'density_native',
            source_detail: 'Fresh through 2000-01-02',
            ...(process.env.FAKE_ANALYTIC_PRIVATE_FIELDS === '1'
              ? { organization_id: 'private-organization-id', internal_locator: '/private/source.parquet' }
              : {})
          },
          ...(process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN === '1'
            ? [{ id: 'density_benchmark', input: 'Workplace benchmark', class: 'density_native', source_detail: 'Density Benchmark API' }]
            : [])
        ],
        source: 'Density local customer data',
        methodology: 'Ranked measured occupied hours.',
        limitations: ['The result covers the selected time window.'],
        ...((process.env.FAKE_ANALYTIC_NO_SLIDE === '1' || process.env.FAKE_ANALYTIC_CONTEXT_NEEDED === '1')
          ? { chart_data: null }
          : {}),
        ...(process.env.FAKE_ANALYTIC_QUALITY_FIELDS === '1' ? {
          metric_unit: process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'metric_unit'
            ? 42
            : 'occupied_hours',
          denominator: process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'denominator'
            ? []
            : {
                id: 'eligible_measured_room_hours',
                label: '140 available measured room-hours',
                coverage: process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'denominator_coverage'
                  ? 'invented_coverage'
                  : process.env.FAKE_ANALYTIC_DENOMINATOR_COVERAGE || 'observed_only',
                ...(process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'denominator_private'
                  ? { sourcePath: '/private/runtime/source.parquet' }
                  : {})
              },
          material_caveats: process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'material_caveats'
            ? [{ id: 'caveat_1', text: 'Measured weekdays only.' }, null]
            : [
                {
                  id: 'caveat_1',
                  text: 'Measured weekdays only.',
                  affected_claim: process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'caveat_affected_claim'
                    ? 'operational_implication'
                    : process.env.FAKE_ANALYTIC_CAVEAT_CLAIM || 'headline',
                  severity: process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'caveat_severity'
                    ? 'critical'
                    : process.env.FAKE_ANALYTIC_CAVEAT_SEVERITY || 'material',
                  ...(process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'caveat_private'
                    ? { rawRows: [{ private: 'runtime-source-row' }] }
                    : {})
                },
                ...(process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'caveat_duplicate_id'
                  ? [{ id: 'caveat_1', text: 'Duplicate id.', affected_claim: 'subtitle', severity: 'routine' }]
                  : [])
              ],
          chart_data: { rows: [{ space_id: 'private-chart-space' }] },
          ...(process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'provenance'
            ? { provenance: { sql: 'private raw provenance query' } }
            : {}),
          ...(process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD === 'raw_provenance'
            ? { raw_provenance: { source_rows: ['private-source-row'] } }
            : {})
        } : {}),
        ...(process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN === '1'
          ? { benchmark: { state: process.env.FAKE_ANALYTIC_BENCHMARK_NOT_COMPARABLE === '1' ? 'not_comparable' : 'shown' } }
          : {}),
        ...(process.env.FAKE_ANALYTIC_PRIVATE_FIELDS === '1'
          ? { runtime_internal: { organization_id: 'private-organization-id' } }
          : {})
      },
      ...(process.env.FAKE_ANALYTIC_NO_GATES === '1' ? {} : {
        gates: process.env.FAKE_ANALYTIC_BAD_GATES === '1'
          ? [
              { gate: 1, decision: 'available', reason: 'Measured data is available.' },
              { gate: 1, decision: 'duplicate', reason: 'This duplicate must fail closed.' }
            ]
          : [
              { gate: 1, decision: 'available', reason: 'Measured data is available.' },
              { gate: 2, decision: 'scoped', reason: 'The question has a measured scope.' },
              { gate: 3, decision: 'interpretable', reason: 'The measured result is interpretable.' },
              { gate: 4, decision: 'confidence_assigned', reason: 'The confidence state was assigned.' },
              { gate: 5, decision: 'observation_only', reason: 'No unsupported recommendation was added.' }
            ]
      }),
      chatHtml: '<article>Lincoln is the busiest room</article>',
      chatHtmlDark: '<article class="dark">Lincoln is the busiest room</article>',
      ...(process.env.FAKE_ANALYTIC_LEARNING_ID === '1' ? {
        learningRecordId: process.env.FAKE_ANALYTIC_BAD_LEARNING_ID === '1' ? 'not-a-learning-record' : 'lr_123e4567-e89b-12d3-a456-426614174000',
        learningWarning: 'Review this example before promotion.'
      } : {}),
      ...(args.includes('--slide')
        && process.env.FAKE_ANALYTIC_NO_SLIDE !== '1'
        && process.env.FAKE_ANALYTIC_CONTEXT_NEEDED !== '1'
        && process.env.FAKE_ANALYTIC_SUPPORTED_TEXT !== '1'
        ? { slideFile: analyticSlideFile }
        : {})
    } : undefined;
    let analyticCompanionArtifacts = {};
    if (analytic?.slideFile) {
      const failure = process.env.FAKE_ANALYTIC_RECEIPT_FAILURE;
      const artifactFile = analytic.slideFile + '.artifact.json';
      const receiptFile = analytic.slideFile + '.evidence.json';
      const localEvidenceFile = analytic.slideFile + '.local-evidence.json';
      const benchmarkEvidenceFile = analytic.slideFile + '.benchmark-evidence.json';
      const localEvidence = { rows: [{ label: 'Lincoln', value: 42 }] };
      const benchmarkEvidence = { state: 'shown', segment: 'meeting_rooms' };
      const artifactSnapshot = failure === 'artifact_mismatch'
        ? { ...analytic.artifact, headline: 'Tampered headline' }
        : analytic.artifact;
      const sources = [{
        kind: 'local_customer_data',
        source: 'Density local customer data',
        scope: 'Lincoln',
        window: { start: '2000-01-01', end: '2000-01-02' },
        evidence_sha256: failure === 'local_digest_mismatch' ? '0'.repeat(64) : analyticSha256(localEvidence),
        evidence_file: path.basename(localEvidenceFile),
        ...(process.env.FAKE_ANALYTIC_PRIVATE_FIELDS === '1'
          ? { organization_id: 'private-organization-id', internal_locator: '/private/source.parquet' }
          : {}),
        ...(failure === 'missing_provenance_ids' || process.env.FAKE_ANALYTIC_RECEIPT_V1 === '1' ? {} : {
          provenance_ids: [failure === 'unknown_provenance_id' ? 'unknown_source' : 'local_utilization']
        })
      }];
      if ((process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN === '1' && failure !== 'missing_benchmark_source')
        || failure === 'unexpected_benchmark_source') {
        sources.push({
          kind: 'density_benchmark_api',
          source: 'Density Benchmark API',
          scope: 'Lincoln',
          window: { start: '2000-01-01', end: '2000-01-02' },
          evidence_sha256: analyticSha256(benchmarkEvidence),
          evidence_file: path.basename(benchmarkEvidenceFile),
          ...(process.env.FAKE_ANALYTIC_RECEIPT_V1 === '1' ? {} : { provenance_ids: ['density_benchmark'] })
        });
      }
      const slidePresentation = '<html><body>validated slide</body></html>';
      const receipt = {
        contract: failure === 'bad_receipt_contract'
          ? 'density.analytic-evidence-receipt.v0'
          : process.env.FAKE_ANALYTIC_RECEIPT_V1 === '1'
            ? 'density.analytic-evidence-receipt.v1'
            : 'density.analytic-evidence-receipt.v2',
        generated_by: failure === 'bad_generated_by' ? 'hand_written_fixture' : 'density_question_pipeline',
        artifact_sha256: analyticSha256(analytic.artifact),
        ...(failure === 'missing_presentation_digest' || process.env.FAKE_ANALYTIC_RECEIPT_V1 === '1' ? {} : {
          presentation_sha256: failure === 'presentation_digest_mismatch'
            ? '0'.repeat(64)
            : createHash('sha256').update(slidePresentation).digest('hex')
        }),
        sources
      };
      await mkdir(path.dirname(analytic.slideFile), { recursive: true });
      const embeddedReceipt = JSON.stringify(receipt)
        .replaceAll('<', '\\u003c')
        .replaceAll('>', '\\u003e')
        .replaceAll('&', '\\u0026');
      await writeFile(analytic.slideFile, process.env.FAKE_ANALYTIC_RECEIPT_V1 === '1'
        ? slidePresentation
        : slidePresentation.replace('</body>', '<script type="application/json" id="density-analytic-evidence-receipt">' + embeddedReceipt + '</script>\\n</body>'));
      await writeFile(artifactFile, JSON.stringify(artifactSnapshot));
      await writeFile(receiptFile, JSON.stringify(receipt));
      if (failure !== 'missing_local_file') await writeFile(localEvidenceFile, JSON.stringify(localEvidence));
      if (process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN === '1') await writeFile(benchmarkEvidenceFile, JSON.stringify(benchmarkEvidence));
      analyticCompanionArtifacts = {
        slideFile: analytic.slideFile,
        analyticArtifactFile: failure === 'wrong_companion_path' ? path.join(path.dirname(artifactFile), 'wrong.artifact.json') : artifactFile,
        analyticReceiptFile: receiptFile,
        analyticLocalEvidenceFile: localEvidenceFile,
        ...(process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN === '1' && failure !== 'missing_benchmark_path'
          ? { analyticBenchmarkEvidenceFile: benchmarkEvidenceFile }
          : {})
      };
    }
    out({
      kind: 'density.agent-ui',
      renderer: 'json-render',
      schemaVersion: 1,
      jsonRender: {
        spec: {
          elements: {
            answer: {
              props: {
                title: noScope ? 'Requested place is unavailable' : (metadataAnswer?.title ?? (cacheHit ? 'Busiest rooms cached UI' : 'Busiest rooms UI')),
                subtitle: noScope ? 'Choose another place before continuing.' : (metadataAnswer?.subtitle ?? (cacheHit ? 'Local fake cached UI data' : 'Local fake UI data')),
                ...(noScope ? { scopeResolution: 'no_match' } : {}),
                ...(mixedBenchmark ? {
                  sourceBadge: 'Mixed',
                  sourceLayer: 'mixed_local_benchmark',
                  benchmark: { state: 'shown', summary: 'Approved aggregate benchmark.' }
                } : {})
              },
              ...(process.env.FAKE_ANALYTIC_STALE_ROOT_CHILDREN === '1'
                ? { children: ['chart', 'table', 'artifacts'] }
                : {})
            },
            ...(analytic ? {
              analytic: {
                type: 'DensityAnalyticCard',
                props: analytic,
                children: []
              }
            } : {})
          },
          state: {
            artifacts: chartArtifacts,
            rows: metadataAnswer?.rows,
            effectiveScope: {
              timezone: { value: 'America/New_York', source: 'space_metadata', fallbackUsed: false },
              operatingHours: process.env.FAKE_OPERATING_HOURS
                ? JSON.parse(process.env.FAKE_OPERATING_HOURS)
                : { start: 8, end: 18, label: '8am-6pm', source: 'atlas_default' },
              sourceViews: ['atlas_local_metrics', 'atlas_spaces_flat']
            },
            freshness: { firstLocalDay: '2000-01-01', lastLocalDay: '2000-01-02', source: 'atlas_local_metrics' },
            confidence: { level: 'high', reasons: ['Used atlas_local_metrics local time projections for hour/day grouping.'] },
            caveats: ['Defaulted to Atlas operating hours (8am-6pm) instead of querying all 24 hours.'],
            ...(mixedBenchmark ? { benchmark: { state: 'shown', summary: 'Approved aggregate benchmark.' } } : {})
          }
        }
      },
      artifacts: { ...chartArtifacts, ...analyticCompanionArtifacts },
      ...(analytic ? { analytic } : {}),
      ...(analytic?.slideFile ? {
        panelTarget: {
          contract: 'density.panel-target.v1',
          kind: 'analytic-slide',
          title: analytic.artifact.headline,
          report: 'analytic-slide',
          path: process.env.FAKE_ANALYTIC_BAD_TARGET === '1' ? '/tmp/a-different-slide.html' : analytic.slideFile,
          url: 'file://' + (process.env.FAKE_ANALYTIC_BAD_TARGET === '1' ? '/tmp/a-different-slide.html' : analytic.slideFile)
        }
      } : {}),
      cache: cacheHit
        ? process.env.FAKE_QUESTION_UI_PREPARED_CACHE === '1'
          ? { hit: true, type: 'prepared_metrics', fingerprint: 'prepared-fixture' }
          : { hit: true, manifest: '/tmp/starter-manifest.json' }
        : undefined,
      ...(process.env.FAKE_QUESTION_SNAPSHOT === '1' ? {
        snapshot: {
          contract: 'density.local-question-snapshot.v1',
          source: 'local_customer_data',
          live: false,
          state: 'stale',
          scope: 'all_spaces',
          staleAfterMs: 86400000,
          lastSyncAt: '2000-01-03T12:00:00.000Z',
          ageMs: 172800000,
          interval: '1h',
          backgroundRefresh: {
            state: 'started',
            lockFile: '/private/refresh.lock',
            token: 'private-token'
          }
        }
      } : {})
    });
  }
} else if (args[0] === 'learning' && args[1] === 'list') {
  const learningCount = Number(process.env.FAKE_ANALYTIC_LEARNING_COUNT || 1);
  const limit = Number(args[args.indexOf('--limit') + 1]);
  const offset = Number(args[args.indexOf('--offset') + 1]);
  const compact = args.includes('--compact');
  const allRecords = Array.from({ length: learningCount }, (_, index) => ({
    id: index === 0
      ? 'lr_123e4567-e89b-12d3-a456-426614174000'
      : 'lr_00000000-0000-4000-8000-' + String(index).padStart(12, '0'),
    recorded_at: new Date(Date.UTC(2026, 6, 12, 20, index)).toISOString(),
    record_type: 'artifact_review',
    measured_observation: index === 0 ? 'Lincoln is the busiest room.' : 'Learning record ' + (index + 1) + '.',
    follow_up_question: null,
    artifact_ref: 'sha256:' + String(index % 10).repeat(64),
    ...(compact ? {} : { artifact_snapshot: { question: 'what are the busiest rooms?', index } })
  })).reverse();
  const records = allRecords.slice(offset, offset + limit);
  out({
    records,
    limit,
    offset,
    total: allRecords.length,
    hasMore: offset + records.length < allRecords.length,
    ...(offset + records.length < allRecords.length ? { nextOffset: offset + records.length } : {}),
    corruptLines: []
  });
} else if (args[0] === 'learning' && (args[1] === 'review' || args[1] === 'resolve')) {
  console.log('Reviewed learning record ' + args[args.indexOf('--id') + 1] + '.');
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

const waitFor = async (predicate, { timeoutMs = 3000, intervalMs = 50 } = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
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

    const dataDir = path.join(tempDir, 'data');
    const result = await askChart({ question: 'what are the busiest rooms?', dataDir });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.title, 'Busiest rooms cached UI');
    assert.equal(result.subtitle, 'Local fake cached UI data');
    assert.equal(result.chart, path.join(dataDir, 'artifacts', 'question-cache', 'cached-ui-chart.svg'));
    assert.equal(result.html, path.join(dataDir, 'artifacts', 'question-cache', 'cached-ui-chart.html'));
    assert.equal(result.cache.hit, true);
    assert.equal(result.cache.manifest, '/tmp/starter-manifest.json');
    assert.equal(result.effectiveScope.timezone.value, 'America/New_York');
    assert.equal(result.freshness.source, 'atlas_local_metrics');
    assert.equal(result.confidence.level, 'high');
    assert.match(result.caveats.join(' '), /Atlas operating hours/);
    assert.equal(result.ui.kind, 'density.agent-ui');
    assert.equal(Object.hasOwn(result, 'analytic'), false);
    assert.equal(Object.hasOwn(result, 'panelTarget'), false);
    assert.ok(calls.some((args) => args[0] === 'question' && args.includes('--cached') && args.includes('--chart') && args.includes('--format') && args.includes('ui')));
    assert.equal(calls.some((args) => args[0] === 'question' && args.includes('--slide')), false);
    assert.equal(calls.some((args) => args[0] === 'question' && !args.includes('--cached') && args.includes('--chart') && args.includes('--format') && args.includes('ui')), false);
  });
});

test('askChart passes through analytic UI data only when the runtime advertises it', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_CANONICAL_QUESTION = '1';

    const result = await askChart({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'data'),
      presentation: 'slide',
    });
    const questionCall = (await readFakeLog(logFile)).find((args) => args[0] === 'question');

    assert.equal(result.analytic.artifact.headline, 'Lincoln is the busiest room');
    assert.deepEqual(result.analytic.gates.map(({ gate }) => gate), [1, 2, 3, 4, 5]);
    assert.match(result.analytic.chatHtmlDark, /Lincoln/);
    assert.equal(questionCall.includes('--slide'), true);
    assert.equal(result.panelTarget.kind, 'analytic-slide');
  });
});

test('answerDensityQuestion defaults to a slide for an analytic-capable runtime', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_LEARNING_ID = '1';
    process.env.FAKE_ANALYTIC_ARCHETYPES = '1';
    process.env.FAKE_ANALYTIC_QUALITY_FIELDS = '1';

    const result = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'data'),
    });
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');

    assert.equal(questionCalls.length, 1);
    assert.equal(questionCalls[0].includes('--slide'), true);
    assert.equal(questionCalls[0].includes('--chart'), false);
    assert.equal(result.analytic.artifact.response_mode, 'slide');
    assert.equal(result.panelTarget.kind, 'analytic-slide');
    assert.equal(result.panelTarget.path, result.analytic.slideFile);
    assert.deepEqual(result.presentationDelivery, {
      requested: 'slide',
      generated: 'slide',
      delivered: 'none',
      slideSupported: true,
      reason: 'The validated slide was generated and awaits a user-visible host attachment.',
    });
    assert.equal(result.learningRecordId, 'lr_123e4567-e89b-12d3-a456-426614174000');
    assert.equal(result.learningWarning, 'Review this example before promotion.');
    assert.equal(result.trustContext.confidence, 'supported');
    assert.deepEqual(result.capabilities.analyticArtifact.liveArchetypes, ['ranked_bars_variability', 'utilization_heatmap', 'scorecard']);
    assert.deepEqual(result.trustContext.liveArchetypes, ['ranked_bars_variability', 'utilization_heatmap', 'scorecard']);
    assert.equal(Object.hasOwn(result.ui, 'analytic'), false);
    const analyticCard = result.ui.jsonRender.spec.elements.analytic;
    assert.equal(analyticCard.type, 'DensityAnalyticCard');
    assert.deepEqual(analyticCard.props, result.analytic);
    assert.match(analyticCard.props.chatHtml, /Lincoln/);
    assert.match(analyticCard.props.chatHtmlDark, /Lincoln/);
    assert.equal(result.analytic.artifact.metric_unit, 'occupied_hours');
    assert.deepEqual(result.analytic.artifact.denominator, {
      id: 'eligible_measured_room_hours',
      label: '140 available measured room-hours',
      coverage: 'observed_only',
    });
    assert.deepEqual(result.analytic.artifact.material_caveats, [{
      id: 'caveat_1',
      text: 'Measured weekdays only.',
      affected_claim: 'headline',
      severity: 'material',
    }]);
    assert.deepEqual(result.analytic.artifact.chart_data, { rows: [{ space_id: 'private-chart-space' }] });
    for (const field of ['provenance', 'raw_provenance']) {
      assert.equal(Object.hasOwn(result.analytic.artifact, field), false, `${field} must remain private`);
      assert.equal(Object.hasOwn(analyticCard.props.artifact, field), false, `${field} must remain private in the UI card`);
    }
    assert.doesNotMatch(JSON.stringify(result), /private raw provenance query|private-source-row/);
    assert.equal((JSON.stringify(result).match(/"artifact":/g) ?? []).length, 2);
    assert.equal(result.analytic.analyticReceiptFile, `${result.analytic.slideFile}.evidence.json`);
    assert.equal(result.analytic.analyticArtifactFile, `${result.analytic.slideFile}.artifact.json`);
    assert.equal(result.analytic.analyticLocalEvidenceFile, `${result.analytic.slideFile}.local-evidence.json`);
    assert.equal(result.trustContext.evidenceReceipt.analyticReceiptFile, result.analytic.analyticReceiptFile);
    assert.equal(result.trustContext.evidenceReceipt.generated_by, 'density_question_pipeline');
    assert.equal(
      analyticArtifactSha256(result.analytic.artifact),
      result.trustContext.evidenceReceipt.artifact_sha256,
      'the returned artifact must match the accepted receipt digest',
    );
  });
});

test('answerDensityQuestion preserves Broadsheet as an explicit chart variant', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_ARCHETYPES = '1';
    process.env.FAKE_ANALYTIC_QUALITY_FIELDS = '1';

    const result = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'data'),
      presentation: 'broadsheet',
    });
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');

    assert.equal(questionCalls.length, 1);
    assert.equal(questionCalls[0].includes('--chart'), true);
    assert.equal(questionCalls[0].includes('--slide'), false);
    assert.equal(Object.hasOwn(result, 'panelTarget'), false);
    assert.equal(Object.hasOwn(result, 'presentationDelivery'), false);
  });
});

test('answerDensityQuestion returns only allowlisted analytic and receipt fields', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_PRIVATE_FIELDS = '1';

    const result = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'data'),
      presentation: 'slide',
    });

    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.analytic.artifact, 'runtime_internal'), false);
    assert.deepEqual(result.analytic.artifact.data_provenance, [{
      id: 'local_utilization',
      input: 'atlas_local_metrics',
      class: 'density_native',
      source_detail: 'Fresh through 2000-01-02',
    }]);
    assert.deepEqual(Object.keys(result.trustContext.evidenceReceipt.sources[0]).sort(), [
      'evidence_file',
      'evidence_sha256',
      'kind',
      'provenance_ids',
      'scope',
      'source',
      'window',
    ]);
    assert.doesNotMatch(JSON.stringify(result), /private-organization-id|private\/source\.parquet/);

    const rawArtifact = JSON.parse(await readFile(result.analytic.analyticArtifactFile, 'utf8'));
    assert.equal(rawArtifact.runtime_internal.organization_id, 'private-organization-id');
    assert.equal(
      analyticArtifactSha256(rawArtifact),
      result.trustContext.evidenceReceipt.artifact_sha256,
      'the accepted receipt must still match the runtime artifact that was validated before public projection',
    );
  });
});

test('answerDensityQuestion rejects malformed or unsafe additive analytic quality fields', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_QUALITY_FIELDS = '1';

    const invalidCases = [
      ['metric_unit', /metric_unit/i],
      ['denominator', /denominator/i],
      ['denominator_coverage', /denominator\.coverage/i],
      ['denominator_private', /denominator.*unknown.*sourcePath/i],
      ['material_caveats', /material_caveats/i],
      ['caveat_affected_claim', /affected_claim/i],
      ['caveat_severity', /severity/i],
      ['caveat_private', /material_caveats.*unknown.*rawRows/i],
      ['caveat_duplicate_id', /duplicate.*caveat_1/i],
      ['provenance', /provenance.*not part of the analytic artifact contract/i],
      ['raw_provenance', /raw_provenance.*not part of the analytic artifact contract/i],
    ];
    for (const [field, expected] of invalidCases) {
      process.env.FAKE_ANALYTIC_INVALID_QUALITY_FIELD = field;
      await assert.rejects(answerDensityQuestion({
        question: 'what are the busiest rooms?',
        dataDir: path.join(tempDir, `invalid-${field}`),
        presentation: 'slide',
      }), expected);
    }
  });
});

test('answerDensityQuestion remains compatible when additive analytic quality fields are absent', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const result = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'without-quality-fields'),
      presentation: 'slide',
    });

    for (const field of ['metric_unit', 'denominator', 'material_caveats']) {
      assert.equal(Object.hasOwn(result.analytic.artifact, field), false);
    }
  });
});

test('answerDensityQuestion suppresses stale root children when a decision-support card owns a blocked or context-needed answer', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_STALE_ROOT_CHILDREN = '1';

    for (const state of ['FAKE_ANALYTIC_CONTEXT_NEEDED', 'FAKE_ANALYTIC_NO_SLIDE']) {
      process.env[state] = '1';
      const result = await answerDensityQuestion({
        question: 'what are the busiest rooms?',
        dataDir: path.join(tempDir, state),
        presentation: 'slide',
      });
      assert.deepEqual(result.ui.jsonRender.spec.elements.answer.children, ['analytic'], state);
      delete process.env[state];
    }

    process.env.FAKE_ANALYTIC_SUPPORTED_TEXT = '1';
    const supportedText = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'supported-text'),
      presentation: 'slide',
    });
    assert.deepEqual(supportedText.ui.jsonRender.spec.elements.answer.children, ['chart', 'table', 'artifacts']);
  });
});

test('answerDensityQuestion accepts every additive analytic quality enum from the CLI contract', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_QUALITY_FIELDS = '1';

    for (const coverage of ['observed_only', 'complete_inventory_required', 'missing_preserved', 'exact_scope_required']) {
      process.env.FAKE_ANALYTIC_DENOMINATOR_COVERAGE = coverage;
      const result = await answerDensityQuestion({
        question: 'what are the busiest rooms?',
        dataDir: path.join(tempDir, `coverage-${coverage}`),
        presentation: 'slide',
      });
      assert.equal(result.analytic.artifact.denominator.coverage, coverage);
    }

    for (const affectedClaim of ['headline', 'subtitle', 'interpretation']) {
      process.env.FAKE_ANALYTIC_CAVEAT_CLAIM = affectedClaim;
      const result = await answerDensityQuestion({
        question: 'what are the busiest rooms?',
        dataDir: path.join(tempDir, `claim-${affectedClaim}`),
        presentation: 'slide',
      });
      assert.equal(result.analytic.artifact.material_caveats[0].affected_claim, affectedClaim);
    }

    for (const severity of ['material', 'routine']) {
      process.env.FAKE_ANALYTIC_CAVEAT_SEVERITY = severity;
      const result = await answerDensityQuestion({
        question: 'what are the busiest rooms?',
        dataDir: path.join(tempDir, `severity-${severity}`),
        presentation: 'slide',
      });
      assert.equal(result.analytic.artifact.material_caveats[0].severity, severity);
    }
  });
});

test('answerDensityQuestion rejects malformed analytic gates and panel targets on the shared slide path', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_BAD_TARGET = '1';

    await assert.rejects(answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'bad-target'),
      presentation: 'slide',
    }), /panelTarget\.path/i);

    delete process.env.FAKE_ANALYTIC_BAD_TARGET;
    process.env.FAKE_ANALYTIC_BAD_GATES = '1';
    await assert.rejects(answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'bad-gates'),
      presentation: 'slide',
    }), /analytic\.gates/i);
  });
});

test('answerDensityQuestion reports a validated text fallback as unsupported_mode for a slide request', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeConverter = path.join(tempDir, 'rsvg-convert');
    const converterLog = path.join(tempDir, 'rsvg.log');
    await writeFakeCli(fakeCli);
    await writeFile(fakeConverter, '#!/bin/sh\necho called >> "$FAKE_RSVG_LOG"\nexit 0\n');
    await chmod(fakeConverter, 0o755);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_RSVG_LOG = converterLog;
    process.env.PATH = `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORTED_TEXT = '1';

    const result = await answerDensityQuestion({
      question: 'what time are rooms busiest?',
      dataDir: path.join(tempDir, 'data'),
      presentation: 'slide',
    });

    assert.equal(result.ok, false);
    assert.equal(result.unsupportedMode, true);
    assert.equal(result.analyticState, 'unsupported_mode');
    assert.equal(result.deliveredMode, 'text');
    assert.equal(result.presentationDelivery.requested, 'slide');
    assert.equal(result.presentationDelivery.delivered, 'text');
    assert.match(result.presentationDelivery.reason, /validated text answer/i);
    assert.equal(await which('rsvg-convert'), fakeConverter);
    assert.equal(result.png, undefined);
    assert.equal(result.performance.pngMs, 0);
    await assert.rejects(readFile(converterLog, 'utf8'), { code: 'ENOENT' });
  });
});

test('answerDensityQuestion preserves the old result shape and flags without analytic capability', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'data'),
      presentation: 'slide',
    });
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');

    assert.equal(questionCalls.length, 1);
    assert.equal(questionCalls[0].includes('--slide'), false);
    assert.equal(questionCalls[0].includes('--chart'), true);
    assert.equal(Object.hasOwn(result, 'analytic'), false);
    assert.equal(Object.hasOwn(result, 'panelTarget'), false);
    assert.deepEqual(result.presentationDelivery, {
      requested: 'slide',
      delivered: 'chart',
      slideSupported: false,
      reason: 'The installed Density runtime does not advertise validated slide support.',
    });
  });
});

test('answerDensityQuestion fails closed on a failed theme capability probe and retries discovery', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_CAPABILITIES_FAIL = '1';

    const fallback = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir,
    });
    assert.equal((await readFakeLog(logFile)).some((args) => args[0] === 'question'), false);
    assert.equal(fallback.ok, false);
    assert.equal(fallback.reason, 'analytic_theme_preference_unsupported');

    delete process.env.FAKE_CAPABILITIES_FAIL;
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    const retried = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir,
    });
    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');
    assert.equal(calls.filter((args) => args[0] === 'capabilities').length, 2);
    assert.equal(questionCalls.at(-1).includes('--slide'), true);
    assert.equal(retried.presentationDelivery.generated, 'slide');
    assert.equal(retried.presentationDelivery.delivered, 'none');
  });
});

test('answerDensityQuestion discovers slide capability once for the native default', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const result = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'data'),
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(calls.filter((args) => args[0] === 'capabilities').length, 1);
    assert.equal(calls.filter((args) => args[0] === 'question').length, 1);
    assert.equal(result.presentationDelivery.requested, 'slide');
  });
});

test('answerDensityQuestion passes through a formal runtime clarification without treating it as an answer', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_CLARIFICATION = '1';

    const result = await answerDensityQuestion({
      question: 'which location should we analyze?',
      dataDir: path.join(tempDir, 'data'),
    });

    assert.equal(result.ok, false);
    assert.equal(result.kind, 'density.clarification_request.v1');
    assert.equal(result.contract, 'density.clarification');
    assert.equal(result.clarificationRequest.prompt, 'Choose one measured building.');
    assert.equal(result.responseSemantics.answer, false);
    assert.equal(result.chart, undefined);
    assert.equal(result.html, undefined);
    assert.equal(result.png, undefined);
  });
});

test('answerDensityQuestion resumes a clarification through the same front door', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_CLARIFICATION = '1';

    const question = 'which location should we analyze?';
    const first = await answerDensityQuestion({ question, dataDir: path.join(tempDir, 'data') });
    assert.equal(first.kind, 'density.clarification_request.v1');

    process.env.FAKE_QUESTION_CLARIFICATION = '0';
    const resumed = await answerDensityQuestion({
      question,
      clarificationAnswer: 'Use Live HQ',
      dataDir: path.join(tempDir, 'data'),
    });
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');

    assert.equal(resumed.ok, true);
    assert.equal(resumed.question, question);
    assert.equal(resumed.clarificationAnswer, 'Use Live HQ');
    assert.equal(questionCalls.length, 2);
    assert.equal(questionCalls[1][1], `${question} User clarification: Use Live HQ`);
  });
});

test('answerDensityQuestion stops after two native question failures without legacy fallback', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_FAIL = '1';

    const result = await answerDensityQuestion({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'data'),
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.retryBudget, { attempts: 2, exhausted: true });
    assert.equal(calls.filter((args) => args[0] === 'question').length, 2);
    assert.equal(calls.filter((args) => args[0] === 'ask').length, 0);
  });
});

test('analyticSlide returns the validated slide summary and panel target', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_LEARNING_ID = '1';

    const dataDir = path.join(tempDir, 'data');
    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir });
    const questionCall = (await readFakeLog(logFile)).find((args) => args[0] === 'question');

    assert.deepEqual(questionCall, ['question', 'what are the busiest rooms?', '--slide', '--format', 'ui']);
    assert.equal(result.ok, true);
    assert.equal(result.slidePath, path.join(dataDir, 'artifacts', 'busiest-rooms.slide.html'));
    assert.equal(result.panelTarget.kind, 'analytic-slide');
    assert.equal(result.headline, 'Lincoln is the busiest room');
    assert.equal(result.subtitle, 'The validated local result supports this conclusion.');
    assert.equal(result.confidence, 'supported');
    assert.equal(result.validationState, 'rendered');
    assert.equal(result.requestedMode, 'slide');
    assert.equal(result.generatedMode, 'slide');
    assert.equal(result.deliveredMode, 'none');
    assert.equal(result.deliveryState, 'generated');
    assert.equal(result.trustContext.confidence, 'supported');
    assert.deepEqual(result.trustContext.gates.map(({ gate }) => gate), [1, 2, 3, 4, 5]);
    assert.deepEqual(result.trustContext.dataProvenance, [{ id: 'local_utilization', input: 'atlas_local_metrics', class: 'density_native', source_detail: 'Fresh through 2000-01-02' }]);
    assert.equal(result.trustContext.methodology, 'Ranked measured occupied hours.');
    assert.equal(result.learningRecordId, 'lr_123e4567-e89b-12d3-a456-426614174000');
    assert.equal(result.learningWarning, 'Review this example before promotion.');
    assert.equal(result.reviewNextAction.tool, 'review_analytic_learning');
    assert.equal(result.reviewNextAction.args.id, result.learningRecordId);
    assert.equal(result.analyticArtifactFile, `${result.slidePath}.artifact.json`);
    assert.equal(result.analyticReceiptFile, `${result.slidePath}.evidence.json`);
    assert.equal(result.analyticLocalEvidenceFile, `${result.slidePath}.local-evidence.json`);
    assert.equal(result.evidenceReceipt.artifact_sha256, result.trustContext.evidenceReceipt.artifact_sha256);
  });
});

test('analyticSlide returns supported text as unsupported_mode instead of invalid', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORTED_TEXT = '1';

    const result = await analyticSlide({ question: 'what time are rooms busiest?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.unsupportedMode, true);
    assert.equal(result.validationState, 'rendered');
    assert.equal(result.analyticState, 'unsupported_mode');
    assert.equal(result.requestedMode, 'slide');
    assert.equal(result.deliveredMode, 'text');
    assert.equal(result.confidence, 'supported');
    assert.match(result.message, /validated text answer/i);
  });
});

test('analyticSlide rejects malformed learning record ids', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_LEARNING_ID = '1';
    process.env.FAKE_ANALYTIC_BAD_LEARNING_ID = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });
    assert.equal(result.ok, false);
    assert.equal(result.validationState, 'invalid');
    assert.match(result.message, /learningRecordId/i);
  });
});

test('analyticSlide does not send an unsupported slide flag to an older runtime', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
    assert.equal(result.requestedMode, 'slide');
    assert.equal(result.deliveredMode, 'none');
    assert.equal(calls.some((args) => args[0] === 'question'), false);
  });
});

test('analyticSlide remains compatible when an analytic-capable older runtime omits gates and learning ids', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_NO_GATES = '1';
    process.env.FAKE_ANALYTIC_NO_RECEIPT_CAPABILITY = '1';
    process.env.FAKE_ANALYTIC_RECEIPT_FAILURE = 'missing_local_file';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, true);
    assert.deepEqual(result.trustContext.gates, []);
    assert.equal(Object.hasOwn(result, 'learningRecordId'), false);
    assert.equal(Object.hasOwn(result, 'reviewNextAction'), false);
  });
});

test('analyticSlide validates trusted receipt companions and benchmark evidence from live runtime files', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'benchmark-slide');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir });

    assert.equal(result.ok, true);
    assert.equal(result.analyticBenchmarkEvidenceFile, `${result.slidePath}.benchmark-evidence.json`);
    assert.deepEqual(result.evidenceReceipt.sources.map(({ kind }) => kind), [
      'local_customer_data',
      'density_benchmark_api',
    ]);
    assert.equal(result.trustContext.evidenceReceipt.analyticBenchmarkEvidenceFile, result.analyticBenchmarkEvidenceFile);
  });
});

test('analyticSlide remains compatible with the pinned receipt v1 managed runtime', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_RECEIPT_V1 = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.unsupportedMode, true);
    assert.equal(result.deliveredMode, 'text');
    assert.equal(Object.hasOwn(result, 'slidePath'), false);
    assert.equal(Object.hasOwn(result, 'panelTarget'), false);
  });
});

test('analyticSlide validates benchmark evidence used by the pipeline when the chart comparison is not comparable', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'benchmark-not-comparable-slide');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN = '1';
    process.env.FAKE_ANALYTIC_BENCHMARK_NOT_COMPARABLE = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir });

    assert.equal(result.ok, true);
    const artifact = JSON.parse(await readFile(result.analyticArtifactFile, 'utf8'));
    assert.equal(artifact.benchmark.state, 'not_comparable');
    assert.equal(result.analyticBenchmarkEvidenceFile, `${result.slidePath}.benchmark-evidence.json`);
    assert.deepEqual(result.evidenceReceipt.sources.map(({ kind }) => kind), [
      'local_customer_data',
      'density_benchmark_api',
    ]);
  });
});

test('analyticSlide fails closed when trusted receipt companions or digests do not match', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const cases = [
      ['missing_local_file', /analyticLocalEvidenceFile could not be read/i],
      ['artifact_mismatch', /artifact companion did not match/i],
      ['local_digest_mismatch', /source local_customer_data did not match/i],
      ['bad_receipt_contract', /trusted question pipeline contract/i],
      ['bad_generated_by', /trusted question pipeline contract/i],
      ['missing_presentation_digest', /trusted question pipeline contract/i],
      ['presentation_digest_mismatch', /presentation digest did not match/i],
      ['missing_provenance_ids', /source local_customer_data did not match/i],
      ['unknown_provenance_id', /unknown provenance id/i],
      ['wrong_companion_path', /analyticArtifactFile must be/i],
      ['unexpected_benchmark_source', /exact local, sensor-health, and benchmark sources used/i],
    ];
    for (const [failure, message] of cases) {
      process.env.FAKE_ANALYTIC_RECEIPT_FAILURE = failure;
      delete process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN;
      const result = await analyticSlide({
        question: 'what are the busiest rooms?',
        dataDir: path.join(tempDir, `failure-${failure}`),
      });
      assert.equal(result.ok, false, failure);
      assert.equal(result.validationState, 'invalid', failure);
      assert.match(result.message, message, failure);
    }

    process.env.FAKE_ANALYTIC_BENCHMARK_SHOWN = '1';
    for (const failure of ['missing_benchmark_path', 'missing_benchmark_source']) {
      process.env.FAKE_ANALYTIC_RECEIPT_FAILURE = failure;
      const result = await analyticSlide({
        question: 'what are the busiest rooms?',
        dataDir: path.join(tempDir, `failure-${failure}`),
      });
      assert.equal(result.ok, false, failure);
      assert.equal(result.validationState, 'invalid', failure);
      assert.match(result.message, /analyticBenchmarkEvidenceFile is missing|exact local, sensor-health, and benchmark sources used/i, failure);
    }
  });
});

test('analyticSlide preserves a validated blocked result without inventing a slide', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_NO_SLIDE = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.confidence, 'blocked');
    assert.equal(result.validationState, 'rendered');
    assert.equal(result.trustContext.responseMode, 'text');
    assert.equal(result.deliveredMode, 'text');
    assert.equal(Object.hasOwn(result, 'slidePath'), false);
    assert.equal(Object.hasOwn(result, 'panelTarget'), false);
  });
});

test('analyticSlide preserves a formal clarification request', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_QUESTION_CLARIFICATION = '1';

    const result = await analyticSlide({ question: 'compare any one site', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.analyticState, 'clarification_required');
    assert.equal(result.validationState, 'clarification_required');
    assert.equal(result.requestedMode, 'slide');
    assert.equal(result.deliveredMode, 'clarification');
    assert.equal(result.clarificationRequest.contract, 'density.clarification');
    assert.equal(result.clarificationRequest.responseSemantics.answer, false);
    assert.equal(result.message, 'Choose one measured building.');
  });
});

test('analyticSlide preserves context-needed evidence and its follow-up question', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_CONTEXT_NEEDED = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.analyticState, 'context_needed');
    assert.equal(result.confidence, 'context_needed');
    assert.equal(result.validationState, 'rendered');
    assert.equal(result.requestedMode, 'slide');
    assert.equal(result.deliveredMode, 'text');
    assert.equal(result.measuredObservation, 'Lincoln recorded 42 occupied hours.');
    assert.equal(result.followUpQuestion, 'Was Lincoln reserved for a team event?');
    assert.equal(result.trustContext.confidence, 'context_needed');
    assert.equal(result.trustContext.responseMode, 'text');
  });
});

test('analyticSlide applies one wall deadline across capability discovery and rendering', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_CAPABILITY_DELAY_MS = '100';
    process.env.FAKE_QUESTION_DELAY_MS = '450';

    const startedAt = Date.now();
    const result = await analyticSlide({
      question: 'what are the busiest rooms?',
      dataDir: path.join(tempDir, 'data'),
      timeoutMs: 500,
    });
    const elapsedMs = Date.now() - startedAt;
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.requestedMode, 'slide');
    assert.equal(result.deliveredMode, 'none');
    assert.ok(elapsedMs < 700, `expected one 500ms budget, got ${elapsedMs}ms`);
    assert.equal(calls.filter((args) => args[0] === 'capabilities').length, 1);
    assert.equal(calls.filter((args) => args[0] === 'question').length, 1);
  });
});

test('analyticSlide fails closed when the runtime artifact question does not match', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_MALFORMED = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.validationState, 'invalid');
    assert.equal(result.analyticState, 'invalid');
    assert.match(result.message, /artifact\.question/i);
    assert.equal(Object.hasOwn(result, 'slidePath'), false);
  });
});

test('analyticSlide accepts case and terminal punctuation differences for the same cached question', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_CANONICAL_QUESTION = '1';
    const result = await analyticSlide({ question: 'What Are The Busiest Rooms', dataDir: path.join(tempDir, 'data') });
    assert.equal(result.ok, true);
  });
});

test('analyticSlide rejects a panel target that does not point at the validated slide', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_BAD_TARGET = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.validationState, 'invalid');
    assert.match(result.message, /panelTarget\.path/i);
    assert.equal(Object.hasOwn(result, 'slidePath'), false);
  });
});

test('analyticSlide rejects duplicate or incomplete analytic gates', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_BAD_GATES = '1';

    const result = await analyticSlide({ question: 'what are the busiest rooms?', dataDir: path.join(tempDir, 'data') });

    assert.equal(result.ok, false);
    assert.equal(result.validationState, 'invalid');
    assert.match(result.message, /analytic\.gates/i);
    assert.equal(Object.hasOwn(result, 'slidePath'), false);
  });
});

test('analyticSlide rejects malformed question and dataDir inputs before invoking the runtime', async () => {
  await assert.rejects(analyticSlide({ question: { text: 'busiest rooms' } }), /question is required/);
  await assert.rejects(analyticSlide({ question: 'busiest rooms\0', dataDir: '/tmp/data' }), /null bytes/);
  await assert.rejects(analyticSlide({ question: 'busiest rooms', dataDir: '/tmp/data\0escape' }), /null bytes/);
});

test('analytic_slide MCP tool returns the presentation-ready contract', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    const browserLog = path.join(tempDir, 'browser.log');
    await writeFakeCli(fakeCli);
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_HTML_SCREENSHOT_LOG = browserLog;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    const dataDir = path.join(tempDir, 'slide-data');

    const result = await callMcp('tools/call', {
      name: 'analytic_slide',
      arguments: { question: 'what are the busiest rooms?', dataDir, timeoutMs: 5000 },
    });
    const payload = result.structuredContent;
    const htmlPath = path.join(dataDir, 'artifacts', 'busiest-rooms.slide.html');
    const pngPath = path.join(dataDir, 'artifacts', 'busiest-rooms.slide.png');
    const image = result.content.find((block) => block.type === 'image');
    const resource = result.content.find((block) => block.type === 'resource_link');

    assert.equal(payload.ok, true);
    assert.equal(payload.slideDelivery.canonical.path, htmlPath);
    assert.equal(payload.slideDelivery.canonical.sha256, await sha256File(htmlPath));
    assert.equal(payload.slideDelivery.preview.artifact.path, pngPath);
    assert.equal(payload.slideDelivery.preview.artifact.sha256, await sha256File(pngPath));
    assert.equal(payload.panelTarget.kind, 'analytic-slide');
    assert.equal(payload.slidePath, htmlPath);
    assert.equal(payload.dataDir, dataDir);
    assert.equal(payload.evidenceReceipt.contract, 'density.analytic-evidence-receipt.v2');
    assert.equal(Array.isArray(payload.gates), true);
    assert.equal(payload.validationState, 'rendered');
    assert.equal(payload.requestedMode, 'slide');
    assert.equal(payload.deliveredMode, 'slide');
    assert.equal(payload.deliveryState, 'delivered');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(resource.mimeType, 'text/html');
    assert.equal(resource.uri, pathToFileURL(htmlPath).href);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 12000);
    assert.ok(Buffer.byteLength(result.content[0].text) < 12000);
    const rendererArgs = JSON.parse((await readFile(browserLog, 'utf8')).trim());
    const profileArg = rendererArgs.find((arg) => arg.startsWith('--user-data-dir='));
    assert.equal(rendererArgs.includes('--window-size=1920,1080'), true);
    assert.equal(rendererArgs.includes('--password-store=basic'), true);
    assert.equal(rendererArgs.includes('--use-mock-keychain'), true);
    assert.equal(rendererArgs.includes('--no-first-run'), true);
    assert.ok(profileArg);
    await assert.rejects(access(profileArg.slice('--user-data-dir='.length)), { code: 'ENOENT' });
    assert.equal(rendererArgs.includes(pathToFileURL(htmlPath).href), true);
  });
});

test('HTML preview keeps a complete PNG when the renderer does not exit', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    const htmlFile = path.join(tempDir, 'slide.html');
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    await writeFile(htmlFile, '<!doctype html><title>Density</title>');
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_HTML_SCREENSHOT_STALL_MS = '1000';
    const startedAt = Date.now();

    const result = await renderHtmlPreview(htmlFile, { timeoutMs: 250 });

    assert.equal(result.status, 'available');
    assert.equal(result.width, 1920);
    assert.equal(result.height, 1080);
    assert.ok(Date.now() - startedAt < 750);
  });
});

test('answer_density_question MCP delivery is compact and falls back honestly to canonical HTML without a PNG renderer', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = path.join(tempDir, 'missing-browser');
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    const dataDir = path.join(tempDir, 'answer-data');

    const result = await callMcp('tools/call', {
      name: 'answer_density_question',
      arguments: { question: 'what are the busiest rooms?', dataDir },
    });
    const payload = result.structuredContent;
    const htmlPath = path.join(dataDir, 'artifacts', 'busiest-rooms.slide.html');

    assert.equal(payload.ok, true);
    assert.equal(payload.presentationDelivery.generated, 'slide');
    assert.equal(payload.presentationDelivery.delivered, 'slide');
    assert.equal(payload.slideDelivery.status, 'delivered');
    assert.equal(payload.slideDelivery.preview.status, 'unavailable');
    assert.match(payload.slideDelivery.preview.reason, /renderer.*unavailable/i);
    assert.equal(result.content.some((block) => block.type === 'image'), false);
    const resource = result.content.find((block) => block.type === 'resource_link');
    assert.equal(resource.uri, pathToFileURL(htmlPath).href);
    assert.equal(resource.mimeType, 'text/html');
    assert.equal(payload.slideDelivery.canonical.sha256, await sha256File(htmlPath));
    assert.deepEqual(payload.orchestration, {
      state: 'complete',
      terminal: true,
      retryable: false,
      awaitingUser: false,
    });
    assert.equal(Object.hasOwn(payload, 'reviewNextAction'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 12000);
    assert.equal(JSON.stringify(result).includes('private raw provenance query'), false);
  });
});

test('answer_density_question compact ordinary results expose only the follow-up rewrite disclosure', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    const dataDir = path.join(tempDir, 'ordinary-follow-up-data');

    const [, result] = await callMcpRequests([
      {
        method: 'tools/call',
        params: {
          name: 'answer_density_question',
          arguments: { question: 'what is the most popular conference room size in Metro Tower?', dataDir },
        },
      },
      {
        method: 'tools/call',
        params: {
          name: 'answer_density_question',
          arguments: { question: 'what about phone booths?', dataDir },
        },
      },
    ]);

    assert.deepEqual(result.structuredContent.followUp, {
      effectiveQuestion: 'what is the most popular phone booth size in Metro Tower?',
      reason: 'The question depended on the previous analytics answer, so the plugin preserved the prior scope and metric context before calling the CLI.',
    });
  });
});

test('answer_density_question compact slide results expose only the follow-up rewrite disclosure', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    await writeFakeCli(fakeCli);
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    const dataDir = path.join(tempDir, 'slide-follow-up-data');

    const [, result] = await callMcpRequests([
      {
        method: 'tools/call',
        params: {
          name: 'answer_density_question',
          arguments: { question: 'what is the most popular conference room size in Metro Tower?', dataDir },
        },
      },
      {
        method: 'tools/call',
        params: {
          name: 'answer_density_question',
          arguments: { question: 'what about phone booths?', dataDir },
        },
      },
    ]);

    assert.deepEqual(result.structuredContent.followUp, {
      effectiveQuestion: 'what is the most popular phone booth size in Metro Tower?',
      reason: 'The question depended on the previous analytics answer, so the plugin preserved the prior scope and metric context before calling the CLI.',
    });
  });
});

test('answer_density_question MCP clarification is compact, terminal, and resumable', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_CLARIFICATION = '1';

    const question = 'which location should we analyze?';
    const result = await callMcp('tools/call', {
      name: 'answer_density_question',
      arguments: { question, dataDir: path.join(tempDir, 'data') },
    });
    const payload = result.structuredContent;

    assert.equal(payload.ok, false);
    assert.equal(payload.clarificationRequest.prompt, 'Choose one measured building.');
    assert.deepEqual(payload.orchestration, {
      state: 'clarification_required',
      terminal: true,
      retryable: false,
      awaitingUser: true,
      continuation: {
        tool: 'answer_density_question',
        originalQuestion: question,
        requires: ['clarificationAnswer'],
      },
    });
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 4000);
    assert.equal(Object.hasOwn(payload, 'readiness'), false);
    assert.equal(Object.hasOwn(payload, 'capabilities'), false);
  });
});

test('answer_density_question preserves the exact SITE-A golden prompt in one slide call with native attachments', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    const fixture = JSON.parse(await readFile(
      new URL('../assets/golden-questions.v1.json', import.meta.url),
      'utf8',
    ));
    const golden = fixture.questions.find(({ id }) => id === 'busiest-meeting-rooms');
    const dataDir = path.join(tempDir, 'site-a-data');

    const result = await callMcp('tools/call', {
      name: 'answer_density_question',
      arguments: { question: golden.question, dataDir },
    });
    const questionCalls = (await readFakeLog(logFile))
      .filter((args) => args[0] === 'question');

    assert.equal(result.structuredContent.question, golden.question);
    assert.equal(result.structuredContent.analytic.artifact.headline, 'Lincoln is the busiest room');
    assert.equal(result.structuredContent.analytic.artifact.response_mode, 'slide');
    assert.equal(result.structuredContent.cache.hit, true);
    assert.equal(questionCalls.length, 1);
    assert.equal(questionCalls[0][1], golden.question);
    assert.equal(questionCalls[0].includes('--slide'), true);
    assert.equal(result.content.some((block) => block.type === 'image' && block.mimeType === 'image/png'), true);
    assert.equal(result.content.some((block) => block.type === 'resource_link' && block.mimeType === 'text/html'), true);
  });
});

test('answer_density_question passes --theme through to the CLI only when a theme is requested', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    const themedLog = path.join(tempDir, 'themed-calls.log');
    const defaultLog = path.join(tempDir, 'default-calls.log');
    await writeFakeCli(fakeCli);
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_CLI_LOG = themedLog;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    const dataDir = path.join(tempDir, 'theme-data');

    const themed = await callMcp('tools/call', {
      name: 'answer_density_question',
      arguments: { question: 'what are the busiest rooms?', dataDir, theme: 'boardroom_dark' },
    });
    assert.equal(themed.structuredContent.ok, true);
    const themedCalls = (await readFakeLog(themedLog)).filter((args) => args[0] === 'question');
    assert.equal(themedCalls.length, 1);
    const themeIndex = themedCalls[0].indexOf('--theme');
    assert.ok(themeIndex > 0, 'themed call should pass --theme to the CLI');
    assert.equal(themedCalls[0][themeIndex + 1], 'boardroom_dark');

    process.env.FAKE_CLI_LOG = defaultLog;
    const unthemed = await callMcp('tools/call', {
      name: 'answer_density_question',
      arguments: { question: 'what are the busiest rooms?', dataDir },
    });
    assert.equal(unthemed.structuredContent.ok, true);
    const defaultCalls = (await readFakeLog(defaultLog)).filter((args) => args[0] === 'question');
    assert.equal(defaultCalls.length, 1);
    assert.equal(defaultCalls.some((args) => args.includes('--theme')), false, 'default call must not pass --theme');
  });
});

test('analytic_slide passes --theme through to the CLI question invocation', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';
    const dataDir = path.join(tempDir, 'slide-theme-data');

    const result = await callMcp('tools/call', {
      name: 'analytic_slide',
      arguments: { question: 'what are the busiest rooms?', dataDir, timeoutMs: 5000, theme: '#1A6B54' },
    });
    assert.equal(result.structuredContent.ok, true);
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');
    assert.equal(questionCalls.length, 1);
    assert.equal(questionCalls[0].includes('--slide'), true);
    const themeIndex = questionCalls[0].indexOf('--theme');
    assert.ok(themeIndex > 0, 'themed call should pass --theme to the CLI');
    assert.equal(questionCalls[0][themeIndex + 1], '#1A6B54');
  });
});

test('theme arguments are validated before invoking the runtime', async () => {
  await withTempEnv(async (tempDir) => {
    const { logFile } = await prepareThemeRuntime(tempDir);
    const dataDir = path.join(tempDir, 'data');
    for (const invoke of [
      () => answerDensityQuestion({ question: 'busiest rooms', dataDir, theme: 'neon_party' }),
      () => answerDensityQuestion({ question: 'busiest rooms', dataDir, theme: 'institutional' }),
      () => analyticSlide({ question: 'busiest rooms', dataDir, theme: '#12AB' }),
      () => localUtilizationQuery({ question: 'busiest rooms', dataDir, theme: 'Density Blue' }),
    ]) {
      await assert.rejects(invoke(), /theme must match a value returned by density theme list/);
    }
    assert.equal((await readFakeLog(logFile)).some((args) => args[0] === 'question'), false);
  });
});

const prepareThemeRuntime = async (tempDir, { unset = false } = {}) => {
  const fakeCli = path.join(tempDir, 'density.mjs');
  const fakeBrowser = path.join(tempDir, 'fake-chrome');
  const logFile = path.join(tempDir, 'theme-calls.log');
  await writeFakeCli(fakeCli);
  await writeFakeHtmlScreenshotCommand(fakeBrowser);
  process.env.DENSITY_CLI_BIN = fakeCli;
  process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
  process.env.FAKE_CLI_LOG = logFile;
  process.env.FAKE_CHART_SUPPORT = '1';
  process.env.FAKE_QUESTION_UI_SUPPORT = '1';
  process.env.FAKE_ANALYTIC_SUPPORT = '1';
  if (unset) process.env.FAKE_THEME_UNSET = '1';
  return { fakeCli, fakeBrowser, logFile };
};

test('all slide entry paths elect a CLI-derived theme before rendering on first use', async () => {
  await withTempEnv(async (tempDir) => {
    const { logFile } = await prepareThemeRuntime(tempDir, { unset: true });
    const question = 'what are the busiest rooms?';
    const results = await Promise.all([
      answerDensityQuestion({ question, dataDir: path.join(tempDir, 'answer-data') }),
      localUtilizationQuery({ question, dataDir: path.join(tempDir, 'local-data') }),
      analyticSlide({ question, dataDir: path.join(tempDir, 'slide-data') }),
    ]);

    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.clarificationRequest.kind, 'density.clarification_request.v1');
      assert.equal(result.clarificationRequest.reason, 'analytic_theme_selection_required');
      assert.equal(result.clarificationRequest.responseSemantics.writesArtifacts, false);
      assert.equal(result.clarificationRequest.suggestions.some(({ id }) => id === 'alpine_grid'), true);
      assert.equal(result.clarificationRequest.suggestions.some(({ id }) => id === 'institutional'), false);
      assert.equal(result.clarificationRequest.freeform.format, '#RRGGBB');
    }
    const calls = await readFakeLog(logFile);
    assert.equal(calls.filter((args) => args[0] === 'theme' && args[1] === 'list').length, 3);
    assert.equal(calls.filter((args) => args[0] === 'theme' && args[1] === 'get').length, 3);
    assert.equal(calls.some((args) => args[0] === 'question'), false);
  });
});

test('theme election repeats invalid choices, persists a valid answer, and survives a plugin restart', async () => {
  await withTempEnv(async (tempDir) => {
    const { logFile } = await prepareThemeRuntime(tempDir, { unset: true });
    const dataDir = path.join(tempDir, 'data');
    const question = 'what are the busiest rooms?';

    const first = await answerDensityQuestion({ question, dataDir });
    assert.equal(first.clarificationRequest.reason, 'analytic_theme_selection_required');
    const invalid = await answerDensityQuestion({ question, dataDir, clarificationAnswer: 'Neon Party' });
    assert.equal(invalid.clarificationRequest.reason, 'analytic_theme_selection_required');
    assert.equal((await readFakeLog(logFile)).some((args) => args[0] === 'question'), false);

    const selected = await answerDensityQuestion({ question, dataDir, clarificationAnswer: 'Swiss' });
    assert.equal(selected.ok, true);
    let calls = await readFakeLog(logFile);
    assert.equal(calls.filter((args) => args[0] === 'theme' && args[1] === 'set' && args[2] === 'swiss').length, 1);
    const rendered = calls.filter((args) => args[0] === 'question');
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0][1], question);
    assert.equal(rendered[0][rendered[0].indexOf('--theme') + 1], 'swiss');

    const restarted = await callMcp('tools/call', {
      name: 'answer_density_question',
      arguments: { question: 'what time are rooms busiest?', dataDir },
    });
    assert.equal(restarted.structuredContent.ok, true);
    calls = await readFakeLog(logFile);
    assert.equal(calls.filter((args) => args[0] === 'theme' && args[1] === 'set').length, 1);
  });
});

test('a building clarification answer named Swiss is not consumed as a theme election', async () => {
  await withTempEnv(async (tempDir) => {
    const { logFile } = await prepareThemeRuntime(tempDir, { unset: true });
    process.env.FAKE_QUESTION_CLARIFICATION = '1';
    const dataDir = path.join(tempDir, 'data');
    const question = 'compare utilization across a building';

    await answerDensityQuestion({ question, dataDir });
    const buildingPrompt = await answerDensityQuestion({ question, dataDir, clarificationAnswer: 'Editorial' });
    assert.equal(buildingPrompt.clarificationRequest.reason, 'broad_scope_needs_resolution');
    const buildingAnswer = await answerDensityQuestion({ question, dataDir, clarificationAnswer: 'Swiss' });
    assert.equal(buildingAnswer.clarificationRequest.reason, 'broad_scope_needs_resolution');

    const calls = await readFakeLog(logFile);
    assert.equal(calls.filter((args) => args[0] === 'theme' && args[1] === 'set').length, 1);
    assert.deepEqual(calls.filter((args) => args[0] === 'theme' && args[1] === 'set')[0].slice(0, 3), ['theme', 'set', 'editorial']);
    assert.equal(calls.filter((args) => args[0] === 'question').at(-1)[1], `${question} User clarification: Swiss`);
  });
});

test('embedded CLI-derived theme phrases are stripped before scope matching and persisted', async () => {
  await withTempEnv(async (tempDir) => {
    const { logFile } = await prepareThemeRuntime(tempDir, { unset: true });
    const cases = [
      ['rank the busiest rooms in boardroom_dark', 'rank the busiest rooms', 'boardroom_dark'],
      ['rank the busiest rooms using the swiss theme', 'rank the busiest rooms', 'swiss'],
      ['compare Swiss Tower using the board room dark theme', 'compare Swiss Tower', 'boardroom_dark'],
      ['rank the busiest rooms using density_blue', 'rank the busiest rooms', 'density_blue'],
      ['rank the busiest rooms using #1A6B54 theme', 'rank the busiest rooms', '#1A6B54'],
      ['compare Board Room Dark Building using the Alpine Grid theme', 'compare Board Room Dark Building', 'alpine_grid'],
      ['show rooms in Building A in boardroom_dark', 'show rooms in Building A', 'boardroom_dark'],
    ];

    for (const [question, effectiveQuestion, theme] of cases) {
      const dataDir = path.join(tempDir, `data-${theme.replaceAll('#', '')}`);
      const result = await answerDensityQuestion({ question, dataDir });
      assert.equal(result.ok, true);
      assert.equal(result.followUp.effectiveQuestion, effectiveQuestion);
      assert.match(result.followUp.reason, /theme phrase/i);
    }
    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');
    assert.deepEqual(questionCalls.map((args) => args[1]), cases.map(([, effectiveQuestion]) => effectiveQuestion));
    assert.deepEqual(
      calls.filter((args) => args[0] === 'theme' && args[1] === 'set').map((args) => args[2]),
      cases.map(([, , theme]) => theme),
    );
  });
});

test('theme-only follow-ups rerender prior chart context and fail closed without it', async () => {
  await withTempEnv(async (tempDir) => {
    const { logFile } = await prepareThemeRuntime(tempDir);
    const dataDir = path.join(tempDir, 'with-prior');
    const question = 'what are the busiest rooms?';
    await answerDensityQuestion({ question, dataDir });

    const rerendered = await answerDensityQuestion({ question: 'do it in swiss', dataDir });
    assert.equal(rerendered.ok, true);
    assert.deepEqual(rerendered.followUp, {
      type: 'theme_only_rerender',
      previousQuestion: question,
      effectiveQuestion: question,
      reason: 'The request changed only the theme, so the plugin reused the prior analytic question.',
    });
    const noPriorDir = path.join(tempDir, 'without-prior');
    const noPrior = await answerDensityQuestion({ question: 'do it in swiss', dataDir: noPriorDir });
    assert.equal(noPrior.ok, false);
    assert.equal(noPrior.clarificationRequest.reason, 'analytic_theme_follow_up_needs_question');

    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');
    assert.deepEqual(questionCalls.map((args) => args[1]), [question, question]);
  });
});

test('theme availability and change requests use the chooser without rendering request text', async () => {
  await withTempEnv(async (tempDir) => {
    const { logFile } = await prepareThemeRuntime(tempDir);
    const dataDir = path.join(tempDir, 'data');

    const chooser = await answerDensityQuestion({ question: 'what themes are available?', dataDir });
    assert.equal(chooser.clarificationRequest.reason, 'analytic_theme_change_requested');
    assert.equal(chooser.clarificationRequest.suggestions.some(({ id }) => id === 'alpine_grid'), true);
    const selected = await answerDensityQuestion({
      question: 'what themes are available?',
      clarificationAnswer: 'Alpine Grid',
      dataDir,
    });
    assert.equal(selected.ok, true);
    assert.equal(selected.intent, 'analytic_theme_preference_updated');

    const changed = await answerDensityQuestion({ question: 'change the colors to Swiss', dataDir });
    assert.equal(changed.ok, true);
    assert.equal(changed.intent, 'analytic_theme_preference_updated');
    const calls = await readFakeLog(logFile);
    assert.deepEqual(
      calls.filter((args) => args[0] === 'theme' && args[1] === 'set').map((args) => args[2]),
      ['alpine_grid', 'swiss'],
    );
    assert.equal(calls.some((args) => args[0] === 'question'), false);
  });
});

test('an explicit structured theme is a validated one-render override and does not persist', async () => {
  await withTempEnv(async (tempDir) => {
    const { logFile } = await prepareThemeRuntime(tempDir, { unset: true });
    const dataDir = path.join(tempDir, 'data');
    const question = 'what are the busiest rooms?';

    const overridden = await answerDensityQuestion({ question, dataDir, theme: 'alpine_grid' });
    assert.equal(overridden.ok, true);
    let calls = await readFakeLog(logFile);
    assert.equal(calls.some((args) => args[0] === 'theme' && args[1] === 'set'), false);
    const questionCall = calls.find((args) => args[0] === 'question');
    assert.equal(questionCall[questionCall.indexOf('--theme') + 1], 'alpine_grid');

    const next = await answerDensityQuestion({ question: 'what time are rooms busiest?', dataDir });
    assert.equal(next.clarificationRequest.reason, 'analytic_theme_selection_required');
    calls = await readFakeLog(logFile);
    assert.equal(calls.filter((args) => args[0] === 'question').length, 1);
  });
});

test('theme routing fails closed for unsupported, malformed, failed, and ambiguous selections', async () => {
  await withTempEnv(async (tempDir) => {
    const { logFile } = await prepareThemeRuntime(tempDir, { unset: true });
    const question = 'what are the busiest rooms?';
    const scenarios = [
      ['unsupported', 'FAKE_THEME_CAPABILITY', '0', 'analytic_theme_preference_unsupported'],
      ['bad-list', 'FAKE_THEME_LIST_MALFORMED', '1', 'analytic_theme_contract_invalid'],
      ['bad-get', 'FAKE_THEME_GET_MALFORMED', '1', 'analytic_theme_contract_invalid'],
    ];
    for (const [name, envName, value, reason] of scenarios) {
      const scenarioCli = path.join(tempDir, name, 'density.mjs');
      await writeFakeCli(scenarioCli);
      process.env.DENSITY_CLI_BIN = scenarioCli;
      process.env[envName] = value;
      const result = await answerDensityQuestion({ question, dataDir: path.join(tempDir, name) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
      delete process.env[envName];
    }
    process.env.FAKE_THEME_SET_FAIL = '1';
    const failedSet = await answerDensityQuestion({
      question: 'what are the busiest rooms using Swiss theme?',
      dataDir: path.join(tempDir, 'failed-set'),
    });
    assert.equal(failedSet.ok, false);
    assert.equal(failedSet.reason, 'analytic_theme_preference_write_failed');
    delete process.env.FAKE_THEME_SET_FAIL;

    const ambiguous = await answerDensityQuestion({
      question: 'what are the busiest rooms using Swiss and Editorial themes?',
      dataDir: path.join(tempDir, 'ambiguous'),
    });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.clarificationRequest.reason, 'analytic_theme_ambiguous');
    const multiple = await answerDensityQuestion({
      question: 'what are the busiest rooms using Swiss theme and Editorial theme?',
      dataDir: path.join(tempDir, 'multiple'),
    });
    assert.equal(multiple.ok, false);
    assert.equal(multiple.clarificationRequest.reason, 'analytic_theme_ambiguous');
    const calls = await readFakeLog(logFile);
    assert.equal(calls.some((args) => args[0] === 'question'), false);
  });
});

test('compact MCP transport preserves theme rewrite disclosure', async () => {
  await withTempEnv(async (tempDir) => {
    await prepareThemeRuntime(tempDir, { unset: true });
    const result = await callMcp('tools/call', {
      name: 'answer_density_question',
      arguments: {
        question: 'rank the busiest rooms using the Alpine Grid theme',
        dataDir: path.join(tempDir, 'data'),
      },
    });
    assert.deepEqual(result.structuredContent.followUp, {
      effectiveQuestion: 'rank the busiest rooms',
      reason: 'The plugin removed the theme phrase before scope matching and applied the selected theme separately.',
    });
  });
});

test('local_utilization_query cannot bypass native delivery when it generates a slide', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    await writeFakeCli(fakeCli);
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const result = await callMcp('tools/call', {
      name: 'local_utilization_query',
      arguments: {
        question: 'what are the busiest rooms?',
        dataDir: path.join(tempDir, 'query-data'),
      },
    });

    assert.equal(result.structuredContent.slideDelivery.status, 'delivered');
    assert.equal(result.content.some((block) => block.type === 'image'), true);
    assert.equal(result.content.some((block) => block.type === 'resource_link'), true);
  });
});

test('ask_chart cannot bypass native delivery when slide is explicitly requested', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    await writeFakeCli(fakeCli);
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const result = await callMcp('tools/call', {
      name: 'ask_chart',
      arguments: {
        question: 'what are the busiest rooms?',
        presentation: 'slide',
        dataDir: path.join(tempDir, 'ask-data'),
      },
    });

    assert.equal(result.structuredContent.slideDelivery.status, 'delivered');
    assert.equal(result.content.some((block) => block.type === 'image'), true);
    assert.equal(result.content.some((block) => block.type === 'resource_link'), true);
  });
});

test('legacy MCP clients receive compatible text and image slide content', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    await writeFakeCli(fakeCli);
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const [initialized, result] = await callMcpRequests([
      {
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      },
      {
        method: 'tools/call',
        params: {
          name: 'answer_density_question',
          arguments: {
            question: 'what are the busiest rooms?',
            dataDir: path.join(tempDir, 'legacy-data'),
          },
        },
      },
    ]);

    assert.equal(initialized.protocolVersion, '2024-11-05');
    assert.equal(result.structuredContent, undefined);
    assert.equal(result.content.some((block) => block.type === 'image'), true);
    assert.equal(result.content.some((block) => block.type === 'resource_link'), false);
    assert.equal(JSON.parse(result.content[0].text).deliveryState, 'delivered');
  });
});

test('legacy MCP clients without a PNG preview do not receive a false delivered state', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = path.join(tempDir, 'missing-browser');
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const [, result] = await callMcpRequests([
      {
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      },
      {
        method: 'tools/call',
        params: {
          name: 'answer_density_question',
          arguments: {
            question: 'what are the busiest rooms?',
            dataDir: path.join(tempDir, 'legacy-no-preview-data'),
          },
        },
      },
    ]);
    const payload = JSON.parse(result.content[0].text);

    assert.deepEqual(result.content.map(({ type }) => type), ['text']);
    assert.equal(payload.slideDelivery.status, 'generated');
    assert.equal(payload.presentationDelivery.delivered, 'none');
    assert.equal(payload.deliveredMode, 'none');
    assert.equal(payload.deliveryState, 'generated');
  });
});

test('native slide delivery never reuses a stale PNG after a no-op renderer run', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const fakeBrowser = path.join(tempDir, 'fake-chrome');
    const dataDir = path.join(tempDir, 'stale-preview-data');
    await writeFakeCli(fakeCli);
    await writeFakeHtmlScreenshotCommand(fakeBrowser);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.DENSITY_HTML_SCREENSHOT_COMMAND = fakeBrowser;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const first = await callMcp('tools/call', {
      name: 'analytic_slide',
      arguments: { question: 'what are the busiest rooms?', dataDir },
    });
    assert.equal(first.content.some((block) => block.type === 'image'), true);

    process.env.FAKE_HTML_SCREENSHOT_SKIP_WRITE = '1';
    const second = await callMcp('tools/call', {
      name: 'analytic_slide',
      arguments: { question: 'what are the busiest rooms?', dataDir },
    });

    assert.equal(second.structuredContent.slideDelivery.preview.status, 'unavailable');
    assert.equal(second.content.some((block) => block.type === 'image'), false);
    assert.equal(second.content.some((block) => block.type === 'resource_link'), true);
  });
});

test('analytic learning records can be listed and reviewed through direct and MCP tools', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'learning-data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const listed = await listAnalyticLearningRecords({ dataDir, timeoutMs: 5000 });
    assert.equal(listed.ok, true);
    assert.equal(listed.records[0].id, 'lr_123e4567-e89b-12d3-a456-426614174000');
    assert.equal(listed.dataDir, dataDir);
    assert.equal(listed.limit, 25);
    assert.equal(listed.offset, 0);
    assert.equal(listed.total, 1);
    assert.equal(listed.hasMore, false);
    assert.equal(Object.hasOwn(listed.records[0], 'artifact_snapshot'), false);

    const reviewed = await reviewAnalyticLearningRecord({
      id: listed.records[0].id,
      answer: 'Yes, the event explains it.',
      interpretation: 'Treat the event as customer context.',
      label: 'good_with_fixes',
      dataDir,
      timeoutMs: 5000,
    });
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.id, listed.records[0].id);
    assert.equal(reviewed.label, 'good_with_fixes');

    const mcp = await callMcp('tools/call', {
      name: 'review_analytic_learning',
      arguments: { id: listed.records[0].id, label: 'gold_standard', dataDir, timeoutMs: 5000 },
    });
    assert.equal(JSON.parse(mcp.content[0].text).ok, true);

    const mcpList = await callMcp('tools/call', {
      name: 'analytic_learning_records',
      arguments: { dataDir, limit: 1, timeoutMs: 5000 },
    });
    const mcpListed = JSON.parse(mcpList.content[0].text);
    assert.equal(mcpListed.limit, 1);
    assert.equal(mcpListed.total, 1);
    assert.equal(Object.hasOwn(mcpListed.records[0], 'artifact_snapshot'), false);

    const calls = await readFakeLog(logFile);
    assert.ok(calls.some((args) => args[0] === 'learning'
      && args[1] === 'list'
      && args.includes('--compact')
      && args[args.indexOf('--limit') + 1] === '25'
      && args[args.indexOf('--offset') + 1] === '0'));
    assert.ok(calls.some((args) => args[0] === 'learning' && args[1] === 'review' && args.includes('--label')));
  });
});

test('analytic learning records default to the newest 25 compact records and enforce the 100-record limit', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_ANALYTIC_LEARNING_COUNT = '30';

    const defaultPage = await listAnalyticLearningRecords({ dataDir: path.join(tempDir, 'data') });
    assert.equal(defaultPage.limit, 25);
    assert.equal(defaultPage.offset, 0);
    assert.equal(defaultPage.total, 30);
    assert.equal(defaultPage.hasMore, true);
    assert.equal(defaultPage.nextOffset, 25);
    assert.equal(defaultPage.records.length, 25);
    assert.equal(defaultPage.records[0].measured_observation, 'Learning record 30.');
    assert.equal(defaultPage.records.at(-1).measured_observation, 'Learning record 6.');
    assert.equal(defaultPage.records.every((record) => !Object.hasOwn(record, 'artifact_snapshot')), true);

    const shortPage = await listAnalyticLearningRecords({ dataDir: path.join(tempDir, 'data'), limit: 3 });
    assert.equal(shortPage.records.length, 3);
    assert.deepEqual(shortPage.records.map((record) => record.measured_observation), [
      'Learning record 30.',
      'Learning record 29.',
      'Learning record 28.',
    ]);
    assert.equal(shortPage.nextOffset, 3);

    const finalPage = await listAnalyticLearningRecords({ dataDir: path.join(tempDir, 'data'), limit: 25, offset: 25 });
    assert.equal(finalPage.offset, 25);
    assert.equal(finalPage.records.length, 5);
    assert.equal(finalPage.records[0].measured_observation, 'Learning record 5.');
    assert.equal(finalPage.records.at(-1).measured_observation, 'Lincoln is the busiest room.');
    assert.equal(finalPage.hasMore, false);
    assert.equal(Object.hasOwn(finalPage, 'nextOffset'), false);

    for (const limit of [0, 1.5, 101, '25']) {
      await assert.rejects(listAnalyticLearningRecords({ dataDir: path.join(tempDir, 'data'), limit }), /limit must be an integer between 1 and 100/i);
    }
    for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0']) {
      await assert.rejects(listAnalyticLearningRecords({ dataDir: path.join(tempDir, 'data'), offset }), /offset must be a non-negative integer/i);
    }
  });
});

test('analytic learning review validates ids, labels, and non-empty feedback before invoking the CLI', async () => {
  await assert.rejects(reviewAnalyticLearningRecord({ id: 'not-an-id', label: 'gold_standard' }), /learning record id/i);
  await assert.rejects(reviewAnalyticLearningRecord({ id: 'lr_123e4567-e89b-12d3-a456-426614174000' }), /answer, interpretation, or label/i);
  await assert.rejects(reviewAnalyticLearningRecord({
    id: 'lr_123e4567-e89b-12d3-a456-426614174000',
    label: 'almost_good',
  }), /label must be one of/i);
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

test('askChart keeps building lifecycle questions on the local chart path', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    const result = await askChart({ question: 'Which buildings are live and past go-live?', dataDir: path.join(tempDir, 'data') });
    const calls = await readFakeLog(logFile);
    assert.equal(result.ok, true);
    assert.equal(calls.some((call) => call[0] === 'live'), false);
    assert.equal(calls.some((call) => call[0] === 'question'), true);
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
      question: 'Show Metro Tower floor 15 utilization visually on the floor plan',
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

test('local utilization query caches capability discovery and uses one CLI question call per prompt', async () => {
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

    assert.equal(calls.filter((args) => args[0] === 'capabilities').length, 1);
    assert.equal(calls.filter((args) => args[0] === 'question').length, 2);
    assert.equal(calls.filter((args) => args[0] === 'question').every((args) => args.includes('--cached')), true);
  });
});

test('local utilization query keeps one-hop success when the prepared cache misses', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_CACHE_MISS = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'what are the busiest rooms?',
    });
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');

    assert.equal(result.ok, true);
    assert.equal(result.title, 'Busiest rooms UI');
    assert.equal(result.chart, '/tmp/ui-chart.svg');
    assert.equal(result.cache, undefined);
    assert.equal(questionCalls.length, 1);
    assert.equal(questionCalls[0].includes('--cached'), true);
  });
});

test('local utilization query preserves the public snapshot refresh contract without internal lock fields', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_SNAPSHOT = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'what are the busiest rooms?',
    });

    assert.deepEqual(result.snapshot, {
      contract: 'density.local-question-snapshot.v1',
      source: 'local_customer_data',
      live: false,
      state: 'stale',
      scope: 'all_spaces',
      staleAfterMs: 86400000,
      lastSyncAt: '2000-01-03T12:00:00.000Z',
      ageMs: 172800000,
      interval: '1h',
      backgroundRefresh: { state: 'started' },
    });
    assert.doesNotMatch(JSON.stringify(result), /private-token|refresh\.lock/);
  });
});

test('local utilization query applies one bounded wall budget to a slow question process', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_DELAY_MS = '1000';

    const startedAt = Date.now();
    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'what are the busiest rooms?',
      timeoutMs: 300,
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - startedAt < 800);
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');
    assert.equal(questionCalls.length, 1);
  });
});

test('local utilization query keeps the native UI failure fallback inside the original wall budget', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '0';
    process.env.FAKE_ASK_DELAY_MS = '1000';

    const startedAt = Date.now();
    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'what are the busiest rooms?',
      timeoutMs: 250,
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - startedAt < 750);
    const calls = await readFakeLog(logFile);
    assert.equal(calls.filter((args) => args[0] === 'question').length, 2);
    assert.equal(calls.filter((args) => args[0] === 'ask').length, 1);
  });
});

test('answer density question does not repeat lifecycle discovery after a native UI answer', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await answerDensityQuestion({
      dataDir: path.join(tempDir, 'data'),
      question: 'what are the busiest rooms?',
    });

    assert.equal(result.ok, true);
    assert.equal(result.buildingReadiness, undefined);
    const calls = await readFakeLog(logFile);
    assert.equal(calls.filter((args) => args[0] === 'question').length, 1);
    assert.equal(calls.some((args) => args[0] === 'available-buildings'), false);
  });
});

test('local utilization query regenerates a chart when a cache hit has no artifacts', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_ARTIFACT_FREE = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'what are the busiest rooms?',
    });
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');

    assert.equal(result.ok, true);
    assert.equal(result.chart, '/tmp/ui-chart.svg');
    assert.equal(result.html, '/tmp/ui-chart.html');
    assert.equal(questionCalls.length, 2);
    assert.equal(questionCalls[0].includes('--cached'), true);
    assert.equal(questionCalls[1].includes('--cached'), false);
  });
});

test('local utilization query does not retry an artifact-free prepared-metrics answer', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_ARTIFACT_FREE = '1';
    process.env.FAKE_QUESTION_UI_PREPARED_CACHE = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'what are the busiest rooms?',
    });
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');

    assert.equal(result.ok, true);
    assert.equal(questionCalls.length, 1);
    assert.equal(questionCalls[0].includes('--cached'), true);
  });
});

test('local utilization query regenerates a prepared-metrics chart unless cached artifacts match their content digests', async () => {
  for (const artifactState of ['missing', 'empty', 'directory', 'wrong_content']) {
    await withTempEnv(async (tempDir) => {
      const fakeCli = path.join(tempDir, 'density.mjs');
      const logFile = path.join(tempDir, 'calls.log');
      await writeFakeCli(fakeCli);
      process.env.DENSITY_CLI_BIN = fakeCli;
      process.env.FAKE_CLI_LOG = logFile;
      process.env.FAKE_QUESTION_UI_SUPPORT = '1';
      process.env.FAKE_QUESTION_UI_PREPARED_CACHE = '1';
      process.env.FAKE_QUESTION_UI_ARTIFACT_STATE = artifactState;

      const result = await localUtilizationQuery({
        dataDir: path.join(tempDir, 'data'),
        question: 'what are the busiest rooms?',
      });
      const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');

      assert.equal(result.ok, true, artifactState);
      assert.equal(result.chart, '/tmp/ui-chart.svg', artifactState);
      assert.equal(result.html, '/tmp/ui-chart.html', artifactState);
      assert.equal(questionCalls.length, 2, artifactState);
      assert.equal(questionCalls[0].includes('--cached'), true, artifactState);
      assert.equal(questionCalls[1].includes('--cached'), false, artifactState);
    });
  }
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
      'rank the most used conference rooms and phone booths on Metro Tower floor 15 during working hours',
      'normalize conference room size popularity to average occupied hours per day from 6am to 6pm',
      'what is the most popular conference room size in Metro Tower?',
      'what about phone booths?',
      'how often do we run out of phone booths by floor across Metro Tower?',
      'show that as a chart',
    ];

    const startedAt = Date.now();
    for (const question of prompts) {
      const result = await localUtilizationQuery({ dataDir, question });
      assert.equal(result.ok, true);
      assert.equal(result.question, question);
      assert.equal(result.sourceLayer, 'local_customer_data');
      assert.equal(result.effectiveScope.operatingHours.start, 8);
      if (question.includes('6am to 6pm')) {
        assert.match(result.caveats.join(' '), /requested operating hours 6am-6pm.*CLI reported 8am-6pm/i);
      }
      assert.equal(result.freshness.source, 'atlas_local_metrics');
    }
    const elapsedMs = Date.now() - startedAt;
    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');
    const chartFollowUp = await localUtilizationQuery({ dataDir, question: 'show that as a chart' });
    const expectedCliQuestions = [
      'rank the most used conference rooms and phone booths on Metro Tower floor 15 during working hours',
      'normalize conference room size popularity to average occupied hours per day from 6am to 6pm',
      'what is the most popular conference room size in Metro Tower?',
      'what is the most popular phone booth size in Metro Tower?',
      'how often do we run out of phone booths by floor across Metro Tower?',
    ];

    assert.equal(calls.filter((args) => args[0] === 'capabilities').length, 1);
    assert.equal(questionCalls.length, prompts.length - 1);
    assert.deepEqual(questionCalls.map((args) => args[1]), expectedCliQuestions);
    assert.equal(questionCalls.every((args) => args.includes('--chart') && args.includes('--format') && args.includes('ui')), true);
    assert.equal(questionCalls.every((args) => args.includes('--cached')), true);
    assert.equal(chartFollowUp.intent, 'chart_follow_up');
    assert.equal(chartFollowUp.followUp.previousQuestion, 'how often do we run out of phone booths by floor across Metro Tower?');
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
      question: 'can you compare phone booths to meeting rooms with any one office building?',
    });
    const elapsedMs = Date.now() - startedAt;
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, false);
    assert.equal(result.kind, 'density.clarification_request.v1');
    assert.equal(result.contract, 'density.clarification');
    assert.equal(result.reason, 'broad_scope_needs_resolution');
    assert.equal(result.scopeResolution, 'no_match');
    assert.equal(result.intent, 'broad_scope_needs_resolution');
    assert.equal(result.chartSuppressed, true);
    assert.equal(result.nextAction.id, 'clarify_measured_building_scope');
    assert.deepEqual(result.suggestions.map((suggestion) => suggestion.id), [
      'list_measured_buildings',
      'choose_measured_building',
    ]);
    assert.equal(result.requiredChoiceCount, 1);
    assert.equal(result.freeform.enabled, true);
    assert.equal(result.nextActionAfterAnswer.id, 'answer_density_question');
    assert.deepEqual(result.responseSemantics, {
      answer: false,
      chart: false,
      benchmark: false,
      writesArtifacts: false,
    });
    assert.match(result.subtitle, /manual DuckDB or Parquet work/i);
    assert.deepEqual(result.recovery.avoid, ['shell', 'DuckDB', 'SQL', 'manual Parquet scans', 'hand-built chart scripts']);
    assert.equal(result.chart, undefined);
    assert.equal(result.html, undefined);
    assert.equal(result.png, undefined);
    assert.equal(result.benchmark, undefined);
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
    await localUtilizationQuery({ dataDir, question: 'what is the most popular conference room size in Metro Tower?' });
    const normalized = await localUtilizationQuery({ dataDir, question: 'normalize that and use 6am to 6pm instead' });
    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');

    assert.equal(normalized.question, 'normalize that and use 6am to 6pm instead');
    assert.equal(normalized.followUp.type, 'rewrite_contextual_question');
    assert.equal(normalized.followUp.previousQuestion, 'what is the most popular conference room size in Metro Tower?');
    assert.equal(questionCalls[1][1], 'what is the most popular conference room size in Metro Tower? average occupied hours per day from 6am to 6pm');
  });
});

test('local utilization query preserves a contextual requested operating-hours range', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const dataDir = path.join(tempDir, 'data');
    await localUtilizationQuery({ dataDir, question: 'what is the most popular conference room size in Metro Tower?' });
    process.env.FAKE_OPERATING_HOURS = JSON.stringify({ start: 7, end: 19, label: '7am-7pm', source: 'user_requested' });
    const result = await localUtilizationQuery({ dataDir, question: 'normalize that and use 7am to 7pm instead' });
    process.env.FAKE_OPERATING_HOURS = JSON.stringify({ start: 9, end: 17, label: '9-5', source: 'user_requested' });
    const nineToFive = await localUtilizationQuery({ dataDir, question: 'use 9 to 5 instead' });
    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');

    assert.equal(questionCalls[1][1], 'what is the most popular conference room size in Metro Tower? average occupied hours per day from 7am to 7pm');
    assert.deepEqual(result.effectiveScope.operatingHours, {
      start: 7,
      end: 19,
      label: '7am-7pm',
      source: 'user_requested',
    });
    assert.equal(questionCalls[2][1], 'what is the most popular conference room size in Metro Tower? average occupied hours per day from 9 to 5');
    assert.deepEqual(nineToFive.effectiveScope.operatingHours, {
      start: 9,
      end: 17,
      label: '9-5',
      source: 'user_requested',
    });
  });
});

test('local utilization query discloses when the CLI does not apply requested operating hours', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'rank meeting rooms from 6am to 6pm',
    });

    assert.equal(result.effectiveScope.operatingHours.label, '8am-6pm');
    assert.match(result.caveats.join(' '), /requested operating hours 6am-6pm.*CLI reported 8am-6pm/i);
  });
});

test('answer density question keeps same-site weekday-hour follow-ups historical', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const dataDir = path.join(tempDir, 'data');
    await answerDensityQuestion({
      dataDir,
      question: 'At Brooklyn, which meeting rooms were busiest over the last 30 days available?',
    });
    const followUp = await answerDensityQuestion({
      dataDir,
      question: 'Now show the same site by weekday and hour.',
    });
    const calls = await readFakeLog(logFile);
    const questionCalls = calls.filter((args) => args[0] === 'question');

    assert.equal(followUp.routedTool, 'local_utilization_query');
    assert.equal(followUp.followUp.type, 'rewrite_contextual_question');
    assert.equal(questionCalls.at(-1)[1], 'At Brooklyn, which meeting rooms were busiest over the last 30 days available? by weekday and hour');
    assert.equal(calls.some((args) => args[0] === 'wayfinding'), false);
  });
});

test('answer density question reattaches the prior slide for an explicit chart follow-up', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_ANALYTIC_SUPPORT = '1';

    const dataDir = path.join(tempDir, 'data');
    const original = 'At Brooklyn, show meeting-room utilization by weekday and hour.';
    await answerDensityQuestion({ dataDir, question: original });
    const followUp = await answerDensityQuestion({ dataDir, question: 'Show that as a chart.' });
    const questionCalls = (await readFakeLog(logFile)).filter((args) => args[0] === 'question');

    assert.equal(followUp.question, 'Show that as a chart.');
    assert.equal(followUp.followUp.type, 'reuse_previous_chart');
    assert.equal(followUp.panelTarget.kind, 'analytic-slide');
    assert.equal(questionCalls.at(-1)[1], original);
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
    await localUtilizationQuery({ dataDir, question: 'what is the most popular conference room size on Metro Tower floor 15?' });
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
      query: 'Show live wayfinding availability for Metro Tower floor 15',
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
      query: 'Show live wayfinding availability for Metro Tower floor 15',
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
        query: 'Show live wayfinding availability for Metro Tower floor 15',
        timeoutMs: -1,
      }),
      /timeoutMs must be a positive number/
    );

    await assert.rejects(
      () => liveWayfindingStatus({
        dataDir: path.join(tempDir, 'data'),
        query: 'Show live wayfinding availability for Metro Tower floor 15',
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
      query: 'Show live wayfinding availability for Metro Tower floor 15',
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
      query: 'Show live wayfinding availability for Metro Tower floor 15',
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
    assert.equal(result.nextAction.args.days, 30);
    assert.equal(result.nextAction.args.backgroundDeepSync, true);
    assert.equal(result.nextAction.args.backgroundDeepSyncDays, DEFAULT_BACKGROUND_DEEP_SYNC_DAYS);
    assert.match(result.nextAction.command, /--since 30d/);
    assert.match(result.nextAction.command, /--interval 1h/);
    assert.equal(result.onboardingOptions[0].id, 'recommended_recent_plus_background');
    assert.equal(result.onboardingOptions[0].recommended, true);
    assert.equal(result.onboardingOptions[1].id, 'recent_only');
    assert.equal(result.onboardingOptions[2].id, 'specific_location');
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

test('recommended full onboarding syncs 30 days and starts background deeper history', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await onboardCustomer({
      dataDir,
      fullSync: true,
      backgroundDeepSyncDays: 60,
    });
    const foregroundCalls = await readFakeLog(logFile);
    const metricsCall = foregroundCalls.find((args) => args[0] === 'sync' && args.includes('metrics'));

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'recent-plus-background');
    assert.equal(result.days, DEFAULT_METRICS_DAYS);
    assert.equal(result.backgroundDeepSync.enabled, true);
    assert.equal(result.backgroundDeepSync.days, 60);
    assert.equal(result.backgroundDeepSync.recentDays, DEFAULT_METRICS_DAYS);
    assert.equal(result.backgroundDeepSync.pollingTool, 'onboarding_status');
    assert.equal(metricsCall[metricsCall.indexOf('--since') + 1], '30d');

    const completed = await waitFor(async () => {
      const status = await onboardingStatus({ dataDir });
      return status.backgroundDeepSync.status === 'complete' ? status : undefined;
    });
    assert.ok(completed);
    assert.equal(completed.backgroundDeepSync.result.days, 60);
    assert.equal(completed.backgroundDeepSync.result.until, '30d');

    const calls = await readFakeLog(logFile);
    assert.ok(calls.some((args) => args[0] === 'sync' && args.includes('metrics') && args[args.indexOf('--since') + 1] === '60d' && args[args.indexOf('--until') + 1] === '30d'));
    assert.ok(calls.some((args) => args[0] === 'sync' && args.includes('occupancy') && args[args.indexOf('--since') + 1] === '60d' && args[args.indexOf('--until') + 1] === '30d'));
  });
});

test('recent-only onboarding skips the background deeper-history job', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await onboardCustomer({
      dataDir,
      fullSync: true,
      backgroundDeepSync: false,
    });
    const status = await onboardingStatus({ dataDir });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'full-sync');
    assert.equal(result.days, DEFAULT_METRICS_DAYS);
    assert.deepEqual(result.backgroundDeepSync, { enabled: false });
    assert.equal(status.backgroundDeepSync.status, 'not_started');
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
      onboardCustomer({ dataDir: path.join(tempDir, 'data'), days: 31 }),
      /between 1 and 30/
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
  assert.equal(metricsIntervalForDays(30), '1h');
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

test('local utilization query preserves mixed local and approved benchmark provenance', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_QUESTION_MIXED = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'which rooms were used most on the third floor?',
    });

    assert.equal(result.ok, true);
    assert.equal(result.sourceLayer, 'mixed_local_benchmark');
    assert.equal(result.sourceBadge, 'Mixed');
    assert.match(result.provenance.caveat, /historical rows come from local Parquet/i);
    assert.match(result.provenance.caveat, /approved display-safe Density benchmark scorecard/i);
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
        question: 'what local historical data do we have for Metro Tower?',
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
      if (item.intent === 'local_utilization') {
        assert.equal(result.cache.hit, true);
        assert.equal(result.chart, path.join(dataDir, 'artifacts', 'question-cache', 'cached-ui-chart.svg'));
        assert.equal(result.provenance.tool, 'local_utilization_query');
        assert.equal(result.buildingReadiness, undefined);
      }
    }
  });
});

test('answer density question keeps lifecycle, structure, and freshness metadata on the chart question path', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const cases = [
      {
        question: 'Which Example Company buildings are live?',
        intent: 'building_lifecycle',
        title: /Three Example Company buildings are live/,
        row: { label: 'Example HQ', value: 1, status: 'live' },
      },
      {
        question: 'Which sites are offline?',
        intent: 'building_lifecycle',
        title: /One Example Company site is offline/,
        row: { label: 'Offline site', value: 1, status: 'offline' },
      },
      {
        question: 'How many spaces do we have?',
        intent: 'local_structure',
        title: /12 usable spaces/,
        row: { label: 'Usable spaces', value: 12, unit: 'leaf_spaces' },
      },
      {
        question: 'How many meeting rooms are in Example HQ?',
        intent: 'local_structure',
        title: /Example HQ has 3 meeting rooms/,
        row: { label: 'Meeting rooms', value: 3, unit: 'spaces' },
      },
      {
        question: 'At Example HQ, how many floors and available measured spaces are represented?',
        intent: 'local_structure',
        title: /12 usable spaces/,
        row: { label: 'Usable spaces', value: 12, unit: 'leaf_spaces' },
      },
      {
        question: 'How fresh is Example Company data?',
        intent: 'local_data_freshness',
        title: /fresh through January 2/,
        row: { label: 'Latest complete local day', value: '2000-01-02' },
      },
      {
        question: 'When was Example Company data last synced?',
        intent: 'local_data_freshness',
        title: /fresh through January 2/,
        row: { label: 'Latest complete local day', value: '2000-01-02' },
      },
    ];

    for (const item of cases) {
      const callCount = (await readFakeLog(logFile)).length;
      const result = await answerDensityQuestion({ dataDir, question: item.question });
      const calls = (await readFakeLog(logFile)).slice(callCount);

      assert.equal(result.intent, item.intent, item.question);
      assert.equal(result.question, item.question, item.question);
      assert.equal(result.routedTool, 'local_utilization_query', item.question);
      assert.equal(result.routing.routedTool, 'local_utilization_query', item.question);
      assert.match(result.title, item.title, item.question);
      assert.deepEqual(result.rows[0], item.row, item.question);
      assert.equal(result.cache.hit, true, item.question);
      assert.equal(result.chart, path.join(dataDir, 'artifacts', 'question-cache', 'cached-ui-chart.svg'), item.question);
      assert.equal(result.sourceLayer, 'local_customer_data', item.question);
      assert.equal(result.provenance.tool, 'local_utilization_query', item.question);
      assert.equal(result.benchmarkAffordance, undefined, item.question);
      assert.equal(calls.some((args) => args[0] === 'question' && args.includes('--cached')), true, item.question);
      assert.equal(calls.some((args) => args[0] === 'wayfinding'), false, item.question);
      assert.equal(calls.some((args) => args[0] === 'viz'), false, item.question);
    }
  });
});

test('metadata answers suppress benchmark affordance on the legacy chart fallback', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '0';

    const result = await answerDensityQuestion({
      dataDir,
      question: 'How many spaces do we have?',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.intent, 'local_structure');
    assert.equal(result.chart, '/tmp/chart.svg');
    assert.equal(result.benchmarkAffordance, undefined);
    assert.equal(calls.some((args) => args[0] === 'ask'), true);
  });
});

test('metadata routing preserves sensor, live availability, floorplan, diagnostic, and historical boundaries', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir, ['resources']);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const sensor = await answerDensityQuestion({ dataDir, question: 'Which buildings have offline sensors?' });
    assert.equal(sensor.intent, 'sensor_health');
    assert.equal(sensor.routedTool, 'sensor_health_report');

    const liveCallCount = (await readFakeLog(logFile)).length;
    const live = await answerDensityQuestion({ dataDir, question: 'How many meeting rooms are open now in Example HQ?' });
    const liveCalls = (await readFakeLog(logFile)).slice(liveCallCount);
    assert.equal(live.intent, 'live_wayfinding');
    assert.equal(live.question, 'How many meeting rooms are open now in Example HQ?');
    assert.equal(live.routedTool, 'live_wayfinding_status');
    assert.equal(liveCalls.some((args) => args[0] === 'wayfinding'), true);
    assert.equal(liveCalls.some((args) => args[0] === 'question'), false);

    const floorplanCallCount = (await readFakeLog(logFile)).length;
    const floorplan = await answerDensityQuestion({ dataDir, question: 'How many meeting rooms are shown on the Example HQ floorplan?' });
    const floorplanCalls = (await readFakeLog(logFile)).slice(floorplanCallCount);
    assert.equal(floorplan.intent, 'floorplan_artifact');
    assert.equal(floorplan.routedTool, 'floor_usage_report');
    assert.equal(floorplanCalls.some((args) => args[0] === 'viz' && args.includes('floor-usage')), true);
    assert.equal(floorplanCalls.some((args) => args[0] === 'question'), false);

    const diagnosticCallCount = (await readFakeLog(logFile)).length;
    const diagnostic = await answerDensityQuestion({
      dataDir,
      question: 'Can we trust this stale local data when metrics are missing or zero?',
    });
    const diagnosticCalls = (await readFakeLog(logFile)).slice(diagnosticCallCount);
    assert.equal(diagnostic.intent, 'local_data_health');
    assert.equal(diagnostic.routedTool, 'data_health_report');
    assert.equal(diagnosticCalls.some((args) => args[0] === 'question'), false);

    const historicalCallCount = (await readFakeLog(logFile)).length;
    const historical = await answerDensityQuestion({
      dataDir,
      question: 'Which Example HQ rooms were busiest last month?',
    });
    const historicalCalls = (await readFakeLog(logFile)).slice(historicalCallCount);
    assert.equal(historical.intent, 'local_utilization');
    assert.equal(historical.routedTool, 'local_utilization_query');
    assert.equal(historicalCalls.some((args) => args[0] === 'question' && args.includes('--cached')), true);
    assert.equal(historicalCalls.some((args) => args[0] === 'wayfinding'), false);

    const totalUsage = await answerDensityQuestion({
      dataDir,
      question: 'Show total used hours for meeting rooms last month.',
    });
    assert.equal(totalUsage.intent, 'local_utilization');
    assert.equal(totalUsage.routedTool, 'local_utilization_query');

    for (const question of [
      'How many meeting rooms were used last month?',
      'How many rooms had occupancy last week?',
      'How many desks were utilized yesterday?',
      'How many meeting rooms had usage in June?',
      'At Example HQ, how did measured meeting-room supply compare with observed occupied room-time?',
      'At Example HQ, what group sizes were observed when large meeting rooms were occupied?',
    ]) {
      const callCount = (await readFakeLog(logFile)).length;
      const result = await answerDensityQuestion({ dataDir, question });
      const calls = (await readFakeLog(logFile)).slice(callCount);
      assert.equal(result.question, question, question);
      assert.equal(result.intent, 'local_utilization', question);
      assert.equal(result.routedTool, 'local_utilization_query', question);
      assert.equal(result.benchmarkAffordance.sourceLayer, 'benchmark_network_context', question);
      assert.equal(calls.some((args) => args[0] === 'question' && args.includes('--cached')), true, question);
      assert.equal(calls.some((args) => args[0] === 'wayfinding'), false, question);
    }
  });
});

test('local utilization query routes coverage questions to local data profile', async () => {
  await withTempEnv(async (tempDir) => {
    const dataDir = path.join(tempDir, 'data');
    await writeParquetTables(dataDir);

    const result = await localUtilizationQuery({
      dataDir,
      question: 'what local historical data do we have for Metro Tower?',
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
    assert.equal(result.sourceBadge, 'Live');
    assert.equal(result.contract.noLocalDuckdbFallback, true);
    assert.doesNotMatch(JSON.stringify(result), /local_customer_data/);
  });
});

test('sensor questions outside the supported health vocabulary fail closed without substitution', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_SENSOR_HEALTH_UI = '1';

    const direct = await sensorHealthReport({ dataDir, question: 'How many sensors are installed?' });
    const routed = await answerDensityQuestion({ dataDir, question: 'How many sensors are installed?' });
    const calls = await readFakeLog(logFile);

    for (const result of [direct, routed]) {
      assert.equal(result.ok, false);
      assert.equal(result.unsupported, true);
      assert.match(result.message, /supported sensor health or status/i);
    }
    assert.equal(calls.some((args) => args[0] === 'question'), false);
  });
});

test('availability routing supports people and office vocabulary without stealing named-day history', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const live = await localUtilizationQuery({ dataDir, question: 'How many people are in the office?' });
    assert.equal(live.intent, 'live_wayfinding');
    assert.equal(live.routedTool, 'live_wayfinding_status');

    const historical = await localUtilizationQuery({ dataDir, question: 'Which office rooms were available Monday?' });
    assert.equal(historical.intent, 'local_utilization');
    assert.notEqual(historical.routedTool, 'live_wayfinding_status');

    const zeroPeople = await localUtilizationQuery({ dataDir, question: 'Why were there zero people in the office Monday?' });
    assert.equal(zeroPeople.intent, 'local_utilization');
    assert.notEqual(zeroPeople.routedTool, 'data_health_report');
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

test('local utilization query lets explicit floorplan wording win over temporal heatmap wording', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'show a floorplan heatmap by hour',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.intent, 'floorplan_artifact');
    assert.equal(calls.some((args) => args[0] === 'viz' && args.includes('floor-usage')), true);
    assert.equal(calls.some((args) => args[0] === 'question'), false);
  });
});

test('local utilization query keeps weekday-hour heatmaps on the chart path', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';

    const result = await localUtilizationQuery({
      dataDir: path.join(tempDir, 'data'),
      question: 'show me a room usage heatmap by weekday and hour',
    });
    const calls = await readFakeLog(logFile);

    assert.equal(result.ok, true);
    assert.equal(result.cache.hit, true);
    assert.equal(calls.some((args) => args[0] === 'question' && args.includes('--cached')), true);
    assert.equal(calls.some((args) => args[0] === 'viz'), false);
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

test('sensor health report refuses to pretend explicit IDs were applied before scoped CLI support', async () => {
  const result = await sensorHealthReport({ floorId: 'floor_1', spaceIds: ['space_1'] });

  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.equal(result.sourceLayer, 'cloud_sensor_health');
  assert.equal(result.sourceBadge, 'Live');
  assert.equal(result.contract.source, 'density_cloud_only');
  assert.equal(result.contract.noLocalDuckdbFallback, true);
  assert.equal(result.contract.rawStatusPreserved, true);
  assert.match(result.message, /Explicit ID scope was not applied/);
  assert.doesNotMatch(JSON.stringify(result), /floor_1|space_1/);
});

test('sensor health report and front door return the validated CLI live sensor UI contract', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_SENSOR_HEALTH_UI = '1';

    const direct = await sensorHealthReport({
      dataDir,
      question: 'How many sensors are online, are any reporting errors or unconfigured, and where?',
      timeoutMs: 5000,
    });
    const frontDoor = await answerDensityQuestion({
      dataDir,
      question: 'How many sensors are online, are any reporting errors or unconfigured, and where?',
      intentHint: 'sensor-health',
    });
    const parsedUi = await askChart({
      dataDir,
      question: 'How many sensors are online, are any reporting errors or unconfigured, and where?',
    });
    const calls = await readFakeLog(logFile);

    for (const result of [direct, frontDoor, parsedUi]) {
      assert.equal(result.ok, true, `sensor UI result not ok: ${JSON.stringify(result)}`);
      assert.equal(result.sourceBadge, 'Live');
      assert.equal(result.sourceLayer, 'cloud_sensor_health');
      assert.equal(result.sourceLabel, 'Density Sensor Health');
      assert.equal(result.title, '2 of 12 eligible Example Company sensors need attention');
      assert.equal(result.subtitle, '10 online; 1 error; 1 unconfigured.');
      assert.equal(result.freshness.observedAt, '2000-02-01T12:00:00.000Z');
      assert.equal(result.freshness.mappingSnapshotAt, '2000-01-02T12:00:00.000Z');
      assert.equal(result.benchmark.state, 'not_comparable');
      assert.equal(result.sensorHealth.eligibleSensorCount, 12);
      assert.equal(result.chart.endsWith('sensor-health.svg'), true);
      assert.equal(result.html.endsWith('sensor-health.html'), true);
      assert.equal(result.png.endsWith('sensor-health.png'), true);
      assert.equal(result.performance.targetMs, 5000);
      assert.doesNotMatch(JSON.stringify(result), /serial_number|sensor_id|space_id|organization_id|network_address|super-secret/i);
    }
    assert.equal(frontDoor.routedTool, 'sensor_health_report');
    assert.equal(frontDoor.routing.routedTool, 'sensor_health_report');
    assert.equal(direct.contract.noLocalDuckdbFallback, true);
    assert.equal(calls.some((args) => args[0] === 'capabilities'), true);
    assert.equal(calls.filter((args) => args[0] === 'question').every((args) => /sensors?/i.test(String(args[1]))), true);
    assert.equal(calls.filter((args) => args[0] === 'question').every((args) => args.includes('--chart') && args.includes('ui')), true);

    process.env.FAKE_SENSOR_SCOPE_LABEL = 'Example HQ';
    const scopedAttention = await sensorHealthReport({
      dataDir,
      question: 'How many sensors need attention in Example HQ?',
    });
    assert.equal(scopedAttention.ok, true);
    assert.equal(scopedAttention.effectiveScope.selectedScope.label, 'Example HQ');
  });
});

test('question UI parser preserves validated cloud sensor provenance instead of hardcoding Local', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_SENSOR_HEALTH_UI = '1';

    const result = await askChart({
      dataDir: path.join(tempDir, 'data'),
      question: 'How many sensors are online and where are the errors?',
    });

    assert.equal(result.ok, true);
    assert.equal(result.sourceLayer, 'cloud_sensor_health');
    assert.equal(result.sourceBadge, 'Live');
    assert.equal(result.sourceLabel, 'Density Sensor Health');
  });
});

test('sensor bridge strips opaque UI fields and rejects invalid source, aggregate, and scope contracts', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_SENSOR_HEALTH_UI = '1';
    process.env.FAKE_SENSOR_PRIVATE_UI = '1';

    const privateResult = await sensorHealthReport({
      dataDir,
      question: 'How many sensors are online?',
    });
    const serialized = JSON.stringify(privateResult);
    assert.equal(privateResult.ok, true, `sensor bridge result not ok: ${serialized}`);
    assert.equal(privateResult.ui, undefined);
    assert.deepEqual(privateResult.effectiveScope, { organizationName: 'Example Company' });
    assert.deepEqual(privateResult.rows, [{ label: 'Example HQ · Multiple floors', value: 1, detail: 'Unconfigured: 1' }]);
    assert.doesNotMatch(serialized, /private-serial|private-uuid|private-org|private-space|aa:bb:cc:dd|10\.0\.0\.7|super-secret-ui/);

    delete process.env.FAKE_SENSOR_PRIVATE_UI;
    for (const invalid of ['sourceLabel', 'freshness', 'complete', 'benchmark', 'aggregate', 'answer']) {
      process.env.FAKE_SENSOR_INVALID_CONTRACT = invalid;
      const result = await sensorHealthReport({ dataDir, question: 'How many sensors are online?' });
      assert.equal(result.ok, false, invalid);
      assert.match(result.error, /could not be validated/i, invalid);
      assert.doesNotMatch(JSON.stringify(result), /private-serial|super-secret/i, invalid);
    }
    delete process.env.FAKE_SENSOR_INVALID_CONTRACT;

    const organizationScope = await sensorHealthReport({
      dataDir,
      question: 'How many sensors are online at Example Company?',
    });
    assert.equal(organizationScope.ok, true);
    assert.equal(organizationScope.effectiveScope.organizationName, 'Example Company');

    const statusPhrase = await sensorHealthReport({
      dataDir,
      question: 'Are any sensors in error?',
    });
    assert.equal(statusPhrase.ok, true);

    const badHealth = await sensorHealthReport({
      dataDir,
      question: 'Are sensors in bad health?',
    });
    assert.equal(badHealth.ok, true);
    assert.deepEqual(badHealth.effectiveScope, { organizationName: 'Example Company' });

    process.env.FAKE_SENSOR_SCOPE_LABEL = 'Example HQ';
    const scopedStatusPhrase = await sensorHealthReport({
      dataDir,
      question: 'Are any sensors in an error state in Example HQ?',
    });
    assert.equal(scopedStatusPhrase.ok, true);
    assert.equal(scopedStatusPhrase.effectiveScope.selectedScope.label, 'Example HQ');

    const mismatchedScope = await sensorHealthReport({
      dataDir,
      question: 'How many sensors are online in Example North?',
    });
    assert.equal(mismatchedScope.ok, false);
    assert.match(mismatchedScope.error, /scope/i);
  });
});

test('sensor router keeps historical utilization local and rejects unapproved signal diagnosis', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    await writeParquetTables(dataDir);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CHART_SUPPORT = '1';
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_SENSOR_HEALTH_UI = '1';

    const historical = await answerDensityQuestion({
      dataDir,
      question: 'What was utilization for sensor-covered spaces last month?',
    });
    assert.notEqual(historical.routedTool, 'sensor_health_report');
    assert.equal(historical.sourceLayer, 'local_customer_data');

    const why = await sensorHealthReport({ dataDir, question: 'Why is the live signal stale?' });
    assert.equal(why.ok, false);
    assert.equal(why.unsupported, true);
    assert.equal(why.contract.staleThreshold, 'not_defined');
  });
});

test('historical sensor status fails closed without running the current snapshot CLI path', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const logFile = path.join(tempDir, 'calls.log');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_SENSOR_HEALTH_UI = '1';

    const staleSignal = await answerDensityQuestion({
      dataDir,
      question: 'Why is the live signal stale?',
    });
    const historicalSignalExact = await answerDensityQuestion({
      dataDir,
      question: 'Was the live signal unhealthy on Friday?',
    });
    let calls = await readFakeLog(logFile);

    assert.equal(staleSignal.ok, false);
    assert.equal(staleSignal.unsupported, true);
    assert.equal(staleSignal.contract.staleThreshold, 'not_defined');
    assert.match(staleSignal.message, /approved heartbeat.*threshold/i);
    assert.equal(historicalSignalExact.ok, false);
    assert.equal(historicalSignalExact.unsupported, true);
    assert.equal(historicalSignalExact.currentOnly, true);
    assert.match(historicalSignalExact.message, /only the latest cloud snapshot/i);
    assert.equal(calls.length, 0);

    const result = await answerDensityQuestion({
      dataDir,
      question: 'Which sensors were offline last month?',
    });
    calls = await readFakeLog(logFile);

    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
    assert.equal(result.currentOnly, true);
    assert.match(result.message, /only the latest cloud snapshot/i);
    assert.equal(calls.some((args) => args[0] === 'question'), false);

    const latestHeartbeat = await sensorHealthReport({
      dataDir,
      question: 'Are sensors healthy based on the last heartbeat?',
    });
    assert.equal(latestHeartbeat.ok, false);
    assert.equal(latestHeartbeat.unsupported, true);
    assert.equal(latestHeartbeat.contract.staleThreshold, 'not_defined');
    assert.match(latestHeartbeat.message, /approved heartbeat.*threshold/i);

    const historicalSignal = await answerDensityQuestion({
      dataDir,
      question: 'Why was the live signal stale over the last quarter?',
    });
    const finalCalls = await readFakeLog(logFile);
    assert.equal(historicalSignal.ok, false);
    assert.equal(historicalSignal.currentOnly, true);
    assert.equal(finalCalls.filter((args) => args[0] === 'question').length, 0);
  });
});

test('sensor capability and PNG failures are unavailable or partial, never update advice or ok success', async () => {
  await withTempEnv(async (tempDir) => {
    const fakeCli = path.join(tempDir, 'density.mjs');
    const dataDir = path.join(tempDir, 'data');
    await writeFakeCli(fakeCli);
    process.env.DENSITY_CLI_BIN = fakeCli;
    process.env.FAKE_QUESTION_UI_SUPPORT = '1';
    process.env.FAKE_SENSOR_HEALTH_UI = '1';
    process.env.FAKE_CAPABILITIES_FAIL = '1';

    const unchecked = await sensorHealthReport({ dataDir, question: 'Are sensors healthy?' });
    assert.equal(unchecked.ok, false);
    assert.equal(unchecked.unsupported, false);
    assert.match(unchecked.error, /capability.*unavailable/i);
    assert.doesNotMatch(JSON.stringify(unchecked), /update.*CLI|super-secret-capability/i);

    delete process.env.FAKE_CAPABILITIES_FAIL;
    process.env.PATH = path.dirname(process.execPath);
    const noRenderer = await sensorHealthReport({ dataDir, question: 'Are sensors healthy?' });
    assert.equal(noRenderer.ok, false);
    assert.equal(noRenderer.partial, true);
    assert.match(noRenderer.error, /PNG renderer.*unavailable/i);
    assert.equal(noRenderer.nextAction.id, 'install_png_renderer');
  });
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
