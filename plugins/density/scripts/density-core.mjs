import path from 'node:path';
import os from 'node:os';
import {
  checkPluginUpdate,
  defaultDataDir,
  discoverCliCapabilities,
  ensureDensityCliBuilt,
  renderPng,
  resolveDensityCli,
  runDensity,
  safeCliInfo,
  storageReport,
  which,
} from './density-lib.mjs';

export const DEFAULT_METRICS_DAYS = 7;
export const MAX_15M_METRICS_DAYS = 7;

export const resolveDataDir = (value) => value || process.env.DENSITY_CLI_DATA_DIR || defaultDataDir();

const oneLine = (value) => String(value ?? '').trim();

const addCheck = (checks, name, ok, detail, extra = {}) => {
  checks.push({ name, ok, detail, ...extra });
};

export const primaryNextAction = (actions) => actions.find(Boolean);

export const toNextSteps = (action) => action ? [action.label] : [];

export async function setup(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const checks = [];
  const cli = await resolveDensityCli();
  addCheck(checks, 'density cli found', Boolean(cli), cli?.source ?? 'Set DENSITY_CLI_BIN or install density on PATH.', {
    cli: safeCliInfo(cli),
  });

  let capabilities = { checked: false, chartQuestions: false, reason: 'Density CLI not found.' };
  let status;
  if (cli) {
    const build = await ensureDensityCliBuilt(cli);
    addCheck(checks, 'density cli built', true, build.reason);
    capabilities = await discoverCliCapabilities(cli, { dataDir });
    addCheck(
      checks,
      'density chart capability known',
      capabilities.checked,
      capabilities.checked
        ? (capabilities.chartQuestions ? 'chart questions supported' : 'chart questions not supported by this CLI')
        : capabilities.reason
    );
    status = await runDensity(cli, ['status'], { dataDir, allowFailure: true });
    addCheck(
      checks,
      'density status runs',
      status.code === 0,
      status.code === 0 ? 'status completed' : oneLine(status.stderr || status.stdout)
    );
  }

  addCheck(checks, 'svg to png renderer found', Boolean(await which('rsvg-convert')), 'Optional: used for inline Codex PNG chart previews.', { optional: true });
  addCheck(checks, 'duckdb cli found', Boolean(await which('duckdb')), 'Optional: used for demo customer Parquet slicing.', { optional: true });

  const storage = await storageReport(dataDir);
  addCheck(
    checks,
    'canonical parquet ready',
    storage.parquetReady,
    storage.parquetReady ? `${storage.parquetBytes} bytes across expected tables` : 'Parquet export is missing or incomplete.'
  );

  const update = await checkPluginUpdate();
  const nextAction = primaryNextAction([
    !cli && {
      id: 'configure_cli',
      label: 'Install or point Codex at the Density CLI.',
      command: 'Set DENSITY_CLI_BIN or install density on PATH.',
    },
    cli && status?.code !== 0 && /Token|auth|Authorization|login/i.test(status.stderr || status.stdout) && {
      id: 'auth_login',
      label: 'Run Density browser auth.',
      tool: 'auth_login',
      command: 'density auth login',
    },
    cli && status?.code === 0 && !storage.parquetReady && {
      id: 'onboard_customer',
      label: 'Prepare local Density data.',
      tool: 'onboard_customer',
      command: `density sync --stream metrics --all-spaces --since ${DEFAULT_METRICS_DAYS}d --until now --interval 15m`,
    },
    cli && status?.code === 0 && storage.parquetReady && !capabilities.chartQuestions && {
      id: 'chart_unsupported',
      label: 'Update the Density CLI for chart questions, or use local query/viz commands.',
      command: 'density capabilities --format json',
    },
    update.available && {
      id: 'plugin_update',
      label: update.prompt,
      command: update.command,
    },
  ]);

  return {
    ok: checks.every((check) => check.ok || check.optional),
    dataDir,
    cli: safeCliInfo(cli),
    checks,
    capabilities,
    storage,
    update,
    nextAction,
    nextSteps: toNextSteps(nextAction),
    userVisiblePrimaryActions: nextAction ? 1 : 0,
  };
}

export async function authLogin(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const result = await runDensity(cli, ['auth', 'login'], { dataDir, allowFailure: true });
  return {
    ok: result.code === 0,
    dataDir,
    cli: safeCliInfo(cli),
    stdout: oneLine(result.stdout),
    stderr: oneLine(result.stderr),
  };
}

