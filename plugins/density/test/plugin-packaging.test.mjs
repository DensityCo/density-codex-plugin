import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testDir, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const skillsDir = path.join(pluginRoot, 'skills');
const guidanceDir = path.join(pluginRoot, 'guidance');

const EXPECTED_SKILLS = [
  'benchmarking',
  'data-health',
  'density',
  'floorplan',
  'sensor-health',
  'setup',
  'utilization',
  'wayfinding',
];

const EXPECTED_MCP_TOOLS = [
  'setup',
  'install_managed_cli',
  'auth_login',
  'onboard_customer',
  'onboarding_status',
  'historical_export',
  'create_demo_customer',
  'answer_density_question',
  'ask_chart',
  'analytic_slide',
  'local_utilization_query',
  'floor_usage_report',
  'local_data_profile',
  'available_buildings',
  'data_health_report',
  'live_wayfinding_status',
  'benchmark_compare',
  'sensor_health_report',
  'storage_report',
  'starter_questions',
  'repair_fast_questions',
];

test('Density package exposes exactly the expected skills', async () => {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const actualSkills = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(actualSkills, EXPECTED_SKILLS);
});

test('Density skills have valid packaging metadata and shared contracts', async () => {
  for (const skillName of EXPECTED_SKILLS) {
    const skillDir = path.join(skillsDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const skillText = await readFile(skillFile, 'utf8');
    const frontmatter = parseFrontmatter(skillText, skillFile);

    assert.equal(frontmatter.name, skillName, `${skillName} frontmatter name must match its folder`);
    assert.match(skillText, /^## Interaction Contract$/m, `${skillName} is missing ## Interaction Contract`);
    assert.match(skillText, /^## Progress Update Contract$/m, `${skillName} is missing ## Progress Update Contract`);

    const agentFile = path.join(skillDir, 'agents', 'openai.yaml');
    if (await exists(agentFile)) {
      const agentText = await readFile(agentFile, 'utf8');
      assert.match(agentText, new RegExp(`\\$${escapeRegExp(skillName)}(?![A-Za-z0-9_-])`), `${skillName} agents/openai.yaml must invoke $${skillName}`);
    }

    for (const reference of referencedReferenceFiles(skillText)) {
      const referencePath = path.join(skillDir, reference);
      assert.ok(await exists(referencePath), `${skillName} references missing file: ${reference}`);
    }
  }
});

test('Density packaged skills mirror shared guidance source', async () => {
  for (const skillName of EXPECTED_SKILLS) {
    const packaged = await readFile(path.join(skillsDir, skillName, 'SKILL.md'), 'utf8');
    const guidance = await readFile(path.join(guidanceDir, 'skills', `${skillName}.md`), 'utf8');

    assert.equal(packaged, guidance, `${skillName} SKILL.md is stale relative to shared guidance`);
  }
});

test('Density package files are tracked by git', async () => {
  const pathspecs = [
    'plugins/density/guidance',
    'plugins/density/skills',
    'plugins/density/assets',
    'plugins/density/scripts',
    'plugins/density/.codex-plugin',
    'plugins/density/.mcp.json',
    'plugins/density/mcp-server',
  ];
  const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '--', ...pathspecs], { cwd: repoRoot });
  const untracked = stdout.split(/\r?\n/).filter(Boolean).sort();

  assert.equal(
    untracked.length,
    0,
    `Density package files must be tracked by git. Untracked files:\n${untracked.join('\n')}`,
  );
});

test('Density design contract makes the fixed slide default and preserves Broadsheet/Tufte as a variant', async () => {
  const design = await readFile(path.join(pluginRoot, 'assets', 'design.md'), 'utf8');
  const guidance = await readFile(path.join(guidanceDir, 'design.md'), 'utf8');

  assert.equal(design, guidance, 'packaged design contract is stale relative to shared guidance');

  assert.match(design, /Broadsheet\/Tufte/, 'design contract should name the intended analytical aesthetic');
  assert.match(design, /high signal-to-ink ratio/, 'design contract should retain the Tufte-style signal discipline');
  assert.match(design, /generic dashboard chrome/, 'design contract should reject generic dashboard styling');
  assert.match(design, /must never overlap the title, marks, axes, or each other/, 'design contract should prohibit title/legend/chart collisions');
  assert.match(design, /Density CLI or plugin chart contract/, 'design contract should prefer plugin artifacts over one-off chart scripts');
  assert.match(design, /^## Immutable Editorial Constitution$/m, 'design contract should separate the canonical editorial identity');
  assert.match(design, /canonical default Density presentation is the fixed slide layout/, 'design contract should make the fixed slide default explicit');
  assert.match(design, /Broadsheet\/Tufte is the explicit chart variant and compatibility fallback/, 'design contract should preserve the editorial chart identity as a named variant');
  assert.match(design, /Approved render-time themes such as Density Blue, indigo, deep teal, or a customer brand accent/, 'design contract should preserve supported theme accents');
  assert.match(design, /must not change the editorial hierarchy or repurpose reserved trust/, 'theme accents should not override editorial or trust semantics');
  assert.match(design, /^## Semantic Encoding Rules$/m, 'design contract should separate semantic data encoding from editorial styling');
  assert.match(design, /datum trust state outranks any edition accent/, 'design contract should prioritize trust semantics over edition styling');
  assert.match(design, /Benchmark gold is benchmark-only/, 'design contract should reserve benchmark gold for benchmark context');
  assert.match(design, /source, freshness, and caveats visible at thumbnail size/, 'design contract should preserve trust context in thumbnails');
  assert.match(design, /^## Governed Themes$/m, 'design contract should authorize the governed theme registry');
  assert.match(design, /ten named registry themes/, 'design contract should enumerate the named theme family');
  assert.match(design, /no theme may reposition a zone or repurpose a reserved color/, 'themes should stay inside the fixed zones and reserved encodings');
  assert.match(design, /^## Future Governed Editions$/m, 'design contract should define future edition governance');
  assert.match(design, /same design file[\s\S]+must not expose an edition API/, 'design contract should keep editions governed without a public API');
});

test('Density ships the slide orchestration contract with the density skill', async () => {
  const orchestration = await readFile(
    path.join(pluginRoot, 'skills', 'density', 'references', 'slide-orchestration.md'),
    'utf8',
  );
  assert.match(orchestration, /you choose only from named registries/i, 'orchestration contract should pin the probabilistic/deterministic boundary');
  assert.match(orchestration, /The QA gate.*hard-fails the\s+render/s, 'orchestration contract should make the code gate the authority');
  assert.match(orchestration, /`institutional`[\s\S]+`newsprint_mono`/, 'orchestration contract should list the ten named themes');
  assert.match(orchestration, /`table_graphic`/, 'orchestration contract should map families to archetypes');
  assert.match(orchestration, /fails the gate twice[\s\S]+answer in chat/, 'orchestration contract should carry the fail-twice-to-chat policy');
});

test('Density ships the versioned 25-question acceptance matrix', async () => {
  const file = path.join(pluginRoot, 'assets', 'golden-questions.v1.json');
  const fixture = JSON.parse(await readFile(file, 'utf8'));

  assert.equal(fixture.contract, 'density.golden-questions.v1');
  assert.equal(fixture.questions.length, 25);
  assert.equal(new Set(fixture.questions.map(({ id }) => id)).size, 25);
  assert.deepEqual(
    [...new Set(fixture.questions.map(({ site }) => site))].sort(),
    [
      'SITE-A - Singapore',
      'SITE-B - Riverside Campus B1',
      'SITE-C - Metro Tower',
      'SITE-D - Parkview Place',
    ],
  );
  assert.equal(fixture.questions.filter(({ expectedMode }) => expectedMode === 'slide').length, 9);
  assert.equal(fixture.questions.filter(({ expectedMode }) => expectedMode === 'text').length, 16);
  assert.equal(
    fixture.questions.some(({ question }) => question === 'At SITE-A - Singapore, what were the busiest meeting rooms over the last 30 days available?'),
    true,
  );
});

test('Density skills preserve building lifecycle and go-live analysis rules', async () => {
  const density = await readFile(path.join(skillsDir, 'density', 'SKILL.md'), 'utf8');
  const utilization = await readFile(path.join(skillsDir, 'utilization', 'SKILL.md'), 'utf8');
  const wayfinding = await readFile(path.join(skillsDir, 'wayfinding', 'SKILL.md'), 'utf8');

  assert.match(density, /available_buildings/, 'parent skill should name the lifecycle readiness tool');
  assert.match(density, /status\/go-live readiness/, 'parent skill should require status/go-live awareness');
  assert.match(density, /density\.clarification_request\.v1/, 'parent skill should preserve the formal clarification request kind');
  assert.match(density, /density\.clarification/, 'parent skill should preserve the formal clarification contract');
  assert.match(utilization, /chartQueryable/, 'utilization skill should use chart queryability before artifacts');
  assert.match(utilization, /live, measured, past-go-live scope/, 'utilization skill should require lifecycle-eligible ordinary analytics');
  assert.match(wayfinding, /liveWayfindingEligible/, 'wayfinding skill should require live wayfinding eligibility');
});

test('Density guidance preserves portable setup, data-health, and live-wayfinding rules', async () => {
  const density = await readFile(path.join(skillsDir, 'density', 'SKILL.md'), 'utf8');
  const setup = await readFile(path.join(skillsDir, 'setup', 'SKILL.md'), 'utf8');
  const dataHealth = await readFile(path.join(skillsDir, 'data-health', 'SKILL.md'), 'utf8');
  const wayfinding = await readFile(path.join(skillsDir, 'wayfinding', 'SKILL.md'), 'utf8');

  assert.match(density, /30 days/, 'parent skill should describe recent-first 30-day onboarding');
  assert.match(setup, /recent-first and still filling in deeper history/, 'setup should preserve background history disclosure');
  assert.match(setup, /- `onboarding_status`/, 'setup should advertise the onboarding status MCP tool');
  assert.match(dataHealth, /state\.json/, 'data-health should preserve CLI sync-state diagnostics');
  assert.match(dataHealth, /retry with the same cursor first/, 'data-health should prefer deterministic cursor recovery');
  assert.match(wayfinding, /presenceBySpace/, 'wayfinding should preserve live floorplan state map guidance');
  assert.match(wayfinding, /Apply both `refresh` and `live` socket messages/, 'wayfinding should preserve socket message handling');
  assert.match(wayfinding, /observed timestamp range/, 'wayfinding should preserve signal freshness display guidance');
});

test('Density guidance preserves the Prime question runtime contract', async () => {
  const density = await readFile(path.join(skillsDir, 'density', 'SKILL.md'), 'utf8');
  const utilization = await readFile(path.join(skillsDir, 'utilization', 'SKILL.md'), 'utf8');
  const benchmarking = await readFile(path.join(skillsDir, 'benchmarking', 'SKILL.md'), 'utf8');
  const dataHealth = await readFile(path.join(skillsDir, 'data-health', 'SKILL.md'), 'utf8');
  const setup = await readFile(path.join(skillsDir, 'setup', 'SKILL.md'), 'utf8');
  const utilizationMethodology = await readFile(path.join(skillsDir, 'utilization', 'references', 'atlas-utilization-methodology.md'), 'utf8');
  const benchmarkMethodology = await readFile(path.join(skillsDir, 'benchmarking', 'references', 'darshan-benchmark-methodology.md'), 'utf8');

  assert.match(density, /ordinary Density questions[^\n]+`answer_density_question`/, 'parent skill should make the native front door deterministic');
  assert.match(density, /`orchestration\.terminal`[\s\S]{0,500}final[\s\S]{0,500}`clarificationAnswer`/, 'parent skill should stop on terminal results and resume clarifications through the front door');
  assert.match(density, /Do not call another Density tool after a terminal result/i, 'parent skill should prohibit multi-tool recovery after a terminal result');
  assert.match(density, /Do not fall back to shell, DuckDB, SQL, or hand-built Parquet scans for ordinary questions/i, 'parent skill should prohibit manual fallback for ordinary questions');
  assert.match(density, /Do not use script fallback for an ordinary question/i, 'parent skill should reserve scripts for setup and debugging');
  assert.match(density, /zero local quer(?:y|ies), benchmark requests, chart rendering, or artifact writes/i, 'clarification should perform no analytical work');
  assert.match(density, /delegated[^\n]+pick any[^\n]+live, measured, and past go-live/i, 'delegated broad scope should select only an eligible scope');
  assert.match(density, /`mixed_local_benchmark`/, 'parent data boundary should define Mixed provenance');
  assert.match(density, /full-wall latency[^\n]+routing[^\n]+PNG/i, 'parent skill should define end-to-end latency');
  assert.match(density, /answer ordinary historical questions immediately from the current local snapshot/i, 'parent skill should preserve immediate local answers');
  assert.match(density, /local historical[^\n]+never[^\n]+live/i, 'parent skill should keep historical snapshots distinct from live data');
  assert.match(density, /older than 24 hours[^\n]+at most one[^\n]+background metrics refresh/i, 'parent skill should define the stale snapshot refresh gate');
  assert.match(density, /refresh failure[^\n]+preserve[^\n]+answer/i, 'parent skill should preserve the answer when refresh fails');
  assert.match(density, /per-space or unknown[^\n]+never broaden/i, 'parent skill should forbid scope broadening during refresh');
  assert.match(density, /successful refresh[^\n]+rebuild[^\n]+prepared metrics cache/i, 'parent skill should rebuild the prepared cache after refresh');

  assert.match(utilization, /ordinary natural-language questions[^\n]+`answer_density_question`/, 'utilization should enter through the native front door');
  assert.match(utilization, /`orchestration\.terminal`[^\n]+final[^\n]+Never start a manual shell, DuckDB, SQL, or Parquet recovery/i, 'utilization should stop after terminal native delivery');
  assert.match(utilization, /prepared metrics cache/i, 'utilization should describe the prepared cache transparently');
  assert.match(utilization, /answer ordinary historical questions immediately from the current local snapshot/i, 'utilization should preserve immediate local answers');
  assert.match(utilization, /older than 24 hours[^\n]+at most one[^\n]+background metrics refresh/i, 'utilization should preserve the stale snapshot refresh gate');
  assert.match(density, /`analytic_slide`/, 'parent skill should route presentable answers to the analytic slide tool');
  assert.match(density, /ordinary historical Density questions default to the fixed slide presentation/i, 'parent skill should state the native presentation default');
  assert.match(density, /`presentation: "broadsheet"`/, 'parent skill should preserve the named Broadsheet variant');
  assert.match(utilization, /`context_needed`[^\n]+`follow_up_question` verbatim/i, 'utilization should preserve validated analytic confidence handling');
  assert.match(utilization, /Never re-derive or restate numbers/i, 'utilization should prohibit agent-authored analytic numbers');
  assert.match(utilization, /copy only the artifact `headline` and `subtitle` exactly[^\n]+end the turn/i, 'utilization should terminate after exact native slide delivery');
  assert.match(density, /copy only the artifact `headline` and `subtitle` exactly[^\n]+end the turn/i, 'parent skill should terminate after exact native slide delivery');
  assert.match(utilization, /chart follow-ups[^\n]+`answer_density_question` once[^\n]+reattaches/i, 'utilization should reattach follow-up charts through the native front door');
  assert.match(utilizationMethodology, /live, measured, and past go-live/i, 'ordinary analytics should use lifecycle-eligible scopes');
  assert.match(utilizationMethodology, /cache miss[^\n]+canonical local views/i, 'prepared-cache misses should preserve answer semantics');
  assert.match(utilizationMethodology, /exactly 24 hours[^\n]+fresh/i, 'methodology should preserve the exact freshness boundary');
  assert.match(utilizationMethodology, /per-space or unknown[^\n]+never broaden/i, 'methodology should prohibit refresh scope broadening');

  assert.match(benchmarking, /one exact floor/i, 'benchmarking should state exact-floor compatibility');
  assert.match(benchmarking, /single space function/i, 'benchmarking should state single-function compatibility');
  assert.match(benchmarkMethodology, /`avg_used_hours_per_day`[^\n]+`hours_per_day`/, 'benchmark numeric marks should require matching grain and unit');
  assert.match(benchmarkMethodology, /timed out[^\n]+`Local`[^\n]+not `Mixed`/i, 'benchmark timeout should preserve local provenance');
  assert.match(benchmarkMethodology, /local customer metric rows[^\n]+never sent/i, 'benchmark privacy should preserve the local/network boundary');

  assert.match(dataHealth, /prepared metrics cache/i, 'data-health should diagnose the prepared cache');
  assert.match(dataHealth, /completed all-spaces metrics snapshot[^\n]+older than 24 hours/i, 'data-health should diagnose refresh eligibility');
  assert.match(dataHealth, /failed refresh[^\n]+preserve[^\n]+answer/i, 'data-health should preserve the stale answer on refresh failure');
  assert.match(setup, /prepared metrics cache/i, 'setup should build and verify the prepared cache');
  assert.match(setup, /onboarding background sync[^\n]+distinct from[^\n]+per-question freshness refresh/i, 'setup should distinguish onboarding from per-question refresh');
});

test('Density OpenAI skill metadata routes Prime questions consistently', async () => {
  const densityAgent = await readFile(path.join(skillsDir, 'density', 'agents', 'openai.yaml'), 'utf8');
  const utilizationAgent = await readFile(path.join(skillsDir, 'utilization', 'agents', 'openai.yaml'), 'utf8');
  const benchmarkingAgent = await readFile(path.join(skillsDir, 'benchmarking', 'agents', 'openai.yaml'), 'utf8');

  assert.match(densityAgent, /ordinary Density question/i);
  assert.match(densityAgent, /front door/i);
  assert.match(utilizationAgent, /answer a historical utilization question through the Density front door/i);
  assert.match(benchmarkingAgent, /approved, compatible Density benchmark/i);
});

test('Density MCP server version and tool list match the plugin package', async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.website, 'https://density.io/');
  assert.equal(manifest.homepage, 'https://density.io/');
  assert.equal(manifest.interface?.website, 'https://density.io/');
  const client = await JsonRpcProcess.start();

  try {
    const initialized = await client.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'density-packaging-test', version: '0.0.0' },
    });
    assert.equal(initialized.serverInfo?.version, manifest.version);

    const listed = await client.call('tools/list', {});
    const toolNames = (listed.tools ?? []).map((tool) => tool.name).sort();
    const missingTools = EXPECTED_MCP_TOOLS.filter((tool) => !toolNames.includes(tool));

    assert.deepEqual(missingTools, [], `MCP tools/list is missing expected tools:\n${missingTools.join('\n')}`);
  } finally {
    await client.close();
  }
});

function parseFrontmatter(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, `${file} is missing frontmatter`);

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    fields[field[1]] = field[2].replace(/^['"]|['"]$/g, '');
  }
  return fields;
}

function referencedReferenceFiles(text) {
  const references = new Set();
  const patterns = [
    /`(references\/[^`\s]+)`/g,
    /(?:^|\s)(references\/[A-Za-z0-9._/-]+\.md)(?=[\s).,;:]|$)/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      references.add(match[1]);
    }
  }
  return [...references].sort();
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class JsonRpcProcess {
  static async start() {
    const child = spawn(process.execPath, ['mcp-server/server.mjs'], {
      cwd: pluginRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new JsonRpcProcess(child);
  }

  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';
    this.pending = new Map();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    child.on('exit', (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server exited before responding: code=${code} signal=${signal} stderr=${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  call(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr=${this.stderr}`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;

    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
