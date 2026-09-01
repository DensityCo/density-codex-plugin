import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'mcp-server', 'server.mjs');
const schemaUri = 'density://schema';

// The first schema call returns a partial schema; later calls return the complete schema.
const fakeCli = `#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
const args = process.argv.slice(2);
await appendFile(process.env.DENSITY_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ commands: { getDbSchema: true, getDbSchemaBudget: true, queryDb: true } }));
  process.exit(0);
}
if (args[0] === 'get-db-schema') {
  const calls = (await readFile(process.env.DENSITY_TEST_LOG, 'utf8')).split('\\n').filter((line) => line.includes('"get-db-schema"')).length;
  const partial = calls === 1;
  console.log(JSON.stringify({
    kind: 'density.db-schema.v1',
    organizationId: 'org_fixture',
    dialect: 'duckdb',
    tables: [{
      name: 'density_atlas_spaces_flat',
      sourceTable: 'atlas_spaces_flat',
      columns: [{ table: 'density_atlas_spaces_flat', sourceTable: 'atlas_spaces_flat', name: 'function', type: 'VARCHAR' }],
      valueDomains: partial ? {} : { function: [{ value: 'meeting_room', count: 2 }] },
      valueDomainsState: partial ? 'pending' : 'complete',
    }],
    unknownTables: [],
    buildingScopes: { values: [], truncated: false },
    scaleNotes: [],
    partial,
    ...(partial ? { partialReason: 'The schema budget ended before the value domains and scale notes of density_atlas_spaces_flat loaded. Read the schema again for the full domains.' } : {}),
    rules: [],
    examples: [],
    dataDir: process.env.DENSITY_CLI_DATA_DIR,
    organizationName: 'Fixture',
    derivedDataset: { name: 'local_metrics', state: 'current', reason: 'The local_metrics dataset matches its inputs.' },
  }));
  process.exit(0);
}
console.error('unsupported fake CLI command');
process.exit(1);
`;

function callMcp(child, id, method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`)), timeoutMs);
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

test('schema resource serves a partial schema without an error and caches only a complete schema', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'density-schema-budget-'));
  const cli = path.join(root, 'density-fake.mjs');
  const dataDir = path.join(root, 'data');
  const log = path.join(root, 'commands.jsonl');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ organizationId: 'org_fixture', organizationName: 'Fixture' }));
  await writeFile(log, '');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DENSITY_CLI_BIN: cli, DENSITY_CLI_DATA_DIR: dataDir, DENSITY_TEST_LOG: log },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  });
  await callMcp(child, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'schema-budget-test', version: '0.0.0' } });

  const first = JSON.parse((await callMcp(child, 2, 'resources/read', { uri: schemaUri })).contents[0].text);
  assert.equal(first.ok, undefined);
  assert.equal(first.partial, true);
  assert.match(first.partialReason, /budget ended/);
  assert.equal(first.tables[0].valueDomainsState, 'pending');
  assert.equal(first.organizationName, 'Fixture');
  assert.equal(Object.hasOwn(first, 'dataDir'), false);
  assert.equal(Object.hasOwn(first, 'derivedDataset'), false);

  const second = await callMcp(child, 3, 'resources/read', { uri: schemaUri });
  const complete = JSON.parse(second.contents[0].text);
  assert.equal(complete.partial, false);
  assert.deepEqual(complete.tables[0].valueDomains, { function: [{ value: 'meeting_room', count: 2 }] });

  const third = await callMcp(child, 4, 'resources/read', { uri: schemaUri });
  assert.equal(third.contents[0].text, second.contents[0].text);

  const schemaCommands = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(([command]) => command === 'get-db-schema');
  assert.equal(schemaCommands.length, 2);
  assert.ok(schemaCommands.every((args) => args.includes('--budget-ms') && args[args.indexOf('--budget-ms') + 1] === '10000'));
});