export async function onboardCustomer(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const days = boundedMetricsDays(args.days);
  const fullSync = Boolean(args.fullSync);
  const timeoutSeconds = Number.isFinite(Number(args.timeoutSeconds)) ? Number(args.timeoutSeconds) : 110;
  const steps = [];
  const runStep = async (name, commandArgs, options = {}) => {
    const startedAt = Date.now();
    const result = await runDensity(cli, commandArgs, {
      dataDir,
      allowFailure: true,
      timeoutMs: options.timeoutMs,
    });
    const step = {
      name,
      command: ['density', ...commandArgs].join(' '),
      ok: result.code === 0 && !result.timedOut,
      timedOut: result.timedOut,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      stdout: oneLine(result.stdout),
      stderr: oneLine(result.stderr),
    };
    steps.push(step);
    if (!step.ok) {
      throw Object.assign(new Error(`${name} failed: ${step.timedOut ? 'timed out' : step.stderr || step.stdout}`), { steps });
    }
    return step;
  };

  try {
    if (args.orgId) await runStep('select organization', ['org', 'use', args.orgId]);
    await runStep('sync spaces', ['sync', '--stream', 'spaces']);
    const metricsCommand = ['sync', '--stream', 'metrics', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', '15m'];
    const occupancyCommand = ['sync', '--stream', 'occupancy', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', '1h'];
    const exportCommand = ['export', 'parquet', '--out', path.join(dataDir, 'parquet'), '--all-orgs'];

    if (!fullSync) {
      const storage = await storageReport(dataDir);
      return {
        ok: true,
        mode: 'staged',
        dataDir,
        days,
        cli: safeCliInfo(cli),
        steps,
        storage,
        nextAction: {
          id: 'run_full_sync',
          label: 'Run explicit full sync when ready.',
          tool: 'onboard_customer',
          args: { dataDir, days, fullSync: true },
          command: `density ${metricsCommand.join(' ')}`,
        },
        nextSteps: ['Run explicit full sync when ready.'],
        userVisiblePrimaryActions: 1,
      };
    }

    const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
    await runStep('sync meeting-room metrics', metricsCommand, { timeoutMs });
    await runStep('sync occupancy overview', occupancyCommand, { timeoutMs });
    await runStep('export parquet', exportCommand, { timeoutMs });
    const storage = await storageReport(dataDir);
    return {
      ok: storage.parquetReady,
      mode: 'full-sync',
      dataDir,
      days,
      cli: safeCliInfo(cli),
      steps,
      storage,
      nextAction: storage.parquetReady ? undefined : {
        id: 'export_parquet',
        label: 'Export Parquet after sync completes.',
        command: `density ${exportCommand.join(' ')}`,
      },
      nextSteps: storage.parquetReady ? [] : ['Export Parquet after sync completes.'],
      userVisiblePrimaryActions: storage.parquetReady ? 0 : 1,
    };
  } catch (error) {
    return {
      ok: false,
      mode: fullSync ? 'full-sync' : 'staged',
      dataDir,
      days,
      cli: safeCliInfo(cli),
      steps: error.steps ?? steps,
      error: oneLine(error.message),
      storage: await storageReport(dataDir),
      nextAction: {
        id: 'resume_onboarding',
        label: 'Resume Density onboarding after resolving the failed step.',
      },
      nextSteps: ['Resume Density onboarding after resolving the failed step.'],
      userVisiblePrimaryActions: 1,
    };
  }
}

export async function askChart(args = {}) {
  const question = String(args.question || '').trim();
  if (!question) throw new Error('question is required.');
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const capabilities = await discoverCliCapabilities(cli, { dataDir });
  if (!capabilities.chartQuestions) {
    return {
      ok: false,
      unsupported: true,
      question,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      message: 'This Density CLI does not support chart questions yet.',
      nextAction: {
        id: 'update_cli_for_chart_questions',
        label: 'Update/build a Density CLI that supports chart questions, or use density viz --html.',
        command: 'density capabilities --format json',
      },
      userVisiblePrimaryActions: 1,
    };
  }

  const answer = await runDensity(cli, ['ask', question, '--chart', '--format', 'json'], { dataDir, allowFailure: true });
  if (answer.code !== 0) {
    return {
      ok: false,
      question,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      error: oneLine(answer.stderr || answer.stdout),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(answer.stdout);
  } catch (error) {
    throw new Error(`Density chart response was not JSON: ${error.message}`);
  }
  const png = await renderPng(parsed.chart);
  return {
    ok: true,
    question,
    title: parsed.title ?? '',
    subtitle: parsed.subtitle ?? '',
    chart: parsed.chart,
    html: parsed.html,
    png,
    dataDir,
    cli: safeCliInfo(cli),
    capabilities,
  };
}

export async function createDemoCustomer(args = {}) {
  const sourceDir = args.sourceDir || path.join(os.homedir(), '.density-cli-linkedin');
  const outDir = args.outDir || path.join(os.homedir(), '.density-cli-demo-customer');
  const days = boundedGenericDays(args.days);
  return { sourceDir, outDir, days };
}

export async function requireCli() {
  const cli = await resolveDensityCli();
  if (!cli) throw new Error('Density CLI not found. Set DENSITY_CLI_BIN, DENSITY_CLI_REPO, or install density on PATH.');
  await ensureDensityCliBuilt(cli);
  return cli;
}

export function boundedMetricsDays(value) {
  const days = value === undefined ? DEFAULT_METRICS_DAYS : Number(value);
  if (!Number.isInteger(days) || days <= 0 || days > MAX_15M_METRICS_DAYS) {
    throw new Error(`days must be an integer between 1 and ${MAX_15M_METRICS_DAYS} for 15-minute metrics.`);
  }
  return days;
}

export function boundedGenericDays(value) {
  const days = value === undefined ? 14 : Number(value);
  if (!Number.isInteger(days) || days <= 0 || days > 60) {
    throw new Error('days must be an integer between 1 and 60.');
  }
  return days;
}
