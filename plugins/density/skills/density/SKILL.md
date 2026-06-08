---
name: density
description: Use Density to set up the local Density CLI, prepare Parquet-first customer data, ask natural-language questions, and render Broadsheet-style inline charts in Codex.
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

2. If the user needs demo data from an existing local customer dataset, create a fresh Parquet-first local data dir:

```bash
node scripts/density-demo-customer.mjs \
  --source=/path/to/existing/.density-cli \
  --out=/path/to/demo/.density-cli \
  --days=14 \
  --json
```

This produces canonical `parquet/*.parquet` files plus a small DuckDB catalog of views over Parquet. That is the preferred demo/onboarding shape. Avoid copying or preserving a large hydrated DuckDB file as durable storage.

3. Ask a question and render an inline chart:

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

## Setup Principles

- Keep the setup path short:
  1. Install/enable Density.
  2. Run plugin setup.
  3. If needed, run browser auth through `density auth login`.
  4. Ask a question.
- Prefer browser auth. If auth fails, tell the user exactly that the next step is `density auth login`.
- Use `DENSITY_CLI_DATA_DIR` or the script `--data-dir` flag for customer-specific local data.
- The plugin should find the CLI through `DENSITY_CLI_COMMAND`, `DENSITY_CLI_BIN`, `DENSITY_CLI_REPO`, `density` on PATH, or known local development checkouts.

## Storage Rule

Parquet is the durable local store. DuckDB is the query engine and, ideally, a small working catalog/cache.

For customer-scale local data:

- Good: `parquet/*.parquet` is present and DuckDB is small or disposable.
- Good: DuckDB contains views over Parquet for query-only/demo data.
- Suspicious: DuckDB is many times larger than Parquet and treated as the durable artifact.

When reporting storage, include both sizes and explain the split plainly.

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
