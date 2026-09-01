import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'mcp-server', 'server.mjs');
const systemPromptPath = path.resolve(testDir, '..', 'guidance', 'density-system-prompt.md');
const cliBinPath = process.env.DENSITY_CLI_BIN
  ?? path.resolve(testDir, '..', '..', '..', 'bin', 'density.mjs');
const schemaUri = 'density://schema';

function startServer(env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

function callMcp(child, id, method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline === -1) return;
      child.stdout.off('data', onStdout);
      clearTimeout(timeout);
      const message = JSON.parse(stdout.slice(0, newline));
      resolve(message.error ? message : message.result);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function withServer(env, callback) {
  const child = startServer(env);
  try {
    return await callback(child);
  } finally {
    child.kill('SIGTERM');
  }
}

test('Modern MCP default surface uses query_db, unique tool descriptions, and one schema resource', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-modern-mcp-surface-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    organizationId: 'org_fixture',
    organizationName: 'Fixture',
  }));
  await withServer({ DENSITY_CLI_BIN: cliBinPath, DENSITY_CLI_DATA_DIR: dataDir }, async (child) => {
      const initialized = await callMcp(child, 1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'modern-mcp-surface-test', version: '0.0.0' },
      });
      assert.deepEqual(initialized.capabilities, { tools: {}, prompts: {}, resources: {} });
      assert.equal(initialized.instructions, undefined);

      const listed = await callMcp(child, 2, 'tools/list');
      const toolNames = listed.tools.map(({ name }) => name);
      assert.equal(toolNames.includes('density_analyze'), false);
      assert.equal(toolNames.includes('get_db_schema'), false);
      assert.equal(toolNames.includes('query_db'), true);
      assert.equal(toolNames.includes('configure_brand'), true);
      const brandTool = listed.tools.find(({ name }) => name === 'configure_brand');
      assert.deepEqual(brandTool.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });
      assert.deepEqual(brandTool.inputSchema.required, ['source']);
      assert.match(brandTool.description, /one safe chart accent and one logo/i);
      const queryTool = listed.tools.find(({ name }) => name === 'query_db');
      assert.ok(queryTool, 'query_db should be model-visible');
      assert.deepEqual(queryTool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      assert.match(queryTool.description, /Read density:\/\/schema directly once per question/i);
      assert.match(queryTool.description, /Do not list tools or resources first/i);
      assert.match(queryTool.description, /Prefer one sufficient SELECT/i);
      assert.match(queryTool.description, /Omit dataDir so the host-selected customer profile remains authoritative/i);
      assert.match(queryTool.description, /Do not convert missing measures to zero/i);
      assert.match(queryTool.description, /zero matching counts or only null measures/);
      assert.match(queryTool.description, /Treat a timeout or error as failure, not empty data/);
      assert.match(queryTool.description, /Use the returned evidence ID with render_chart/i);
      assert.match(queryTool.description, /Omit analysis\.window unless the user supplied explicit ISO dates/);
      assert.equal(queryTool.inputSchema.properties.chart, undefined);
      const renderTool = listed.tools.find(({ name }) => name === 'render_chart');
      assert.ok(renderTool, 'render_chart should be model-visible');
      assert.match(renderTool.description, /resolve any material ambiguity/i);
      assert.match(renderTool.description, /nearest truthful, relevant Brief chart/i);
      assert.match(renderTool.description, /separate Brief charts when units, populations, periods, timezones, denominators, or aggregations/i);
      assert.match(renderTool.description, /Reuse the evidence ID when it supports the related chart/i);
      assert.match(renderTool.description, /Never requery to change display formatting/i);
      assert.match(renderTool.inputSchema.properties.chart.properties.columns.items.properties.unit.description, /0–100 scale/i);
      assert.match(renderTool.description, /Never use the previous renderer or a chart fallback cascade/i);
      assert.match(renderTool.description, /stop and state the representation limit; do not retry another body/i);
      const analysisSchema = queryTool.inputSchema.properties.analysis;
      assert.match(analysisSchema.description, /Declared provenance context only/);
      assert.match(analysisSchema.description, /does not prove arbitrary SQL matches user intent/);
      assert.deepEqual(Object.keys(analysisSchema.properties).sort(), [
        'denominator',
        'metric',
        'population',
        'question',
        'scope',
        'timezone',
        'window',
      ]);
      assert.deepEqual(analysisSchema.properties.window, {
        type: 'object',
        description: 'Use only when the user supplied explicit ISO dates. Otherwise omit it and return boundary aliases in the SQL result.',
        properties: {
          start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
        required: ['start', 'end'],
        additionalProperties: false,
      });
      assert.equal(analysisSchema.additionalProperties, false);
      for (const operationalTool of ['setup', 'prepare_floorplans', 'status', 'data_health_report', 'live_wayfinding_status', 'benchmark_compare', 'sensor_health_report', 'storage_report']) {
        assert.equal(toolNames.includes(operationalTool), true, `${operationalTool} should remain model-visible`);
      }
      const sensorHealthTool = listed.tools.find(({ name }) => name === 'sensor_health_report');
      assert.deepEqual(sensorHealthTool.inputSchema.properties.mode.enum, ['current', 'history']);
      assert.deepEqual(sensorHealthTool.inputSchema.properties.interval.enum, ['day']);
      assert.equal(sensorHealthTool.inputSchema.properties.includeChart.default, false);
      assert.deepEqual(sensorHealthTool.inputSchema.properties.status.items, { type: 'string' });
      assert.equal(sensorHealthTool.inputSchema.properties.includeSensors.default, false);
      const floorUsageTool = listed.tools.find(({ name }) => name === 'floor_usage_report');
      assert.ok(floorUsageTool, 'floor_usage_report should remain model-visible');
      assert.equal(floorUsageTool.inputSchema.properties.floorId.type, 'string');
      assert.deepEqual(floorUsageTool.inputSchema.properties.focusSpaceIds.items, { type: 'string', minLength: 1 });
      assert.equal(floorUsageTool.inputSchema.properties.focusSpaceIds.maxItems, 20);
      assert.equal(floorUsageTool.inputSchema.properties.focusSpaceIds.uniqueItems, true);
      assert.match(floorUsageTool.inputSchema.properties.focusSpaceIds.description, /do not create a live availability claim/i);
      assert.deepEqual(listed.tools.find(({ name }) => name === 'local_data_profile').annotations, queryTool.annotations);
      assert.deepEqual(listed.tools.find(({ name }) => name === 'live_wayfinding_status').annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      assert.deepEqual(listed.tools.find(({ name }) => name === 'setup').annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      assert.deepEqual(listed.tools.find(({ name }) => name === 'prepare_floorplans').annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });

      const resourceList = await callMcp(child, 3, 'resources/list');
      assert.deepEqual(
        resourceList.resources.map(({ uri }) => uri),
        [schemaUri],
      );
      assert.match(resourceList.resources.find(({ uri }) => uri === schemaUri).description, /Read this before calling query_db/);

      const schema = await callMcp(child, 4, 'resources/read', { uri: schemaUri });
      assert.equal(schema.contents.length, 1);
      assert.equal(schema.contents[0].uri, schemaUri);
      assert.equal(schema.contents[0].mimeType, 'application/json');
      const schemaPayload = JSON.parse(schema.contents[0].text);
      assert.equal(schemaPayload.kind, 'density.db-schema.v1');
      assert.equal(schemaPayload.dialect, 'duckdb');
      assert.deepEqual(
        schemaPayload.tables.map(({ name }) => name),
        ['density_atlas_spaces_flat', 'density_local_metrics'],
      );
      const cachedSchema = await callMcp(child, 5, 'resources/read', { uri: schemaUri });
      assert.equal(cachedSchema.contents[0].text, schema.contents[0].text);

      const prompt = await callMcp(child, 6, 'prompts/get', {
        name: 'density',
        arguments: { question: 'Which rooms were busiest?' },
      });
      const promptText = prompt.messages[0].content.text;
      const systemPrompt = await readFile(systemPromptPath, 'utf8');
      assert.ok(promptText.includes(systemPrompt));
      assert.match(promptText, /Before calling `query_db`, read the application-controlled resource `density:\/\/schema` directly once/);
      assert.match(promptText, /Do not list tools or resources first/);
      assert.match(promptText, /Which rooms were busiest\?/);

      const invalid = await callMcp(child, 7, 'resources/read', { uri: 'density://schema/other' });
      assert.equal(invalid.error?.code, -32602);
  });
});

