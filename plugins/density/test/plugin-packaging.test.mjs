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
  'wayfinding',
];

const EXPECTED_MCP_TOOLS = [
  'setup',
  'install_managed_cli',
  'auth_login',
  'onboard_customer',
  'onboarding_status',
  'status',
  'historical_export',
  'create_demo_customer',
  'query_db',
  'configure_brand',
  'floor_usage_report',
  'local_data_profile',
  'available_buildings',
  'data_health_report',
  'live_wayfinding_status',
  'benchmark_compare',
  'sensor_health_report',
  'storage_report',
];

const LEGACY_ANALYTICS_TOOLS = ['density_analyze', 'get_db_schema'];

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

test('Density canonical skills keep analytic comparisons unrounded', async () => {
  for (const file of [
    path.join(skillsDir, 'density', 'SKILL.md'),
    path.join(guidanceDir, 'skills', 'density.md'),
  ]) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /Use unrounded values for bin assignment, threshold tests, ordering, and\s+comparisons\./);
    assert.match(text, /Return raw numeric values from SQL\./);
    assert.match(text, /renderer applies display precision\./);
    assert.doesNotMatch(text, /round them to whole-number percentages in\s+SQL/);
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
  const design = await readFile(path.join(guidanceDir, 'design.md'), 'utf8');

  assert.match(design, /Broadsheet\/Tufte/, 'design contract should name the intended analytical aesthetic');
  assert.match(design, /high signal-to-ink ratio/, 'design contract should retain the Tufte-style signal discipline');
  assert.match(design, /generic dashboard chrome/, 'design contract should reject generic dashboard styling');
  assert.match(design, /must never overlap the title, marks, axes, or each other/, 'design contract should prohibit title/legend/chart collisions');
  assert.match(design, /Density MCP or plugin chart contract/, 'design contract should prefer plugin artifacts over one-off chart scripts');
  assert.match(design, /^## Immutable Editorial Constitution$/m, 'design contract should separate the canonical editorial identity');
  assert.match(design, /canonical default Density presentation is the fixed slide layout/, 'design contract should make the fixed slide default explicit');
  assert.match(design, /Broadsheet\/Tufte is the explicit chart variant and compatibility fallback/, 'design contract should preserve the editorial chart identity as a named variant');
  assert.match(design, /Approved render-time themes such as Density Blue, indigo, deep teal, or a customer brand accent/, 'design contract should preserve supported theme accents');
  assert.match(design, /must not change the editorial hierarchy or repurpose reserved trust/, 'theme accents should not override editorial or trust semantics');
  assert.match(design, /^## Semantic Encoding Rules$/m, 'design contract should separate semantic data encoding from editorial styling');
  assert.match(design, /datum trust state outranks any edition accent/, 'design contract should prioritize trust semantics over edition styling');
  assert.match(design, /Benchmark gold is benchmark-only/, 'design contract should reserve benchmark gold for benchmark context');
  assert.match(design, /source, freshness, and caveats visible at thumbnail size/, 'design contract should preserve trust context in thumbnails');
  assert.match(design, /displayed and total row counts/, 'design contract should disclose ranked subsets');
  assert.match(design, /Offer the remaining rows or slides/, 'design contract should offer omitted ranked results');
  assert.match(design, /^## Governed Themes$/m, 'design contract should authorize the governed theme registry');
  assert.match(design, /ten named registry themes/, 'design contract should enumerate the named theme family');
  assert.doesNotMatch(design, /institutional/, 'design contract must not list the retired theme');
  assert.match(design, /no theme may reposition a zone or repurpose a reserved color/, 'themes should stay inside the fixed zones and reserved encodings');
  assert.match(design, /^## Future Governed Editions$/m, 'design contract should define future edition governance');
  assert.match(design, /same design file[\s\S]+must not expose an edition API/, 'design contract should keep editions governed without a public API');
});

test('Density system prompt preserves the Modern MCP UX contract', async () => {
  const prompt = await readFile(path.join(guidanceDir, 'density-system-prompt.md'), 'utf8');

  assert.match(prompt, /Lead with what the workplace evidence shows/);
  assert.match(prompt, /clear, concise, natural, and friendly sentences/);
  assert.match(prompt, /Do not\s+narrate your internal work/);
  assert.match(prompt, /After the finding, add only the context needed to interpret it/);
  assert.match(prompt, /natural follow-up sentences, not a labeled section/);
  assert.match(prompt, /scope, window,[\s\S]+measured population, denominator, missing data, freshness, or uncertainty/);
  assert.match(prompt, /Do not add a heading or\s+label for this context/);
  assert.doesNotMatch(prompt, /trust paragraph/i);
  assert.match(prompt, /Ask one concise question only when an unresolved choice could materially change/);
  assert.match(prompt, /Bare "utilization" is ambiguous/);
  assert.match(prompt, /Binary occupancy supports occupied state and occupied time, not a people count/);
  assert.match(prompt, /Average capacity used is the duration-weighted mean occupancy while occupied/);
  assert.match(prompt, /Do not apply\s+P10-P90 to every result/);
  assert.match(prompt, /Critical mass is a user-defined goal/);
  assert.match(prompt, /Space efficiency has no universal formula/);
  assert.match(prompt, /Never convert absent data into zero/);
  assert.match(prompt, /Coverage describes completeness of analytic input\. It does not prove sensor\s+uptime/);
  assert.match(prompt, /Current lifecycle status must not erase valid historical evidence/);
  assert.match(prompt, /Preserve an explicit user\s+interval/);
  assert.match(prompt, /Keep the full query result available/);
  assert.match(prompt, /displayed and total row counts/);
  assert.match(prompt, /offer\s+the remaining rows or slides/i);
  assert.match(prompt, /Do not use a fixed query row limit/);
  assert.match(prompt, /Plot exact returned values/);
  assert.match(prompt, /Presentation-only edits reuse evidence/);
  assert.match(prompt, /Do not add\s+silent caps, thresholds, or automatic rewrites/);
  assert.match(prompt, /required evidence is unavailable[\s\S]+state the\s+closest truthful result or next useful option/);
});

test('Density Codex skill carries the natural analyst voice', async () => {
  const skill = await readFile(path.join(skillsDir, 'density', 'SKILL.md'), 'utf8');

  assert.match(skill, /^## Analyst Voice$/m);
  assert.match(skill, /Lead with what the workplace evidence shows/);
  assert.match(skill, /natural follow-up sentences, not a labeled section/);
  assert.match(skill, /Do not add a heading or\s+label for this context/);
  assert.doesNotMatch(skill, /trust paragraph/i);
});

test('Density ships the slide orchestration contract with the density skill', async () => {
  const orchestration = await readFile(
    path.join(pluginRoot, 'skills', 'density', 'references', 'slide-orchestration.md'),
    'utf8',
  );
  assert.match(orchestration, /Use `query_db` with the supplied schema resource/i, 'orchestration should use the direct historical query path');
  assert.match(orchestration, /downstream presentation request/i, 'query_db should keep presentation downstream of execution');
  assert.match(
    orchestration,
    /weekday.*`entity`[\s\S]+local hour.*`time`[\s\S]+percentage.*`measure`/i,
    'orchestration should declare the canonical weekday-hour heatmap roles',
  );
  assert.match(orchestration, /verified projections for bars, line, heatmap,[\s\S]+stacked bars, scatter, slope, range, area, pie, and[\s\S]+donut/i, 'orchestration should advertise all tested direct-query bodies');
  assert.match(orchestration, /1920×1080 artifact/i, 'orchestration should preserve the governed fixed slide artifact');
  assert.match(orchestration, /Do not screenshot, re-render, or rebuild an artifact\./, 'orchestration should block artifact fallbacks');
  assert.doesNotMatch(orchestration, /density\.chart-request\.v1|density_analyze|presentation:/i, 'orchestration should not require the legacy chart route');
  assert.doesNotMatch(orchestration, /priorAnalysisId|presentationPlan|signed evidence|evidence receipt/i, 'orchestration should not retain receipt-era guidance');
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
  const systemPrompt = await readFile(path.join(guidanceDir, 'density-system-prompt.md'), 'utf8');
  const wayfinding = await readFile(path.join(skillsDir, 'wayfinding', 'SKILL.md'), 'utf8');

  assert.match(density, /available_buildings/, 'parent skill should name the lifecycle readiness tool');
  assert.match(density, /lifecycle questions/, 'parent skill should route explicit lifecycle work');
  assert.match(systemPrompt, /Current lifecycle status must not erase valid historical evidence\./, 'system prompt should preserve historical evidence');
  assert.match(density, /Current status[\s\S]+must not remove spaces with valid historical rows\./, 'parent skill should preserve the lifecycle boundary');
  assert.match(wayfinding, /liveWayfindingEligible/, 'wayfinding skill should require live wayfinding eligibility');
});

test('Density guidance preserves portable setup, data-health, and live-wayfinding rules', async () => {
  const density = await readFile(path.join(skillsDir, 'density', 'SKILL.md'), 'utf8');
  const setup = await readFile(path.join(skillsDir, 'setup', 'SKILL.md'), 'utf8');
  const dataHealth = await readFile(path.join(skillsDir, 'data-health', 'SKILL.md'), 'utf8');
  const wayfinding = await readFile(path.join(skillsDir, 'wayfinding', 'SKILL.md'), 'utf8');

  assert.match(density, /30-day/, 'parent skill should describe recent-first 30-day onboarding');
  assert.match(setup, /recent-first and still filling in deeper history/, 'setup should preserve background history disclosure');
  assert.match(setup, /- `onboarding_status`/, 'setup should advertise the onboarding status MCP tool');
  assert.match(dataHealth, /state\.json/, 'data-health should preserve CLI sync-state diagnostics');
  assert.match(dataHealth, /retry with the same cursor first/, 'data-health should prefer deterministic cursor recovery');
  assert.match(wayfinding, /presenceBySpace/, 'wayfinding should preserve live floorplan state map guidance');
  assert.match(wayfinding, /Apply both `refresh` and `live` socket messages/, 'wayfinding should preserve socket message handling');
  assert.match(wayfinding, /observed timestamp range/, 'wayfinding should preserve signal freshness display guidance');
});

test('Density guidance uses the Modern MCP query route', async () => {
  const density = await readFile(path.join(skillsDir, 'density', 'SKILL.md'), 'utf8');
  const systemPrompt = await readFile(path.join(guidanceDir, 'density-system-prompt.md'), 'utf8');
  const server = await readFile(path.join(pluginRoot, 'mcp-server', 'server.mjs'), 'utf8');
  const benchmarking = await readFile(path.join(skillsDir, 'benchmarking', 'SKILL.md'), 'utf8');
  const setup = await readFile(path.join(skillsDir, 'setup', 'SKILL.md'), 'utf8');
  const dataHealth = await readFile(path.join(skillsDir, 'data-health', 'SKILL.md'), 'utf8');
  const benchmarkMethodology = await readFile(path.join(skillsDir, 'benchmarking', 'references', 'darshan-benchmark-methodology.md'), 'utf8');

  for (const text of [density, systemPrompt]) {
    assert.match(text, /query_db/, 'guidance should name the direct historical query route');
    assert.doesNotMatch(text, /density\.chart-request\.v1|density_analyze|outside the intent enum/i, 'guidance should not require the legacy route');
    assert.match(text, /clarification/, 'guidance should define the clarification path');
    assert.doesNotMatch(text, /answer_density_question|ask_chart|analytic_slide|priorAnalysisId|presentationPlan|signed evidence/i);
  }
  assert.match(systemPrompt, /Bare "utilization" is ambiguous/, 'system prompt should require a qualified utilization metric');
  assert.match(systemPrompt, /Never convert absent data into zero/, 'system prompt should preserve missing-data meaning');
  assert.match(systemPrompt, /Keep the full query result available/, 'system prompt should reject hidden data caps');
  assert.match(systemPrompt, /Presentation-only edits reuse evidence/, 'system prompt should separate presentation changes from evidence changes');
  assert.match(systemPrompt, /Use model judgment for interpretation, metric choice, clarification, and\s+presentation/, 'system prompt should keep semantic choices model-owned');
  assert.match(systemPrompt, /runtime owns authorization, customer isolation, read-only[\s\S]+schema validation, and faithful rendering/, 'system prompt should keep trust boundaries deterministic');
  assert.equal(await exists(path.join(skillsDir, 'utilization')), false, 'historical guidance should not require a separate utilization skill');
  assert.equal(await exists(path.join(skillsDir, 'density', 'references', 'query-context.md')), false, 'query context should be consolidated into the system prompt and schema');
  assert.match(density, /canonical[\s\S]+`density` prompt[\s\S]+guidance\/density-system-prompt\.md/, 'parent skill should preserve the canonical prompt fallback');
  assert.match(density, /Do not search or inspect the global tool inventory/, 'parent skill should skip global tool discovery');
  assert.match(density, /read_mcp_resource\(\{ server: "density", uri: "density:\/\/schema" \}\)/, 'parent skill should name the direct schema call');
  assert.match(density, /mcp__density__query_db/, 'parent skill should name the direct historical tool call');
  assert.match(density, /Read the schema once/, 'parent skill should prevent repeated schema reads');
  assert.match(density, /Do not read the fallback\s+prompt file during a normal Codex turn/, 'parent skill should prevent redundant prompt reads');
  assert.match(density, /displayed and\s+total row counts/, 'parent skill should disclose ranked subsets');
  assert.match(density, /offer\s+the remaining rows or slides/i, 'parent skill should offer omitted ranked results');
  assert.match(density, /Do not use a silent or\s+fixed query row limit/, 'parent skill should preserve the complete query result');
  assert.match(density, /user does not request a displayed count[\s\S]+at most 15 rows/, 'parent skill should keep default ranked bars inside the Brief design');
  for (const text of [density, systemPrompt]) {
    assert.match(text, /Preserve the (?:user's explicit|requested) scope,[\s\S]+(?:period|window)[\s\S]+population[\s\S]+denominator[\s\S]+aggregation[\s\S]+timezone/, 'guidance should preserve every material evidence dimension');
    assert.match(text, /unrounded values for/i, 'guidance should use raw values for semantic decisions');
    assert.match(text, /thresholds|threshold tests/i, 'guidance should use raw values for thresholds');
    assert.match(text, /ordering/i, 'guidance should use raw values for ordering');
    assert.match(text, /comparisons/i, 'guidance should use raw values for comparisons');
    assert.match(text, /Ask before (?:querying|calling `query_db`)[\s\S]+Do not render a\s+chart (?:until|while)/, 'guidance should clarify before querying or rendering');
    assert.match(text, /exact visualization (?:that )?does not fit the[\s\S]+automatically render the nearest\s+truthful, relevant Brief chart/, 'guidance should make an adjacent Brief chart the primary path');
    assert.match(text, /Do not reject the chart[\s\S]+ask permission[\s\S]+one deliberate supported choice/, 'guidance should not negotiate a clear presentation request');
    assert.match(text, /different units, populations,[\s\S]+timezones, denominators[\s\S]+render separate supported\s+Brief charts/, 'guidance should separate incompatible evidence');
    assert.match(text, /Label each chart[\s\S]+Do not imply that\s+related context directly answers a different question/, 'guidance should label adjacent evidence honestly');
    assert.match(text, /no truthful,[\s\S]+relevant visualization exists[\s\S]+state the evidence limit/, 'guidance should stop when no truthful chart exists');
    assert.match(text, /chart fallback cascade[\s\S]+previous renderer/, 'guidance should expose one Brief path without renderer fallbacks');
    assert.match(text, /rejects the deliberate Brief declaration[\s\S]+stop and state the\s+representation limit[\s\S]+Do not retry another body/, 'guidance should stop after an unexpected renderer rejection');
  }
  assert.match(systemPrompt, /one decimal for average occupancy and average time-used labels[\s\S]+whole\s+discrete people, whole rooms, and whole hours[\s\S]+missing values as[\s\S]+missing[\s\S]+Never display them as zero/, 'system prompt should preserve average precision and physical count rules');
  assert.match(density, /Return raw numeric values from SQL[\s\S]+without rounding them[\s\S]+renderer applies display precision[\s\S]+one decimal for average occupancy and average time-used labels[\s\S]+whole\s+discrete people and whole hours/, 'parent skill should preserve raw averages until display');
  assert.match(server, /resolve any material ambiguity[\s\S]+nearest truthful, relevant Brief chart[\s\S]+separate Brief charts[\s\S]+Never use the previous renderer or a chart fallback cascade[\s\S]+do not retry another body/, 'render_chart should expose the centralized adjacent-chart contract');
  assert.match(density, /room question says use, usage, busiest, or utilization[\s\S]+average time-used percentage[\s\S]+not total\s+used hours/, 'parent skill should resolve unqualified room use to utilization percentage');
  assert.match(density, /complete local calendar days[\s\S]+latest complete\s+local[\s\S]+convert its boundaries to UTC[\s\S]+filter `bucket_start` before aggregation/, 'parent skill should filter large metric histories before local-time calculation');
  assert.match(density, /canonical `local_date`, `weekday`, and `hour` fields only after the\s+`bucket_start` filter/, 'parent skill should use canonical local fields after the UTC filter');
  assert.doesNotMatch(density, /round them to whole-number percentages in\s+SQL/, 'parent skill should not discard percentage precision in SQL');
  assert.match(
    density,
    /weekday-hour heatmap[\s\S]+weekday as `entity`[\s\S]+local hour as `time`[\s\S]+percentage as `measure`[\s\S]+Do not use `series`/i,
    'parent skill should declare canonical weekday-hour heatmap roles without a series',
  );
  assert.match(
    systemPrompt,
    /weekday-hour heatmap[\s\S]+weekday as `entity`[\s\S]+local hour as `time`[\s\S]+percentage as `measure`[\s\S]+Do not use `series`/i,
    'system prompt should declare canonical weekday-hour heatmap roles without a series',
  );

  assert.match(benchmarking, /one exact floor/i, 'benchmarking should state exact-floor compatibility');
  assert.match(benchmarking, /single space function/i, 'benchmarking should state single-function compatibility');
  assert.match(benchmarkMethodology, /`avg_used_hours_per_day`[^\n]+`hours_per_day`/, 'benchmark numeric marks should require matching grain and unit');
  assert.match(benchmarkMethodology, /timed out[^\n]+`Local`[^\n]+not `Mixed`/i, 'benchmark timeout should preserve local provenance');
  assert.match(benchmarkMethodology, /local customer metric rows[^\n]+never sent/i, 'benchmark privacy should preserve the local/network boundary');

  assert.match(setup, /`query_db` is advertised/i, 'setup should verify direct query readiness');
  assert.match(setup, /recent-first and still filling in deeper history/i, 'setup should distinguish onboarding background sync from immediate readiness');

  assert.match(dataHealth, /For a how-fresh or how-current local-data question, use `local_data_profile` first\./, 'data-health should use local_data_profile for freshness');
  assert.match(dataHealth, /Use `data_health_report` for missing rows, stale coverage, zero results, sync gaps, and readiness diagnosis\./, 'data-health should reserve data_health_report for diagnosis');
  assert.match(density, /data-health/, 'parent skill should preserve the local data-health route');
  assert.match(systemPrompt, /Do not replace the request with a nearby proxy\./, 'system prompt should preserve metric boundaries');
  assert.match(systemPrompt, /unsupported[\s\S]+capability/, 'system prompt should preserve unsupported-capability boundaries');
});

test('Density OpenAI skill metadata advertises the Modern MCP query route', async () => {
  const densityAgent = await readFile(path.join(skillsDir, 'density', 'agents', 'openai.yaml'), 'utf8');
  const benchmarkingAgent = await readFile(path.join(skillsDir, 'benchmarking', 'agents', 'openai.yaml'), 'utf8');

  assert.match(densityAgent, /query_db/i);
  assert.match(densityAgent, /supplied schema and chart context/i);
  assert.doesNotMatch(densityAgent, /density\.chart-request\.v1|density_analyze|out-of-enum/i);
  assert.doesNotMatch(densityAgent, /local_utilization_query|starter_questions/i);
  assert.match(benchmarkingAgent, /approved, compatible Density benchmark/i);
});

test('Only the parent Density skill allows implicit invocation', async () => {
  for (const skillName of EXPECTED_SKILLS) {
    const agent = await readFile(path.join(skillsDir, skillName, 'agents', 'openai.yaml'), 'utf8');
    const expected = skillName === 'density' ? 'true' : 'false';

    assert.match(
      agent,
      new RegExp(`allow_implicit_invocation: ${expected}\\b`),
      `${skillName} must set allow_implicit_invocation to ${expected}`,
    );
  }
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
    const retiredTools = [
      'local_utilization_query',
      'starter_questions',
    ].filter((tool) => toolNames.includes(tool));

    assert.deepEqual(missingTools, [], `MCP tools/list is missing expected tools:\n${missingTools.join('\n')}`);
    assert.deepEqual(retiredTools, [], `MCP tools/list still exposes retired tools:\n${retiredTools.join('\n')}`);
    for (const legacyTool of LEGACY_ANALYTICS_TOOLS) {
      assert.equal(toolNames.includes(legacyTool), false, `${legacyTool} should be hidden from the default model-visible surface`);
    }
    assert.equal(toolNames.includes('query_db'), true);

    assert.deepEqual(initialized.capabilities, { tools: {}, prompts: {}, resources: {} });
    assert.equal(initialized.instructions, undefined);
    const resources = await client.call('resources/list', {});
    assert.deepEqual(resources.resources.map((resource) => resource.uri), ['density://schema']);
  } finally {
    await client.close();
  }
});

test('MCP has no callable legacy analytics route', async () => {
  const client = await JsonRpcProcess.start({ DENSITY_MCP_EXPOSE_LEGACY_ANALYTICS: '1' });
  try {
    await client.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'density-legacy-surface-test', version: '1.0.0' },
    });
    const listed = await client.call('tools/list', {});
    const toolNames = (listed.tools ?? []).map((tool) => tool.name);
    for (const legacyTool of LEGACY_ANALYTICS_TOOLS) {
      assert.equal(toolNames.includes(legacyTool), false, `${legacyTool} should remain unavailable`);
      const result = await client.call('tools/call', { name: legacyTool, arguments: {} });
      assert.match(result.content[0].text, new RegExp(`Unknown tool: ${legacyTool}`));
    }
    assert.equal(toolNames.includes('query_db'), true);
  } finally {
    await client.close();
  }
});

test('MCP exposes one customer schema resource', async () => {
  const client = await JsonRpcProcess.start();

  try {
    const resources = await client.call('resources/list', {});
    assert.deepEqual(resources.resources.map((resource) => resource.uri), ['density://schema']);
  } finally {
    await client.close();
  }
});

test('MCP exposes the canonical Density prompt without automatic injection', async () => {
  const client = await JsonRpcProcess.start();
  try {
    const initialized = await client.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'density-prompt-test', version: '1.0.0' },
    });
    assert.deepEqual(initialized.capabilities, { tools: {}, prompts: {}, resources: {} });
    assert.equal(initialized.instructions, undefined);
    const listed = await client.call('prompts/list', {});
    assert.deepEqual(listed.prompts.map((prompt) => prompt.name), ['density']);
    const prompt = await client.call('prompts/get', {
      name: 'density',
      arguments: { question: 'Which rooms were busiest?' },
    });
    assert.match(prompt.messages[0].content.text, /^# Density System Prompt$/m);
    assert.match(prompt.messages[0].content.text, /Which rooms were busiest\?/);
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
  static async start(env = {}) {
    const child = spawn(process.execPath, ['mcp-server/server.mjs'], {
      cwd: pluginRoot,
      env: { ...process.env, ...env },
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
