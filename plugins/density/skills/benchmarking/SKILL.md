---
name: benchmarking
description: Use when the user asks how a Density customer, building, floor, room type, workplace pattern, or utilization result compares against peer benchmarks or target ranges.
---

# Density Benchmarking

Use this skill for benchmark scorecards, peer comparisons, target ranges, and portfolio-level interpretation.

Always use `../../assets/design.md` for visual artifacts.

## Interaction Contract

- Lead with the practical workplace answer, then the source, freshness, confidence, and caveat needed to trust it.
- Keep CLI, MCP, shell, cache, and tool-routing mechanics out of user-facing prose unless the user asks, an action is blocked, or those mechanics change the next step.
- Ask one crisp clarifying question when building, floor, space type, time window, or current-versus-historical scope is ambiguous.
- Keep local historical data, live availability, benchmark context, and sensor health separate.
- Prefer human-readable names and labels. Avoid raw ids unless the user asks or debugging requires them.
- Define operational terms in place when they affect the comparison, especially working day, business hours, local time, utilization, time used, saturation, and availability.

## Progress Update Contract

Keep user-visible progress updates at the workplace level:

- Say what decision you are making for the user, not which skill, MCP tool, CLI command, cache path, SQL query, or local file is being used.
- Do not mention parser misses, reserved SQL words, DuckDB internals, shell commands, skill loading, or tool routing unless the user explicitly asks for debugging.
- If a query misroutes or needs a retry, recover quietly and disclose only the resulting source, scope, freshness, confidence, or caveat needed to trust the final answer.
- Good updates sound like: "I am checking the local historical window and office scope" or "I am using complete local business days (weekdays within the stated local working-hours window) so a partial day does not understate utilization."

Read `references/darshan-benchmark-methodology.md` before answering benchmark math, scorecard, peer comparison, or recommendation questions.

## Rules

- Do not invent benchmark thresholds.
- Use `benchmark_compare` when available.
- Prefer Darshan's benchmark scorecard methodology where available.
- Treat every benchmark answer as comparative by construction: measured customer value, nearest internal customer comparison, then the approved Density benchmark segment when available.
- Name the benchmark segment specifically, such as room-size bucket, space function, floor type, capacity bucket, region, or workplace cohort returned by the benchmark source. Avoid generic phrases like "broader benchmark" when a specific segment is available.
- Use numbers and percentages together when they improve comprehension: measured value, denominator or baseline, delta, ratio, percentile, sample size, and reliability.
- Include the benchmark time basis when available, such as "per working day (8am-6pm local time)" or "during business hours (defined by the building settings)." If the benchmark source does not expose the basis, say that the time-basis comparison is unavailable.
- Keep raw peer distributions server-side or inside the benchmark API contract.
- Return display-safe benchmark findings, not raw customer peer rows.
- Separate findings from recommendations.
- State when sample size or data quality makes a benchmark unreliable.
- If no approved benchmark source is connected, say that benchmark context is unavailable instead of deriving peer context from local customer Parquet.
- Never describe Density benchmark context as another customer's data. It is generalized, approved comparative intelligence only.

## Data Routing

Use local Parquet/DuckDB for the customer's historical metrics. Use benchmark APIs or approved benchmark snapshots for peer context.
