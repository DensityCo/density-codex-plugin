---
name: setup
description: Use when the user wants to install, authenticate, check readiness, sync, repair, or prepare local Density data for fast Parquet-first analytics.
---

# Density Setup

Use this skill for Density installation, auth, setup checks, local data preparation, storage reports, and repair flows.

## Interaction Contract

- Lead with the practical workplace answer, then the source, freshness, confidence, and caveat needed to trust it.
- Keep CLI, MCP, shell, cache, and tool-routing mechanics out of user-facing prose unless the user asks, an action is blocked, or those mechanics change the next step.
- Ask one crisp clarifying question when building, floor, space type, time window, or current-versus-historical scope is ambiguous.
- Keep local historical data, live availability, benchmark context, and sensor health separate.
- Prefer human-readable names and labels. Avoid raw ids unless the user asks or debugging requires them.

## Progress Update Contract

Keep user-visible progress updates at the workplace level:

- Say what decision you are making for the user, not which skill, MCP tool, CLI command, cache path, SQL query, or local file is being used.
- Do not mention parser misses, reserved SQL words, DuckDB internals, shell commands, skill loading, or tool routing unless the user explicitly asks for debugging.
- If a query misroutes or needs a retry, recover quietly and disclose only the resulting source, scope, freshness, confidence, or caveat needed to trust the final answer.
- Good updates sound like: "I am checking the local historical window and office scope" or "I am using complete local business days (weekdays within the stated local working-hours window) so a partial day does not understate utilization."

Prefer the plugin MCP tools when available:

- `setup`
- `install_managed_cli`
- `auth_login`
- `onboard_customer`
- `historical_export`
- `create_demo_customer`
- `storage_report`
- `available_buildings`
- `starter_questions`
- `repair_fast_questions`

Fallback scripts live in the plugin root under `scripts/`.

## Workflow

1. Run setup or `node scripts/density-setup.mjs --json`.
2. If setup says a plugin update is available, tell the user: "A newer version of the Density plugin is available. Say `update @density` and I can install it." Run the returned update command only after the user says yes, `update @density`, `update density`, or an equivalent explicit approval. After updating, ask the user to start a new thread so the latest Density skill and tools load.
3. If setup asks for the managed CLI runtime, use `install_managed_cli`. This is an explicit download/copy action that verifies the manifest checksum before installing into `~/.density-cli/plugin-runtime/`.
4. If auth is missing, use `auth_login` or tell the user the next step is browser auth.
5. If Parquet or fast-question inputs are missing, use `onboard_customer` for the starter preload.
6. If generic Parquet exists but normalized fast-question metadata is missing and repair is available, use `repair_fast_questions`.
7. Confirm lifecycle readiness is advertised. If setup reports that building lifecycle/go-live readiness is missing, update the CLI before trusting building-level analysis artifacts.
8. Use `available_buildings` when the user asks which buildings are available, live, queryable, mapped, or eligible for wayfinding.
9. Use `storage_report` when the user asks what is local, stale, oversized, or suspicious.
10. Use `historical_export` when the user wants broader customer-owned local history beyond the starter preload.

Normal setup should not run `npm install` or build the CLI from source. Use `DENSITY_CLI_REPO` plus `DENSITY_CLI_BUILD_FROM_SOURCE=1` only for explicit development work.

## Local Storage Contract

Parquet is durable. DuckDB is the query engine and cache.

Good local analytics stores include canonical Parquet tables plus normalized fast-question inputs such as:

- `spaces`
- `space_labels`
- `space_children`
- `space_metrics`
- `space_occupancy`

Treat `parquetReady` as necessary but not sufficient for utilization. For fast historical questions, also check `fastQuestionsReady` and starter-cache usefulness when available.

## Sync Defaults

The default starter metrics preload is 14 days. Windows up to 7 days may use 15-minute metrics; longer windows may use hourly metrics to keep two-week answers practical.

Prefer staged setup unless the user explicitly wants a longer full sync.

For larger local history, use `historical_export`. Do not describe the starter preload limit as a limit on customer access to their own data.