test('Modern MCP status reports safe local identity, sync, storage, and readiness', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-status-'));
  try {
    await mkdir(path.join(dataDir, 'parquet', 'spaces'), { recursive: true });
    await mkdir(path.join(dataDir, 'parquet', 'space_labels'), { recursive: true });
    await mkdir(path.join(dataDir, 'parquet', 'space_children'), { recursive: true });
    await mkdir(path.join(dataDir, 'parquet', 'space_metrics'), { recursive: true });
    for (const table of ['resources', 'space_counts', 'space_events', 'space_occupancy', 'data_sources', 'external_records']) {
      await writeFile(path.join(dataDir, 'parquet', `${table}.parquet`), table);
    }
    for (const table of ['spaces', 'space_labels', 'space_children', 'space_metrics']) {
      await writeFile(path.join(dataDir, 'parquet', table, 'part.parquet'), table);
    }
    await writeFile(path.join(dataDir, '.token'), 'secret-access-token');
    await writeFile(path.join(dataDir, '.refresh-token'), 'secret-refresh-token');
    await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
      organizationId: 'org_example',
      organizationName: 'Example Company',
      token: {
        subject: 'usr_example',
        expiresAt: '2099-01-01T00:00:00.000Z',
        secret: 'must-not-leak',
      },
      streams: {
        'org:org_example:metrics:all-spaces:1h': {
          rowsSynced: 120,
          fullSyncCompleted: true,
          lastSyncAt: '2026-08-26T20:00:00.000Z',
          updatedSince: '2026-08-25T00:00:00.000Z',
          nextCursor: 'must-not-leak',
        },
      },
    }));

    await withServer({}, async (child) => {
      await callMcp(child, 1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'density-status-test', version: '0.0.0' },
      });
      const response = await callMcp(child, 2, 'tools/call', {
        name: 'status',
        arguments: { dataDir },
      });
      const status = response.structuredContent;
      assert.equal(status.kind, 'density.status.v1');
      assert.deepEqual(status.identity.organization, { id: 'org_example', name: 'Example Company' });
      assert.deepEqual(status.identity.user, { id: 'usr_example' });
      assert.equal(status.identity.authentication.accessTokenPresent, true);
      assert.equal(status.identity.authentication.refreshTokenPresent, true);
      assert.equal(status.scope.buildingSelection.persisted, false);
      assert.equal(status.sync.latestSyncAt, '2026-08-26T20:00:00.000Z');
      assert.deepEqual(status.sync.streams, [{
        name: 'metrics',
        stateEntries: 1,
        scopes: ['all_spaces'],
        latestSyncAt: '2026-08-26T20:00:00.000Z',
        coverageThrough: '2026-08-25T00:00:00.000Z',
      }]);
      assert.equal(status.storage.parquetFiles, 10);
      assert.equal(status.storage.parquetBytes, 121);
      assert.equal(status.readiness.status, 'ready');
      assert.equal(status.nextAction, undefined);
      const serialized = JSON.stringify(response);
      assert.doesNotMatch(serialized, /secret-access-token|secret-refresh-token|must-not-leak/);
      assert.deepEqual(JSON.parse(response.content[0].text), status);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Modern MCP status recommends sync for an empty local profile', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-empty-status-'));
  try {
    await withServer({}, async (child) => {
      await callMcp(child, 1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'density-empty-status-test', version: '0.0.0' },
      });
      const response = await callMcp(child, 2, 'tools/call', {
        name: 'status',
        arguments: { dataDir },
      });
      assert.equal(response.structuredContent.identity.organization, null);
      assert.equal(response.structuredContent.identity.user, null);
      assert.deepEqual(response.structuredContent.sync.streams, []);
      assert.equal(response.structuredContent.storage.localDataBytes, 0);
      assert.equal(response.structuredContent.readiness.status, 'sync_required');
      assert.equal(response.structuredContent.nextAction.tool, 'onboard_customer');
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Modern MCP rejects non-canonical metric relations before query execution', async () => {
  await withServer({}, async (child) => {
    await callMcp(child, 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'modern-mcp-blocked-relation-test', version: '0.0.0' },
    });
    for (const relation of ['density_atlas_local_metrics', 'density_space_metrics']) {
      const result = await callMcp(child, 2, 'tools/call', {
        name: 'query_db',
        arguments: {
          sql: `SELECT COUNT(*) FROM ${relation}`,
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Use density_local_metrics as the only metric relation/);
    }
  });
});

