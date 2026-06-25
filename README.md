# Density Codex Plugin

This repository is a Codex marketplace for the Density plugin.

Density lets Codex set up the local Density CLI, inspect local Density data, check building status/go-live readiness before analysis, answer historical workplace analytics questions from local Parquet/DuckDB, show live wayfinding availability when available, and render visual artifacts with one shared design contract.

## Install

```bash
codex plugin marketplace add https://github.com/densityco/density-codex-plugin
codex plugin add density@densityai
```

Or give Codex this:

```text
Please install the Density plugin: run `codex plugin marketplace add https://github.com/densityco/density-codex-plugin` and then `codex plugin add density@densityai`. After installing, start a new thread and help me set up Density.
```

Start a new Codex thread after installing so the Density skill and MCP tools load.

## Update

When setup says a newer Density plugin is available, reply:

```text
update @density
```

Codex may render that as `update [@density](plugin://density@densityai)`. It should refresh the `densityai` marketplace, reinstall `density@densityai`, and then ask you to start a new thread so the latest skills and tools load.

## Try It

Ask Codex:

```text
Set up Density
```

Then ask a local data question:

```text
Which rooms are busiest?
```

or:

```text
Show me a pie chart of space type breakdown
```

Or ask for a specific Density workflow:

```text
Use $utilization to rank the busiest conference rooms.
Use $wayfinding to show open phone booths on a floorplan.
Use $benchmarking to compare this floor against benchmark methodology.
Use $sensor-health to explain why this floor's live signal looks stale.
Use $data-health to diagnose why local utilization is showing zeros.
```

Benchmark and live wayfinding are separate source layers. Historical utilization should come from local Parquet/DuckDB; peer context should come from Density benchmark-network access; current availability should come from the live feed. Building status and go-live readiness should stay visible whenever a response or artifact uses a planning, inactive, retired, future-go-live, or unknown-go-live building.

Density uses local customer data through the Density CLI. If local data or auth is missing, the setup tool will tell you the next command to run.

Setup is designed as one guided flow. After install, ask Codex to set up Density; it should run safe checks automatically and show one primary next action when the managed CLI runtime, auth, local data, fast-question inputs, or chart support is missing. Historical utilization should prefer local Parquet/DuckDB. Real-time wayfinding should use live availability rather than historical metrics.

The normal CLI path is a plugin-managed runtime installed explicitly with the `install_managed_cli` MCP tool into `~/.density-cli/plugin-runtime/<version>/<platform-arch>/bin/density`. The tool copies or downloads the manifest-selected asset to a temporary path, verifies its SHA-256, extracts it, validates `density capabilities --format json`, and then swaps it into the cache. `DENSITY_CLI_COMMAND` and `DENSITY_CLI_BIN` remain explicit overrides; `DENSITY_CLI_REPO`, `DENSITY_CLI_BUILD_FROM_SOURCE=1`, and PATH are developer fallbacks.

The first managed runtime asset is published for `darwin-arm64`. Other platforms should use an explicit CLI until their runtime asset is published.

The default setup path prepares a fast starter preload. For broader customer-owned history, use `historical_export`; the plugin should not treat the starter preload as a limit on local data access.

## Guidance Source

The plugin keeps portable product guidance in `plugins/density/guidance/`.

Codex still loads the packaged skill files from `plugins/density/skills/*/SKILL.md` and the visual contract from `plugins/density/assets/design.md`. Keep those packaged files mirrored from the shared guidance source; the packaging tests fail when they drift.

Use this split to keep Codex polished while leaving the guidance easy to package for other hosts later. Platform-specific files such as `skills/*/agents/openai.yaml` stay in the Codex skill folders.

The plugin ships one visual design contract at `plugins/density/assets/design.md`, mirrored from `plugins/density/guidance/design.md`. Edit the guidance source and packaged asset together when a customer-specific artifact style is needed.

After changing skill text or plugin packaging, reinstall/update the plugin and start a new Codex thread so the latest skills load. CLI/runtime-only changes can be tested immediately when the managed runtime is pointed at a local dev CLI.

## Marketplace Layout

```text
.agents/plugins/marketplace.json
plugins/density/.codex-plugin/plugin.json
plugins/density/...
```

This shape lets Codex install the plugin from the Git repository as a marketplace source.
