#!/usr/bin/env node
import { setup } from './density-core.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dataDirArg = args.find((arg) => arg.startsWith('--data-dir='));
const dataDir = dataDirArg ? dataDirArg.slice('--data-dir='.length) : undefined;

const result = await setup({ dataDir });

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.ok ? 'Density setup is ready.' : 'Density setup needs attention.');
  for (const check of result.checks) {
    const prefix = check.ok ? 'OK' : check.optional ? 'OPTIONAL' : 'NEEDS';
    console.log(`${prefix} ${check.name}: ${check.detail}`);
  }
  if (result.nextAction) {
    console.log(`Next action: ${result.nextAction.label}`);
  }
}
