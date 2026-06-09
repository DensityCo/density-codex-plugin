#!/usr/bin/env node
import { askChart } from './density-core.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dataDirFlag = args.find((arg) => arg.startsWith('--data-dir='));
const questionFlag = args.find((arg) => arg.startsWith('--question='));
const question = questionFlag
  ? questionFlag.slice('--question='.length)
  : args.filter((arg) => arg !== '--json' && !arg.startsWith('--data-dir=')).join(' ').trim();

if (!question) {
  throw new Error('Usage: density-ask-chart.mjs --question="what are the busiest rooms?" [--data-dir=/path] [--json]');
}

const payload = await askChart({
  dataDir: dataDirFlag ? dataDirFlag.slice('--data-dir='.length) : undefined,
  question,
});

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else if (!payload.ok) {
  console.log(payload.message || payload.error || 'Density chart question is not available.');
  if (payload.nextAction) console.log(`Next action: ${payload.nextAction.label}`);
} else {
  console.log(payload.title);
  console.log(payload.subtitle);
  if (payload.png) console.log(`PNG: ${payload.png}`);
  if (payload.chart) console.log(`SVG: ${payload.chart}`);
  if (payload.html) console.log(`HTML: ${payload.html}`);
}
