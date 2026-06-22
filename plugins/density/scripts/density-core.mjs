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

export const DEFAULT_METRICS_DAYS = 14;
export const MAX_METRICS_DAYS = 14;
export const MAX_15M_METRICS_DAYS = 7;

export const resolveDataDir = (value) => value || process.env.DENSITY_CLI_DATA_DIR || defaultDataDir();

const oneLine = (value) => String(value ?? '').trim();

const addCheck = (checks, name, ok, detail, extra = {}) => {
  checks.push({ name, ok, detail, ...extra });
};

export const primaryNextAction = (actions) => actions.find(Boolean);

export const toNextSteps = (action) => action ? [action.label] : [];

const starterUsefulness = (readiness) => {
  const nonzeroAnswerCount = Number(readiness?.nonzeroAnswerCount ?? 0);
  const useful = nonzeroAnswerCount > 0;
  return {
    useful,
    nonzeroAnswerCount,
    reason: useful
      ? undefined
      : 'Starter-question cache is warmed, but no starter answers have nonzero utilization. Local data may be empty or missing space metadata.',
  };
};

const starterReadyDetail = (starterCache, fallbackCount) => {
  if (!starterCache.ready) return starterCache.reason ?? 'Starter-question answers are not ready yet.';
  const count = starterCache.questionCount ?? fallbackCount ?? 'Starter';
  const cacheState = starterCache.cache?.hit ? 'cache hit' : 'cache warmed';
  if (starterCache.useful === false) {
    return `${count} answers ready; ${cacheState}; 0 nonzero utilization answers. Local data may be empty or missing space metadata.`;
  }
  return `${count} answers ready; ${cacheState}`;
};

const hasResourcesParquet = (storage) => Boolean(storage.tables?.find((table) => table.table === 'resources')?.present);

