import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { closeWarmCliClients, resolveDensityCli, runDensity } from '../scripts/density-lib.mjs';

// A fake CLI that speaks the serve protocol. Every process start appends its
// argv to DENSITY_TEST_CALLS, so a test can count spawned processes.
const fakeCli = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
appendFileSync(process.env.DENSITY_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'capabilities') {
  console.log(JSON.stringify({ commands: { serve: process.env.DENSITY_FAKE_NO_SERVE !== '1' } }));
  process.exit(0);
}
if (args[0] !== 'serve') {
  console.log(JSON.stringify({ mode: 'one-shot', pid: process.pid, argv: args }));
  process.exit(0);
}
if (process.env.DENSITY_FAKE_SERVE_FAIL === '1') {
  console.error('serve is broken');
  process.exit(2);
}
process.stderr.write('density serve ready\\n');
const lines = createInterface({ input: process.stdin, terminal: false });
let chain = Promise.resolve();
lines.on('line', (line) => {
  chain = chain.then(async () => {
    const request = JSON.parse(line);
    const argv = request.argv;
    if (argv.includes('--crash')) process.exit(3);
    if (argv.includes('--garbage')) {
      process.stdout.write('not a protocol line\\n');
      return;
    }
    const sleepIndex = argv.indexOf('--sleep');
    if (sleepIndex !== -1) await new Promise((resolve) => setTimeout(resolve, Number(argv[sleepIndex + 1])));
    const failing = argv.includes('--fail');
    process.stdout.write(JSON.stringify({
      id: request.id,
      code: failing ? 1 : 0,
      stdout: JSON.stringify({ mode: 'serve', pid: process.pid, argv, timeoutMs: request.timeoutMs }),
      stderr: argv.includes('--warn') ? 'careful' : '',
      ...(failing ? { error: 'boom' } : {}),
    }) + '\\n');
  });
});
lines.on('close', () => process.exit(0));
`;

const withFakeCli = async (t, fakeEnv = {}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-serve-client-'));
  const cliPath = path.join(dir, 'density-fake.mjs');
  const calls = path.join(dir, 'calls.jsonl');
  await writeFile(cliPath, fakeCli);
  await chmod(cliPath, 0o755);
  const env = { DENSITY_CLI_BIN: cliPath, DENSITY_TEST_CALLS: calls, ...fakeEnv };
  const prior = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.after(async () => {
    closeWarmCliClients();
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const cli = await resolveDensityCli();
  const spawned = async () => (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)[0]);
  return { cli, dataDir: path.join(dir, 'data'), spawned };
};

const parse = (result) => JSON.parse(result.stdout);

test('runDensity reuses one serve worker for sequential read commands', async (t) => {
  const { cli, dataDir, spawned } = await withFakeCli(t);

  const first = parse(await runDensity(cli, ['status'], { dataDir, allowFailure: true }));
  const second = parse(await runDensity(cli, ['available-buildings', '--format', 'json'], { dataDir, allowFailure: true, timeoutMs: 5000 }));

  assert.equal(first.mode, 'serve');
  assert.equal(second.mode, 'serve');
  assert.equal(first.pid, second.pid);
  assert.deepEqual(second.argv, ['available-buildings', '--format', 'json']);
  assert.equal(second.timeoutMs, 5000);
  assert.deepEqual(await spawned(), ['capabilities', 'serve']);
});

test('runDensity carries serve stderr and errors in the one-shot result shape', async (t) => {
  const { cli, dataDir } = await withFakeCli(t);

  const warned = await runDensity(cli, ['status', '--warn'], { dataDir, allowFailure: true });
  assert.equal(warned.code, 0);
  assert.equal(warned.stderr, 'careful');
  assert.equal(warned.timedOut, false);

  const failed = await runDensity(cli, ['status', '--fail'], { dataDir, allowFailure: true });
  assert.equal(failed.code, 1);
  assert.equal(failed.stderr, '❌ boom');

  await assert.rejects(runDensity(cli, ['status', '--fail'], { dataDir }), /failed \(1\): ❌ boom/);
});

test('a per-request timeout stops the worker and the next call starts a new one', async (t) => {
  const { cli, dataDir, spawned } = await withFakeCli(t);

  const before = parse(await runDensity(cli, ['status'], { dataDir, allowFailure: true }));
  const slow = await runDensity(cli, ['status', '--sleep', '5000'], { dataDir, allowFailure: true, timeoutMs: 100 });
  assert.deepEqual(slow, { code: null, stdout: '', stderr: '', timedOut: true });

  const after = parse(await runDensity(cli, ['status'], { dataDir, allowFailure: true }));
  assert.equal(after.mode, 'serve');
  assert.notEqual(after.pid, before.pid);
  assert.deepEqual(await spawned(), ['capabilities', 'serve', 'serve']);
});

test('a crashed worker fails the in-flight call and recovers on the next call', async (t) => {
  const { cli, dataDir } = await withFakeCli(t);

  const before = parse(await runDensity(cli, ['status'], { dataDir, allowFailure: true }));
  const crashed = await runDensity(cli, ['status', '--crash'], { dataDir, allowFailure: true });
  assert.equal(crashed.code, 1);
  assert.match(crashed.stderr, /serve worker exited \(code 3/);
  assert.equal(crashed.timedOut, false);

  const after = parse(await runDensity(cli, ['status'], { dataDir, allowFailure: true }));
  assert.equal(after.mode, 'serve');
  assert.notEqual(after.pid, before.pid);
});

test('commands outside the allowlist run one-shot', async (t) => {
  const { cli, dataDir, spawned } = await withFakeCli(t);

  assert.equal(parse(await runDensity(cli, ['sync', '--stream', 'spaces'], { dataDir })).mode, 'one-shot');
  assert.equal(parse(await runDensity(cli, ['demo', 'on'], { dataDir })).mode, 'one-shot');
  assert.deepEqual(await spawned(), ['sync', 'demo']);

  assert.equal(parse(await runDensity(cli, ['demo', 'status', '--format', 'json'], { dataDir })).mode, 'serve');
  assert.deepEqual(await spawned(), ['sync', 'demo', 'capabilities', 'serve']);
});

test('DENSITY_MCP_WARM_CLI=0 disables the warm path', async (t) => {
  const { cli, dataDir, spawned } = await withFakeCli(t);

  const result = parse(await runDensity(cli, ['status'], { dataDir, env: { DENSITY_MCP_WARM_CLI: '0' } }));
  assert.equal(result.mode, 'one-shot');
  assert.deepEqual(await spawned(), ['status']);
});

test('a CLI without commands.serve runs one-shot after one capabilities probe', async (t) => {
  const { cli, dataDir, spawned } = await withFakeCli(t, { DENSITY_FAKE_NO_SERVE: '1' });

  assert.equal(parse(await runDensity(cli, ['status'], { dataDir })).mode, 'one-shot');
  assert.equal(parse(await runDensity(cli, ['status'], { dataDir })).mode, 'one-shot');
  assert.deepEqual(await spawned(), ['capabilities', 'status', 'status']);
});

test('a worker that fails to start falls back to one-shot and cools down', async (t) => {
  const { cli, dataDir, spawned } = await withFakeCli(t, { DENSITY_FAKE_SERVE_FAIL: '1' });

  assert.equal(parse(await runDensity(cli, ['status'], { dataDir })).mode, 'one-shot');
  assert.equal(parse(await runDensity(cli, ['status'], { dataDir })).mode, 'one-shot');
  assert.deepEqual(await spawned(), ['capabilities', 'serve', 'status', 'status']);
});

test('a malformed reply falls back to one-shot and cools down', async (t) => {
  const { cli, dataDir, spawned } = await withFakeCli(t);

  assert.equal(parse(await runDensity(cli, ['status', '--garbage'], { dataDir })).mode, 'one-shot');
  assert.equal(parse(await runDensity(cli, ['status'], { dataDir })).mode, 'one-shot');
  assert.deepEqual(await spawned(), ['capabilities', 'serve', 'status', 'status']);
});
