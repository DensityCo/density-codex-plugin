# Density Broadsheet Chart Style

Default chart answers should feel like a concise analytical brief:

- title: large serif sentence case, direct claim
- subtitle: one sentence with the key number or caveat
- chart: quiet background, clear ranking/share, direct labels
- color: leaders or largest shares in #8c2f1d; comparison values in muted tan
- provenance: keep SVG and HTML artifacts on disk; show PNG inline in Codex

Avoid generic dashboard chrome, decorative gradients, and legends that force cross-reading when direct labels fit.

For setup/onboarding, the ideal path is:

1. User installs Density.
2. Plugin setup finds or builds Density CLI.
3. User completes browser auth if needed.
4. Plugin syncs or prepares local Parquet-first data.
5. User asks a question and gets title, subtitle, and inline chart.

Storage rule:

Parquet is durable. DuckDB is the query engine/cache. A small DuckDB catalog over Parquet is preferred for demos and plugin-managed local datasets.
