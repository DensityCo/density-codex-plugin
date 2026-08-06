#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { historicalExport } from './density-core.mjs';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const statusFile = valueAfter('--status-file');
const dataDir = valueAfter('--data-dir');
const orgId = valueAfter('--org');
const days = Number(valueAfter('--days'));
const recentDays = Number(valueAfter('--recent-days'));

if (!statusFile || !dataDir || !Number.isInteger(days) || !Number.isInteger(recentDays)) {
  throw new Error('Usage: density-background-deep-sync.mjs --data-dir <dir> --days <n> --recent-days <n> --status-file <file> [--org <org_id>]');
}

const nowIso = () => new Date().toISOString();

const readStatus = async () => {
  try {
    return JSON.parse(await readFile(statusFile, 'utf8'));
  } catch {
    return {};
  }
};

const writeStatus = async (patch) => {
  await mkdir(path.dirname(statusFile), { recursive: true });
  const current = await readStatus();
  const tempFile = `${statusFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify({
    ...current,
    ...patch,
    updatedAt: nowIso(),
  }, null, 2)}\n`);
  await rename(tempFile, statusFile);
};

try {
  await writeStatus({
    status: 'running',
    olderHistoryWindow: {
      since: `${days}d`,
      until: `${recentDays}d`,
    },
  });
  const result = await historicalExport({
    dataDir,
    orgId,
    days,
    until: `${recentDays}d`,
  });
  await writeStatus({
    status: result.ok ? 'complete' : 'failed',
    completedAt: nowIso(),
    result,
  });
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  await writeStatus({
    status: 'failed',
    completedAt: nowIso(),
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
