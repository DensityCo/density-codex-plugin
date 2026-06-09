# Density Codex Plugin

This repository is a Codex marketplace for the Density plugin.

Density lets Codex set up the local Density CLI, inspect local Density data, and answer workplace analytics questions when the installed CLI exposes chart support.

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

## Marketplace Layout

```text
.agents/plugins/marketplace.json
plugins/density/.codex-plugin/plugin.json
plugins/density/...
```

This shape lets Codex install the plugin from the Git repository as a marketplace source.
