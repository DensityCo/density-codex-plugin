#!/usr/bin/env node
import { onboardCustomer } from './density-core.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dataDirFlag = args.find((arg) => arg.startsWith('--data-dir='));
const orgFlag = args.find((arg) => arg.startsWith('--org='));
const daysFlag = args.find((arg) => arg.startsWith('--days='));
const backgroundDaysFlag = args.find((arg) => arg.startsWith('--background-days='));
const timeoutFlag = args.find((arg) => arg.startsWith('--timeout-seconds='));

const payload = await onboardCustomer({
  dataDir: dataDirFlag ? dataDirFlag.slice('--data-dir='.length) : undefined,
  orgId: orgFlag?.slice('--org='.length),
  days: daysFlag ? Number(daysFlag.slice('--days='.length)) : undefined,
  fullSync: args.includes('--full-sync'),
  backgroundDeepSync: args.includes('--no-background-deep-sync') ? false : undefined,
  backgroundDeepSyncDays: backgroundDaysFlag ? Number(backgroundDaysFlag.slice('--background-days='.length)) : undefined,
  timeoutSeconds: timeoutFlag ? Number(timeoutFlag.slice('--timeout-seconds='.length)) : undefined,
});

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(payload.ok ? `Prepared Density customer data: ${payload.dataDir}` : `Density onboarding needs attention: ${payload.dataDir}`);
  for (const step of payload.steps) console.log(`${step.ok ? 'OK' : 'NEEDS'} ${step.name} (${step.seconds}s)`);
  if (payload.nextAction) console.log(`Next action: ${payload.nextAction.label}`);
}