export async function checkStarterCache(cli, dataDir) {
  const result = await runDensity(cli, ['question', '--starter', '--cached', '--cache-only', '--format', 'json'], {
    dataDir,
    allowFailure: true,
    timeoutMs: 10000,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      checked: true,
      ready: false,
      reason: result.timedOut ? 'Starter-question cache check timed out.' : oneLine(result.stderr || result.stdout),
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const usefulness = starterUsefulness(parsed.readiness);
    return {
      checked: true,
      ready: Boolean(parsed.readiness?.ready),
      ...usefulness,
      readiness: parsed.readiness,
      artifactManifest: parsed.artifactManifest,
      cache: parsed.cache,
      questionCount: parsed.questionCount,
      reason: parsed.reason,
    };
  } catch (error) {
    return {
      checked: true,
      ready: false,
      reason: `Starter-question cache response was not JSON: ${error.message}`,
    };
  }
}

export async function setup(args = {}) {
  const dataDir = resolveDataDir(args.dataDir);
  const checks = [];
  const cli = await resolveDensityCli();
  addCheck(checks, 'density cli found', Boolean(cli), cli?.source ?? 'Set DENSITY_CLI_BIN or install density on PATH.', {
    cli: safeCliInfo(cli),
  });

  let capabilities = { checked: false, chartQuestions: false, reason: 'Density CLI not found.' };
  let status;
  let buildError;
  if (cli) {
    try {
      const build = await ensureDensityCliBuilt(cli);
      addCheck(checks, 'density cli built', true, build.reason);
    } catch (error) {
      buildError = error instanceof Error ? error.message : String(error);
      addCheck(checks, 'density cli built', false, buildError);
    }
    if (!buildError) {
      capabilities = await discoverCliCapabilities(cli, { dataDir });
      addCheck(
        checks,
        'density chart capability known',
        capabilities.checked,
        capabilities.checked
          ? (capabilities.chartQuestions ? 'chart questions supported' : 'chart questions not supported by this CLI')
          : capabilities.reason
      );
      addCheck(
        checks,
        'fast local question answering advertised',
        Boolean(capabilities.questionAnswering?.localFirst && capabilities.commands?.questionStarter),
        capabilities.questionAnswering?.localFirst && capabilities.commands?.questionStarter
          ? `${capabilities.questionAnswering.starterQuestionCount ?? '50+'} starter questions; target ${capabilities.questionAnswering.targetTextAnswerMs ?? 5000}ms text / ${capabilities.questionAnswering.targetChartAnswerMs ?? 10000}ms charts`
          : 'CLI does not advertise the fast local utilization question contract yet.'
      );
      status = await runDensity(cli, ['status'], { dataDir, allowFailure: true });
      addCheck(
        checks,
        'density status runs',
        status.code === 0,
        status.code === 0 ? 'status completed' : oneLine(status.stderr || status.stdout)
      );
    }
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
  if (capabilities.commands?.questionStarter) {
    addCheck(
      checks,
      'fast question parquet ready',
      storage.fastQuestionsReady,
      storage.fastQuestionsReady
        ? `${storage.fastQuestionBytes} bytes across fast question tables`
        : `Missing fast question tables: ${storage.fastQuestionTables.filter((table) => !table.present).map((table) => table.table).join(', ') || 'unknown'}. Run full onboarding/export to sync spaces and metrics.`,
    );
  }
  let starterCache;
  if (cli && storage.parquetReady && storage.fastQuestionsReady && capabilities.commands?.questionStarter) {
    starterCache = await checkStarterCache(cli, dataDir);
    addCheck(
      checks,
      'fast starter answers ready',
      starterCache.ready && starterCache.useful !== false,
      starterReadyDetail(starterCache, capabilities.questionAnswering?.starterQuestionCount),
      { optional: true, starterCache }
    );
  }

  const update = await checkPluginUpdate();
  const nextAction = primaryNextAction([
    !cli && {
      id: 'configure_cli',
      label: 'Install or point Codex at the Density CLI.',
      command: 'Set DENSITY_CLI_BIN or install density on PATH.',
    },
    buildError && {
      id: 'install_supported_node',
      label: 'Switch to Node 24 and rebuild the Density CLI.',
      command: 'Use Node.js 24, then run npm install && npm run build in the Density CLI checkout.',
    },
    cli && status && status.code !== 0 && /Token|auth|Authorization|login/i.test(status.stderr || status.stdout) && {
      id: 'auth_login',
      label: 'Run Density browser auth.',
      tool: 'auth_login',
      command: 'density auth login',
    },
    cli && status?.code === 0 && storage.parquetReady && capabilities.commands?.questionStarter && !storage.fastQuestionsReady && capabilities.commands?.repairFastQuestions && hasResourcesParquet(storage) && {
      id: 'repair_fast_questions',
      label: 'Repair local fast-question metadata from resources.parquet.',
      tool: 'repair_fast_questions',
      args: { dataDir },
      command: 'density repair fast-questions --format json',
    },
    cli && status?.code === 0 && (!storage.parquetReady || (capabilities.commands?.questionStarter && !storage.fastQuestionsReady)) && {
      id: 'onboard_customer',
      label: 'Prepare local Density data.',
      tool: 'onboard_customer',
      args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true },
      command: `density sync --stream spaces && density sync --stream metrics --all-spaces --since ${DEFAULT_METRICS_DAYS}d --until now --interval ${metricsIntervalForDays(DEFAULT_METRICS_DAYS)} && density export parquet --out ${path.join(dataDir, 'parquet')} --all-orgs`,
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
    starterCache,
    update,
    nextAction,
    nextSteps: toNextSteps(nextAction),
    userVisiblePrimaryActions: nextAction ? 1 : 0,
  };
}

export async function repairFastQuestions(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const result = await runDensity(cli, ['repair', 'fast-questions', '--format', 'json'], {
    dataDir,
    allowFailure: true,
    timeoutMs: 30000,
  });
  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      dataDir,
      cli: safeCliInfo(cli),
      error: result.timedOut ? 'Fast-question repair timed out.' : oneLine(result.stderr || result.stdout),
      storage: await storageReport(dataDir),
      nextAction: {
        id: 'onboard_customer',
        label: 'Prepare local Density data.',
        tool: 'onboard_customer',
        args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true },
      },
      nextSteps: ['Prepare local Density data.'],
      userVisiblePrimaryActions: 1,
    };
  }
  let repair;
  try {
    repair = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      dataDir,
      cli: safeCliInfo(cli),
      error: `Fast-question repair response was not JSON: ${error.message}`,
      stdout: oneLine(result.stdout),
      storage: await storageReport(dataDir),
    };
  }
  const storage = await storageReport(dataDir);
  return {
    ok: storage.fastQuestionsReady,
    dataDir,
    cli: safeCliInfo(cli),
    repair,
    storage,
    nextAction: storage.fastQuestionsReady ? undefined : {
      id: 'onboard_customer',
      label: 'Prepare local Density data.',
      tool: 'onboard_customer',
      args: { dataDir, days: DEFAULT_METRICS_DAYS, fullSync: true },
    },
    nextSteps: storage.fastQuestionsReady ? [] : ['Prepare local Density data.'],
    userVisiblePrimaryActions: storage.fastQuestionsReady ? 0 : 1,
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
  const prewarmQuestions = args.prewarmQuestions !== false;
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
  const runOptionalStep = async (name, commandArgs, options = {}) => {
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
      optional: true,
      timedOut: result.timedOut,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      stdout: oneLine(result.stdout),
      stderr: oneLine(result.stderr),
    };
    steps.push(step);
    return step;
  };

  try {
    if (args.orgId) await runStep('select organization', ['org', 'use', args.orgId]);
    await runStep('sync spaces', ['sync', '--stream', 'spaces']);
    const metricsCommand = ['sync', '--stream', 'metrics', '--all-spaces', '--since', `${days}d`, '--until', 'now', '--interval', metricsIntervalForDays(days)];
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
    let starterQuestions;
    if (storage.parquetReady && storage.fastQuestionsReady && prewarmQuestions) {
      const capabilities = await discoverCliCapabilities(cli, { dataDir });
      if (capabilities.commands?.questionStarter) {
        const step = await runOptionalStep('prewarm starter questions', ['question', '--starter', '--chart', '--format', 'json'], { timeoutMs });
        if (step.ok) {
          try {
            const parsed = JSON.parse(step.stdout);
            starterQuestions = {
              ok: true,
              ready: Boolean(parsed.readiness?.ready),
              ...starterUsefulness(parsed.readiness),
              readiness: parsed.readiness,
              artifactManifest: parsed.artifactManifest,
              cache: parsed.cache,
              questionCount: parsed.questionCount,
            };
          } catch (error) {
            starterQuestions = {
              ok: false,
              error: `Starter-question response was not JSON: ${error.message}`,
            };
          }
        } else {
          starterQuestions = {
            ok: false,
            error: step.timedOut ? 'Starter-question prewarm timed out.' : step.stderr || step.stdout,
          };
        }
      } else {
        starterQuestions = {
          ok: false,
          skipped: true,
          reason: 'Density CLI does not support starter-question prewarm.',
        };
      }
    }
    return {
      ok: storage.parquetReady && (!prewarmQuestions || storage.fastQuestionsReady),
      mode: 'full-sync',
      dataDir,
      days,
      cli: safeCliInfo(cli),
      steps,
      storage,
      starterQuestions,
      nextAction: storage.parquetReady && storage.fastQuestionsReady ? undefined : {
        id: 'export_parquet',
        label: 'Export Parquet after sync completes.',
        command: `density ${exportCommand.join(' ')}`,
      },
      nextSteps: storage.parquetReady && storage.fastQuestionsReady ? [] : ['Export Parquet after sync completes.'],
      userVisiblePrimaryActions: storage.parquetReady && storage.fastQuestionsReady ? 0 : 1,
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

  if (capabilities.generativeUi?.renderer === 'json-render' || capabilities.commands?.questionUi) {
    const cachedUiAnswer = await runDensity(cli, ['question', question, '--cached', '--chart', '--format', 'ui'], { dataDir, allowFailure: true });
    const uiAnswer = cachedUiAnswer.code === 0
      ? cachedUiAnswer
      : await runDensity(cli, ['question', question, '--chart', '--format', 'ui'], { dataDir, allowFailure: true });
    if (uiAnswer.code === 0) {
      let ui;
      try {
        ui = JSON.parse(uiAnswer.stdout);
      } catch (error) {
        throw new Error(`Density UI response was not JSON: ${error.message}`);
      }
      const answerProps = ui.jsonRender?.spec?.elements?.answer?.props ?? {};
      const svg = ui.artifacts?.svg ?? ui.jsonRender?.spec?.state?.artifacts?.svg;
      const html = ui.artifacts?.html ?? ui.jsonRender?.spec?.state?.artifacts?.html;
      const png = await renderPng(svg);
      return {
        ok: true,
        question,
        title: answerProps.title ?? '',
        subtitle: answerProps.subtitle ?? '',
        chart: svg,
        html,
        png,
        cache: ui.cache,
        ui,
        dataDir,
        cli: safeCliInfo(cli),
        capabilities,
      };
    }
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

export async function starterQuestions(args = {}) {
  const cli = await requireCli();
  const dataDir = resolveDataDir(args.dataDir);
  const capabilities = await discoverCliCapabilities(cli, { dataDir });
  const questions = {
    known: [
      'what are the busiest rooms?',
      'what are the least used rooms?',
      'what time are rooms busiest?',
    ],
    generated: [
      'which room capacities are used most?',
      'which room capacities are used most on weekends?',
      'show me a pie chart of space type breakdown',
      'what kinds of spaces are represented?',
    ],
  };

  if (!capabilities.commands?.questionStarter) {
    return {
      ok: false,
      unsupported: true,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      questions,
      message: 'This Density CLI does not support fast starter-question runs yet.',
      nextAction: {
        id: 'update_cli_for_starter_questions',
        label: 'Update/build a Density CLI that supports density question --starter.',
        command: 'density capabilities --format json',
      },
      userVisiblePrimaryActions: 1,
    };
  }

  const command = ['question', '--starter', '--format', 'json'];
  if (args.chart !== false) command.push('--chart');
  if (args.cached === true) command.push('--cached');
  const answer = await runDensity(cli, command, { dataDir, allowFailure: true });
  if (answer.code !== 0) {
    return {
      ok: false,
      dataDir,
      cli: safeCliInfo(cli),
      capabilities,
      questions,
      error: oneLine(answer.stderr || answer.stdout),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(answer.stdout);
  } catch (error) {
    throw new Error(`Density starter-question response was not JSON: ${error.message}`);
  }

  return {
    ok: true,
    ready: Boolean(parsed.readiness?.ready),
    ...starterUsefulness(parsed.readiness),
    readiness: parsed.readiness,
    dataDir,
    cli: safeCliInfo(cli),
    capabilities,
    questions,
    result: parsed,
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
  if (!Number.isInteger(days) || days <= 0 || days > MAX_METRICS_DAYS) {
    throw new Error(`days must be an integer between 1 and ${MAX_METRICS_DAYS} for metrics preload.`);
  }
  return days;
}

export function metricsIntervalForDays(days) {
  return days <= MAX_15M_METRICS_DAYS ? '15m' : '1h';
}

export function boundedGenericDays(value) {
  const days = value === undefined ? 14 : Number(value);
  if (!Number.isInteger(days) || days <= 0 || days > 60) {
    throw new Error('days must be an integer between 1 and 60.');
  }
  return days;
}