test('Modern MCP has no legacy analysis route', async () => {
  await withServer({ DENSITY_MCP_EXPOSE_LEGACY_ANALYTICS: '1' }, async (child) => {
    await callMcp(child, 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'modern-mcp-legacy-surface-test', version: '0.0.0' },
    });
    const listed = await callMcp(child, 2, 'tools/list');
    const toolNames = listed.tools.map(({ name }) => name);
    assert.equal(toolNames.includes('density_analyze'), false);
    assert.equal(toolNames.includes('get_db_schema'), false);
    assert.equal(toolNames.includes('query_db'), true);

    const legacyAnalyze = await callMcp(child, 3, 'tools/call', { name: 'density_analyze', arguments: {} });
    assert.match(legacyAnalyze.content[0].text, /Unknown tool: density_analyze/);
    const legacySchema = await callMcp(child, 4, 'tools/call', { name: 'get_db_schema', arguments: {} });
    assert.match(legacySchema.content[0].text, /Unknown tool: get_db_schema/);
  });
});

test('Modern MCP onboarding status returns the standard workflow envelope', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'density-agent-response-'));
  try {
    const onboardingDir = path.join(dataDir, 'onboarding');
    await mkdir(onboardingDir, { recursive: true });
    await writeFile(path.join(onboardingDir, 'deep-history-sync.json'), JSON.stringify({
      kind: 'density.onboarding.deep-history-sync',
      jobId: 'deep-history-eval',
      status: 'running',
    }));

    await withServer({}, async (child) => {
      await callMcp(child, 1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agent-response-eval', version: '0.0.0' },
      });
      const response = await callMcp(child, 2, 'tools/call', {
        name: 'onboarding_status',
        arguments: { dataDir },
      });

      assert.equal(response.structuredContent.contract, 'density.agent-response.v1');
      assert.equal(response.structuredContent.operation, 'onboarding_status');
      assert.equal(response.structuredContent.status, 'in_progress');
      assert.equal(response.structuredContent.terminal, false);
      assert.equal(response.structuredContent.code, 'ONBOARDING_IN_PROGRESS');
      assert.deepEqual(response.structuredContent._next, {
        tool: 'onboarding_status',
        args: { dataDir },
        retryAfterSeconds: 5,
      });
      assert.equal(response.structuredContent.backgroundDeepSync.jobId, 'deep-history-eval');
      assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
