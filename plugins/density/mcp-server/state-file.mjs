import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const cache = new Map();

export async function readStateFile(dataDir) {
  const filePath = path.join(dataDir, 'state.json');
  let stats;
  try {
    stats = await stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.data;
  }
  const data = JSON.parse(await readFile(filePath, 'utf8'));
  cache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, data });
  return data;
}
