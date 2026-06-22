# Density Codex Plugin

This repository is the official Codex marketplace for the Density plugin.

Density lets Codex set up the local Density CLI, inspect local Density data, and answer workplace analytics questions when the installed CLI exposes chart support.

## Install

Use the official Density marketplace/catalog URL:

```bash
codex plugin marketplace add https://github.com/densityco/density-codex-plugin
codex plugin add density@densityai
```

Start a new Codex thread after installing. Codex loads plugin skills and MCP tools when a thread starts, so the current thread will not reliably see a newly installed Density plugin.

Or give Codex this:

```text
Please install the Density plugin: run `codex plugin marketplace add https://github.com/densityco/density-codex-plugin` and then `codex plugin add density@densityai`. After installing, start a new thread and help me set up Density.
```

## Try It

Ask Codex:

```text
Set up Density
```

Then ask a chart question:

```text
Which rooms are busiest?
```

or:

```text
Show me a pie chart of space type breakdown
```

Density uses local customer data through the Density CLI. If local data or auth is missing, the setup tool will tell you the next command to run.

Setup is designed as one guided flow. After install, ask Codex to set up Density; it should run safe checks automatically and show one primary next action when auth, local data, or chart support is missing. If the current CLI does not support chart questions, Codex should say that directly instead of pretending a chart was generated.

## Repository Responsibilities

`density-codex-plugin` is the Codex integration layer:

- publishes the Codex marketplace/catalog entry named `densityai`
- packages the installable plugin named `density`
- provides Density skills, MCP tools, setup/onboarding wrappers, and update checks
- discovers or builds a local `density-cli` checkout, then calls the CLI for real Density work

`density-cli` is the local data and analytics engine:

- owns Density auth, sync, local Parquet/DuckDB storage, reports, and question/chart commands
- defines the Node.js runtime requirements for the CLI and its native dependencies
- stores local customer data under the configured Density CLI data directory
- is the source of truth for CLI capabilities such as `density capabilities --format json`

## Marketplace Layout

There are two different manifests. They are easy to mix up, but Codex uses them for different jobs.

The marketplace/catalog manifest tells Codex which installable plugins this marketplace exposes:

```text
.agents/plugins/marketplace.json
```

It exposes this plugin as:

```text
density@densityai
```

The plugin package manifest describes the installable Density plugin package itself:

```text
plugins/density/.codex-plugin/plugin.json
plugins/density/...
```

This package manifest is not the marketplace URL. Use `codex plugin marketplace add https://github.com/densityco/density-codex-plugin` to register the marketplace, then `codex plugin add density@densityai` to install the package declared by `plugins/density/.codex-plugin/plugin.json`.

## Fresh-Laptop Smoke Test

Use this checklist when validating a new machine or a clean Codex install:

1. Confirm Codex can see GitHub and the plugin CLI:
   ```bash
   codex plugin marketplace add https://github.com/densityco/density-codex-plugin
   codex plugin add density@densityai
   codex plugin list | grep density
   ```
2. Confirm `density@densityai` is `installed, enabled`.
3. Start a new Codex thread.
4. Ask: `Set up Density`.
5. Confirm setup reports Density CLI provenance, plugin version/update status, auth status, chart capability, and local storage readiness.
6. If setup points at a local `density-cli` checkout, use Node.js 24 before running `npm install`; `density-cli` depends on `duckdb`, which can fall back to a slow native build or fail on unsupported Node versions.
7. Complete browser auth only when setup asks for it: `density auth login`.
8. After auth, rerun `Set up Density` and verify the response has at most one primary next action.
9. Ask a starter question such as `Which rooms are busiest?` and confirm the plugin either returns a real local answer/chart or a precise unsupported-capability message.
