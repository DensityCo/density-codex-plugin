import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '..', 'mcp-server', 'server.mjs');

const callMcp = (child, id, method, params = {}, timeoutMs = 5000) => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`)), timeoutMs);
  const onStdout = (chunk) => {
    stdout += chunk;
    const newline = stdout.indexOf('\n');
    if (newline === -1) return;
    child.stdout.off('data', onStdout);
    clearTimeout(timeout);
    resolve(JSON.parse(stdout.slice(0, newline)));
  };
  child.stdout.on('data', onStdout);
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

const startRemote = async (requests) => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ authorization: request.headers.authorization, message });
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'density-remote-test', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'query_db', description: 'Remote query', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: JSON.stringify({ source: 'remote' }) }] };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
};

test('remote source forwards the MCP session and stays fixed for the task', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'density-mcp-source-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ dataSource: 'remote' }));
  const requests = [];
  const remote = await startRemote(requests);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DENSITY_CLI_DATA_DIR: dataDir,
      DENSITY_REMOTE_MCP_URL: remote.url,
      DENSITY_CLOUD_MCP_TOKEN: 'remote-test-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => remote.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const initialized = await callMcp(child, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'source-test', version: '1.0.0' },
  });
  assert.equal(initialized.result.serverInfo.name, 'density-remote-test');
  const listed = await callMcp(child, 2, 'tools/list');
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ['query_db']);
  const called = await callMcp(child, 3, 'tools/call', {
    name: 'query_db',
    arguments: { sql: 'SELECT 1' },
  });
  assert.equal(JSON.parse(called.result.content[0].text).source, 'remote');
  assert.equal(requests.length, 3);
  assert.equal(requests.every(({ authorization }) => authorization === 'Bearer remote-test-token'), true);

  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ dataSource: 'local' }));
  const changed = await callMcp(child, 4, 'tools/list');
  assert.equal(changed.result.isError, true);
  assert.match(changed.result.content[0].text, /fresh task/u);
  assert.equal(requests.length, 3);
});

test('remote source rejects a client-selected local data directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'density-mcp-source-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ dataSource: 'remote' }));
  const requests = [];
  const remote = await startRemote(requests);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DENSITY_CLI_DATA_DIR: dataDir,
      DENSITY_REMOTE_MCP_URL: remote.url,
      DENSITY_CLOUD_MCP_TOKEN: 'remote-test-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => remote.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  await callMcp(child, 1, 'initialize', { protocolVersion: '2025-06-18' });
  const rejected = await callMcp(child, 2, 'tools/call', {
    name: 'query_db',
    arguments: { sql: 'SELECT 1', dataDir: '/tmp/other-customer' },
  });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /server-selected data source/u);
  assert.equal(requests.length, 1);
  assert.equal((await readFile(path.join(dataDir, 'state.json'), 'utf8')).includes('remote-test-token'), false);
});
