---
name: density
description: Use Density to set up the local Density CLI, prepare Parquet-first customer data, check chart capability, and render Broadsheet-style inline charts when supported.
---

# Density

Use this skill whenever the user wants to install, set up, inspect, sync, demo, or ask questions of local Density data.

The user should interact with Density first. The plugin may use the Density CLI internally, but do not make the user memorize CLI setup details unless something is genuinely blocked.

## Core Workflow

Prefer the plugin MCP tools when available:

- `setup`
- `auth_login`
- `onboard_customer`
- `create_demo_customer`
- `ask_chart`
- `storage_report`
- `starter_questions`

Use the scripts below from the plugin root as the fallback when the MCP tools are not loaded in the current session.

1. Run setup/doctor first when the user is new, unsure, or asking about onboarding:

```bash
node scripts/density-setup.mjs --json
```

If setup returns `update.available: true`, tell the user:

```text
A newer version of the Density plugin is available. Would you like me to install the latest?
```

Only run the returned update command after the user says yes. After updating, ask the user to start a new thread so the latest Density skill and tools load.

2. If setup says local data is missing, use `onboard_customer` or the fallback script. The default path is staged: it may sync cheap metadata, then returns one primary next action for longer metrics/export work instead of hiding a long all-spaces sync.

```bash
node scripts/density-onboard-customer.mjs --json
```

Use explicit full sync only when the user is ready for longer local work:

```bash
node scripts/density-onboard-customer.mjs --full-sync --days=14 --json
```

The default metrics preload is 14 days. Windows up to 7 days use 15-minute metrics; longer windows use hourly metrics so two-week utilization questions stay practical locally.
Explicit full sync prewarms starter-question answers and SVG/HTML chart artifacts when the CLI supports it. Pass `prewarmQuestions: false` only when the user wants raw sync/export without the fast-answer cache.

3. If the user needs demo data from an existing local customer dataset, create a fresh Parquet-first local data dir:

```bash
node scripts/density-demo-customer.mjs \
  --source=/path/to/existing/.density-cli \
  --out=/path/to/demo/.density-cli \
  --days=14 \
  --json
```

This produces canonical `parquet/*.parquet` files plus a small DuckDB catalog of views over Parquet. That is the preferred demo/onboarding shape. Avoid copying or preserving a large hydrated DuckDB file as durable storage.
For fast utilization questions, the demo/onboarding output must include the normalized question inputs as well as generic bulk tables: `spaces`, `space_labels`, `space_children`, and `space_metrics`. If setup reports `fastQuestionsReady: false`, follow its `onboard_customer` action before treating chart answers as useful.

4. Ask a question and render an inline chart when setup reports chart support:

```bash
node scripts/density-ask-chart.mjs \
  --data-dir=/path/to/demo/.density-cli \
  --question="what are the busiest rooms?" \
  --json
```

Then answer in Codex with:

- title
- subtitle
- inline image using the absolute `png` path
- optional artifact paths for SVG and HTML

Example Markdown:

```markdown
![Density chart](/absolute/path/to/chart.png)
```

If `ask_chart` reports unsupported chart capability, say plainly that this CLI/plugin pair does not support chart questions yet and offer the returned next action or `density viz --html` fallback.

5. When checking whether local data can support a fast interactive discussion, use `starter_questions`. On newer CLIs it runs the built-in 100-question pack through `density question --starter --chart --format json` and returns timings plus SVG/HTML artifacts and an artifact manifest path. After a warmup, pass `cached: true` to reopen that manifest quickly. For starter questions and equivalent phrasing, `ask_chart` tries the warmed manifest first through `density question <question> --cached --chart --format ui`, then falls back to live local querying on a cache miss. On older CLIs it returns static suggested questions and an update action.

## Setup Principles

- Keep the setup path short:
  1. Install/enable Density.
  2. Ask Codex: `Set up Density`.
  3. Follow the one primary next action only when setup cannot continue safely.
  4. Ask a question.
- Prefer browser auth. If auth fails, tell the user exactly that the next step is `density auth login`.
- Use `DENSITY_CLI_DATA_DIR` or the script `--data-dir` flag for customer-specific local data.
- The plugin should find the CLI through `DENSITY_CLI_COMMAND`, `DENSITY_CLI_BIN`, `DENSITY_CLI_REPO`, `density` on PATH, or known local development checkouts.
- Prefer explicitly configured or repo-local CLIs over PATH discovery, and report CLI provenance in setup output.
- Do not ask the user to memorize CLI commands unless setup is blocked.

## Storage Rule

Parquet is the durable local store. DuckDB is the query engine and, ideally, a small working catalog/cache.

For customer-scale local data:

- Good: `parquet/*.parquet` is present and DuckDB is small or disposable.
- Good: DuckDB contains views over Parquet for query-only/demo data.
- Suspicious: DuckDB is many times larger than Parquet and treated as the durable artifact.

When reporting storage, include DuckDB and Parquet sizes, expected Parquet table readiness, and a plain next action. Treat DuckDB and Parquet as sensitive local customer data: avoid printing row contents or unnecessary absolute data paths.
For fast question answering, also check `fastQuestionsReady`; generic `parquetReady` alone can still be insufficient if the normalized space metadata is missing.

## Chart Style Rule

Use the Broadsheet/Tufte chart style by default:

- cream background
- large serif title
- short subtitle
- restrained rules
- leaders or shares in muted accent color
- no decorative gradients
- direct labels over legends when practical

When Codex needs inline display, convert SVG to PNG with `rsvg-convert` and embed the PNG.

## Good Test Questions

Known fast paths:

```text
what are the busiest rooms?
what are the least used rooms?
what time are rooms busiest?
what are the busiest phone booths?
what are the busiest rooms and phone booths?
```

Generated related specs:

```text
which room capacities are used most?
which room capacities are used most on weekends?
show me a pie chart of space type breakdown
what kinds of spaces are represented?
```

Filtered variants:

```text
what are the busiest rooms in the morning?
what are the busiest rooms in the afternoon?
when are rooms busiest on weekdays?
```

## Response Shape

For chart answers, use this shape:

```markdown
Title sentence.
Subtitle sentence.

![Short chart alt](/absolute/path/to/chart.png)
```

Keep implementation details out of the first answer unless the user asks how it works.
