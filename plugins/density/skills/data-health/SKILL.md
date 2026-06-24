---
name: data-health
description: Use when the user asks why Density local data is missing, stale, zero, inconsistent with Atlas, too slow, or not suitable for local Parquet/DuckDB analytics.
---

# Density Data Health

Use this skill for local Parquet/DuckDB readiness, freshness, zero-data diagnosis, sync gaps, and repair guidance.

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
- `local_data_profile`
- `data_health_report`
- `storage_report`
- `starter_questions`
- `repair_fast_questions`
- `onboard_customer`
- `onboarding_status`
- `historical_export`

## Diagnosis Checklist

Check these before answering an analytical question from local data:

- canonical Parquet tables exist
- normalized fast-question tables exist
- local metrics cover the requested time window
- timestamps overlap the user's requested date range
- space metadata joins to metrics
- space type filters match the product taxonomy
- parent/child hierarchy is handled correctly
- uptime or health filters are not removing everything
- starter answers include nonzero useful results when applicable

## Response Rule

When data is not good enough, say exactly what is missing and what evidence showed that. Then give one primary next action: repair metadata, sync metrics, export Parquet, warm starter questions, or narrow the question.

If the issue is that the requested window is broader than the recent preload, check `onboarding_status` first. If a background deeper-history job is still running, say the local dataset is recent-first and still filling in deeper history. If no job exists, recommend the deeper-history onboarding/export path rather than implying the local-first product is capped at the preload window.
