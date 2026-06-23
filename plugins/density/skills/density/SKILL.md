---
name: density
description: Use Density as the parent router for local-first workplace analytics, setup, floorplans, wayfinding, utilization, benchmarking, sensor health, data health, and visual artifacts.
---

# Density

Use this skill whenever the user wants to install, set up, inspect, sync, demo, or ask questions of Density data.

The user should interact with Density first. The plugin may use the Density CLI internally, but do not make the user memorize CLI setup details unless something is genuinely blocked.

## Interaction Contract

Answer like a concise workplace and buildings expert:

- Lead with the practical answer, then add only the source, freshness, and caveat needed to trust it.
- Treat understanding as comparative. Do not present an important stat by itself. Pair it with the denominator, capacity, baseline, previous period, peer floor, building average, portfolio average, or another known comparison that makes the number interpretable.
- When useful and available, use this comparison ladder: measured value, nearest internal customer comparison, then a named Density benchmark segment from `benchmark_compare` or an approved benchmark source. Do not imply a benchmark is another customer's data; Density benchmarks must be generalized and display-safe.
- Define operational terms in place the first time they affect interpretation. For example, write "working day (8am-6pm local time, weekdays)" or "business hours (9am-5pm in the building timezone)" instead of assuming the user knows the window.
- Keep tool mechanics out of user-facing prose unless the user asks how it works, an action is blocked, or the exact command/tool name changes what they should do next.
- For ambiguous scope, ask one crisp clarifying question before querying: building, floor, space type, time window, or whether they mean current availability versus historical utilization.
- Keep live/current truth separate from historical/local truth. Use live sources for now/open/available questions; use local historical data for trends, busiest spaces, exports, and charts.
- Treat building status/go-live readiness as part of scope, not as a footnote. Before choosing a broad building or answering about a named building, use `available_buildings` when available and carry status, go-live state, metric coverage, geometry, and eligibility into the response.
- Prefer human names for buildings, floors, spaces, and labels. Avoid raw org, location, space, sensor, or UUID-style ids unless the user asks, debugging requires them, or two similarly named things must be disambiguated.
- Stay professional, direct, and lightly human. Do not oversell certainty, bury the answer in caveats, or sound like a CLI manual.

## Progress Update Contract

Keep user-visible progress updates at the workplace level:

- Say what decision you are making for the user, not which skill, MCP tool, CLI command, cache path, SQL query, or local file is being used.
- Do not mention parser misses, reserved SQL words, DuckDB internals, shell commands, skill loading, or tool routing unless the user explicitly asks for debugging.
- If a query misroutes or needs a retry, recover quietly and disclose only the resulting source, scope, freshness, confidence, or caveat needed to trust the final answer.
- Good updates sound like: "I am checking the local historical window and office scope" or "I am using complete local business days (weekdays within the stated local working-hours window) so a partial day does not understate utilization."

## Skill Routing

Use the sibling skills as expert homes, but keep the product hierarchy clear:

- Local foundation: `setup` and `data-health`.
- Activation layer: `utilization` and `floorplan`.
- Gated moat surfaces: `benchmarking` and `wayfinding`.
- Trust layer: `sensor-health`.

If an answer includes a chart, HTML report, table, or floorplan, use `../../assets/design.md` as the only visual contract.
For broad prompts such as "pick any building" or "compare any one site," prefer the `answer_density_question` front door or a bounded `local_data_profile`/data-health check before asking the user to wait. If the tool returns `kind: density.clarification_request.v1` with the `density.clarification` contract, ask one crisp clarification using its `suggestions` and `freeform` fields, then resume with `nextActionAfterAnswer`. Do not fall back to shell, DuckDB, SQL, or hand-built Parquet scans for ordinary questions unless the user asks for debugging or the plugin tools are genuinely unavailable.

## Data Boundary Contract

- `local_customer_data`: customer-owned historical data in local Parquet/DuckDB. Use this for utilization, exports, charts, private analysis, and first-value activation. Do not meter access to this data by default.
- `benchmark_network_context`: Density-owned comparative intelligence. Use only through `benchmark_compare`, approved benchmark APIs, or approved snapshots. Never expose peer rows, peer org ids, raw distributions, or histogram buckets.
- `live_feed`: current-state availability and presence. Use `live_wayfinding_status` or live wayfinding sources for now/open/available questions. Historical local data may be offered as context, never as live truth.

Every analytical answer should disclose the source layer, time window, freshness, confidence, and caveat when those affect interpretation. Name exact tools or commands only when requested, blocked, or needed for trust.
Every important metric should be grounded with a known comparison. Prefer numeric context over vague language: use values, percentages, and deltas such as "5.8% of the working day (8am-6pm local time), 1.9 points above the building baseline of 3.9%" instead of qualitative labels alone. If no trustworthy comparison exists, say that comparison context is unavailable rather than inventing one.

## Building Lifecycle Contract

