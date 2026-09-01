---
name: setup
description: Use when the user wants to install, authenticate, check readiness, sync, repair, or prepare local Density data for fast Parquet-first analytics.
---

# Density Setup

Use this skill for Density installation, auth, setup checks, local data preparation, storage reports, and repair flows.

## Interaction Contract

- Lead with the practical workplace answer, then the source, freshness, confidence, and caveat needed to interpret it.
- Keep CLI, MCP, shell, cache, and tool-routing mechanics out of user-facing prose unless the user asks, an action is blocked, or those mechanics change the next step.
- Ask one crisp clarifying question when building, floor, space type, time window, or current-versus-historical scope is ambiguous.
- Keep local historical data, live availability, benchmark context, and sensor health separate.
- Prefer human-readable names and labels. Avoid raw ids unless the user asks or debugging requires them.

## Progress Update Contract

Keep user-visible progress updates at the workplace level:

- Say what decision you are making for the user, not which skill, MCP tool, CLI command, cache path, SQL query, or local file is being used.
- Do not mention parser misses, reserved SQL words, DuckDB internals, shell commands, skill loading, or tool routing unless the user explicitly asks for debugging.
- If a query misroutes or needs a retry, recover quietly and disclose only the resulting source, scope, freshness, confidence, or caveat needed for the final answer.
- When progress helps, state the scope, time window, or completeness choice that affects the answer.

Prefer the plugin MCP tools when available:

- `status`
- `setup`
- `install_managed_cli`
- `auth_login`
- `onboard_customer`
- `onboarding_status`
- `prepare_floorplans`
- `historical_export`
- `create_demo_customer`
- `storage_report`
- `available_buildings`
- `repair_fast_questions`

Fallback scripts live in the plugin root under `scripts/`.

## Workflow

1. Run setup or `node scripts/density-setup.mjs --json`.
2. If setup says a plugin update is available, relay its exact update prompt. Run its update command only after explicit approval. After updating, ask the user to restart the host so the latest Density skill and tools load.
3. If setup asks for the managed CLI runtime, use `install_managed_cli`. This is an explicit download/copy action that verifies the manifest checksum before installing into `~/.density-cli/plugin-runtime/`.
4. If auth is missing, use `auth_login` or tell the user the next step is browser auth.
5. If Parquet inputs are missing, present the onboarding choices from setup/onboard_customer. Recommend fetching 30 days for all locations now and continuing the remaining supported history in the background.
6. Confirm that `query_db` is advertised. Use it with the supplied schema resource for local historical analytics. If it is missing, update the CLI before answering historical questions from the database.
7. Confirm lifecycle readiness is advertised. If setup reports that building lifecycle/go-live readiness is missing, update the CLI before using building-level analysis artifacts.
8. Use `available_buildings` when the user asks which buildings are available, live, queryable, mapped, or eligible for wayfinding.
9. Use `status` for a concise configuration, sync, storage, and readiness summary.
10. Use `storage_report` for detailed local table sizes.
11. Use `onboarding_status` to check a background deeper-history job and tell the user when the full supported local history is ready. Use `historical_export` when the user explicitly asks for a separate broader customer-owned local history export.
12. Use `prepare_floorplans` only when the user asks to prepare an exact building or floor for a map.

Normal setup should not run `npm install` or build the CLI from source. Use `DENSITY_CLI_REPO` plus `DENSITY_CLI_BUILD_FROM_SOURCE=1` only for explicit development work.

## Local Storage Contract

Parquet is durable. DuckDB is the query engine and cache.

Good local analytics stores include canonical Parquet tables such as:

- `spaces`
- `space_labels`
- `space_children`
- `space_metrics`
- `space_occupancy`

Treat `parquetReady` as necessary for local historical utilization. Use `query_db` with the supplied schema resource to query scoped `density_*` tables.

## Onboarding Choices

When setup reaches local data preparation, present these choices:

- Recommended: fetch 30 days for all locations now, then run the remaining supported history in the background.
- Recent only: fetch 30 days for all locations and skip the background history job.
- Specific location: fetch a named building, floor, or location slice once the CLI exposes a scoped onboarding resolver.

Windows up to 7 days may use 15-minute metrics; longer windows use hourly metrics to keep setup practical. Background deeper-history sync uses the CLI historical export path, which splits Data Access API observation requests at UTC calendar-month boundaries.

Do not describe the recent preload as a limit on customer access to their own data. Until the background job completes, answers should disclose that local history is recent-first and still filling in deeper history.

The onboarding background sync that fills deeper supported history is distinct from user-requested analysis. Use explicit sync, onboarding status, or data-health recovery when deeper history, unsupported scope, or repair is required.

## Wayfinding Readiness

Setup should also prepare live wayfinding without pulling historical utilization just for wayfinding:

- spaces and labels
- building/floor hierarchy
- floorplans and geometry
- identifiers needed by the real-time availability hook

Use `prepare_floorplans` as an explicit, scoped map preparation action. Do not require it for text live availability.

Do not ask users to set up API tokens for wayfinding. Live wayfinding should use the stored browser-auth Atlas session and the user's Density permissions.
Do not call latest synced data "live" unless the command used a true live availability hook.
