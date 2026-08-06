---
name: sensor-health
description: Use when the user asks about Density sensor health, stale or missing live signals, offline spaces, data coverage, uptime, or why availability/utilization data may be unreliable.
---

# Density Sensor Health

Use this skill for cloud sensor health, live signal trust, coverage, uptime, stale data, and operational data-quality explanations.

Always use `../../assets/design.md` for visual artifacts.

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

Read `references/sensor-health-methodology.md` when interpreting health status or explaining what unhealthy data means.

## Rules

- Use `sensor_health_report` when available.
- Sensor health is cloud-only. Do not infer it from DuckDB, Parquet, local historical utilization, or zero/nonzero occupancy rows.
- Separate product health from workplace behavior.
- Do not call a space unused when the sensor or data path is unhealthy.
- For live wayfinding, stale or unhealthy signals should appear as unknown or unavailable, not confidently available.
- For historical utilization, low uptime should be filtered or flagged.
- Explain what is missing, what evidence shows it, and what action would repair it.