Use `available_buildings` before analysis when the user asks for a named building, asks for "any" building/site/office, asks for current availability, or asks for an artifact that implies a building can be charted or mapped.
Querying a planning, inactive, retired, future, or unknown-go-live building is allowed, but the answer and any artifact must say so plainly.
Do not imply a building is live just because it exists in local metadata.
For historical charts, prefer buildings where `chartQueryable` is true; otherwise explain which status/go-live readiness or metric-coverage field blocks the artifact.
For live wayfinding, require `liveWayfindingEligible`; historical utilization can be context only, not a walkable recommendation.

## Core Workflow

Prefer the plugin MCP tools when available:

- `setup`
- `auth_login`
- `onboard_customer`
- `historical_export`
- `create_demo_customer`
- `ask_chart`
- `local_utilization_query`
- `floor_usage_report`
- `local_data_profile`
- `available_buildings`
- `data_health_report`
- `repair_fast_questions`
- `live_wayfinding_status`
- `benchmark_compare`
- `sensor_health_report`
- `storage_report`
- `starter_questions`

Use the scripts below from the plugin root as the fallback when the MCP tools are not loaded in the current session.

1. Run setup/doctor first when the user is new, unsure, or asking about onboarding:

```bash
node scripts/density-setup.mjs --json
```

If setup returns `update.available: true`, tell the user:

```text
A newer version of the Density plugin is available. Say `update @density` and I can install it.
```

Only run the returned update command after the user says yes, `update @density`, `update density`, or an equivalent explicit approval. After updating, ask the user to start a new thread so the latest Density skill and tools load.

2. If setup says local data is missing, use `onboard_customer` or the fallback script. This is a starter preload for fast first value, not a cap on customer-owned local history. The default path is staged: it may sync cheap metadata, then returns one primary next action for longer starter metrics/export work instead of hiding a long all-spaces sync.

```bash
node scripts/density-onboard-customer.mjs --json
```

Use explicit full sync only when the user is ready for longer local work:

```bash
node scripts/density-onboard-customer.mjs --full-sync --days=14 --json
```

The default starter metrics preload is 14 days. Windows up to 7 days use 15-minute metrics; longer windows use hourly metrics so two-week utilization questions stay practical locally.
Explicit full sync prewarms starter-question answers and SVG/HTML chart artifacts when the CLI supports it. Pass `prewarmQuestions: false` only when the user wants raw sync/export without the fast-answer cache.

For broader local history, use `historical_export` instead of stretching onboarding:

```text
historical_export
```

The default historical export window is 90 days and the maximum is 365 days. This is still customer-owned local data; benchmark context and live availability remain separate source layers.

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

4. Ask a local historical utilization question and render an inline chart when setup reports chart support:

```bash
node scripts/density-ask-chart.mjs \
  --data-dir=/path/to/demo/.density-cli \
  --question="what are the busiest rooms?" \
  --json
```

For a spatial floorplan artifact, use `floor_usage_report` instead of `ask_chart`. The fallback command is:

```bash
density viz --html --report floor-usage --format json
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

For MCP sessions, prefer `local_utilization_query` over `ask_chart` for historical utilization. A basic historical question should normally be one MCP tool call; do not run setup/profile first unless the answer reports missing, stale, or unsupported local data. Keep `ask_chart` as a compatibility path.
For chart follow-ups such as "can I see a chart?", reuse the prior chart context or call the plugin chart artifact path first. Do not write a custom chart script unless the plugin reports chart artifacts are unsupported; if a fallback script is required, it must follow `../../assets/design.md`.

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

## Artifact Design Rule

Use `../../assets/design.md` for charts, HTML reports, tables, floorplans, and visual explanations. Do not introduce a second customer-specific style file by default. If the user wants customer-specific styling, edit or override that one design file.

When Codex needs inline display, convert SVG to PNG with `rsvg-convert` and embed the PNG.

## Atlas Defaults Rule

Local historical analytics should behave like a fast Atlas extension:

- Use effective scope returned by the CLI when present.
- Use space, floor, or building timezone from local metadata; UTC is only a fallback caveat.
- Use Atlas local projections such as `atlas_local_metrics.day_id`, `weekday`, `hour`, and `time_zone` for day, hour, working-hours, and heatmap answers.
- Do not group raw UTC metric timestamps for local business-hour or weekday analysis.
- Default local utilization charts to Atlas operating hours, typically `8am-6pm`, unless the user asks for a different window.
- Apply weekday/business-day semantics when the user asks for business, working, or weekday usage.
- Prefer `15minute` rows for short windows and `hour` rows for longer windows when the CLI reports that choice.

## First Value Loop

The first-run product loop is:

1. Set up local customer data.
2. Answer one useful historical utilization question locally and fast.
3. Show what Density benchmark-network context or live feed would add when relevant.
4. Use `historical_export` when the user needs more local history than the starter preload.
5. Use `data-health` or `sensor-health` when trust in the answer is uncertain.

## Good Local Test Questions

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
