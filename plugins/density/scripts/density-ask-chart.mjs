#!/usr/bin/env node
import { defaultDataDir, ensureDensityCliBuilt, parseAskOutput, renderPng, resolveDensityCli, runDensity } from './density-lib.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dataDirFlag = args.find((arg) => arg.startsWith('--data-dir='));
const dataDir = dataDirFlag ? dataDirFlag.slice('--data-dir='.length) : (process.env.DENSITY_CLI_DATA_DIR ?? defaultDataDir());
const questionFlag = args.find((arg) => arg.startsWith('--question='));
const question = questionFlag
  ? questionFlag.slice('--question='.length)
  : args.filter((arg) => arg !== '--json' && !arg.startsWith('--data-dir=')).join(' ').trim();

if (!question) {
  throw new Error('Usage: density-ask-chart.mjs --question="what are the busiest rooms?" [--data-dir=/path] [--json]');
}

const cli = await resolveDensityCli();
if (!cli) {
  throw new Error('Density CLI not found. Set DENSITY_CLI_BIN, DENSITY_CLI_REPO, or install density on PATH.');
}
await ensureDensityCliBuilt(cli);

const answer = await runDensity(cli, ['ask', question, '--chart'], { dataDir });
const parsed = parseAskOutput(answer.stdout);
const png = await renderPng(parsed.chart);
const payload = {
  question,
  title: parsed.title,
  subtitle: parsed.subtitle,
  chart: parsed.chart,
  html: parsed.html,
  png,
  dataDir,
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(payload.title);
  console.log(payload.subtitle);
  if (payload.png) console.log(`PNG: ${payload.png}`);
  if (payload.chart) console.log(`SVG: ${payload.chart}`);
  if (payload.html) console.log(`HTML: ${payload.html}`);
}
