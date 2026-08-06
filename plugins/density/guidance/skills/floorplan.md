---
name: floorplan
description: Use when the user wants Density spaces, utilization, rankings, health, or live availability shown visually on a floorplan.
---

# Density Floorplan

Use this skill for Density floorplan artifacts and overlays.

Always use `../../assets/design.md` as the visual contract.

## Interaction Contract

- Lead with the practical workplace answer, then the source, freshness, confidence, and caveat needed to trust it.
- Keep CLI, MCP, shell, cache, and tool-routing mechanics out of user-facing prose unless the user asks, an action is blocked, or those mechanics change the next step.
- Ask one crisp clarifying question when building, floor, space type, time window, or current-versus-historical scope is ambiguous.
- Keep local historical data, live availability, benchmark context, and sensor health separate.
- Prefer human-readable names and labels. Avoid raw ids unless the user asks or debugging requires them.
- Define operational terms in subtitles, legends, or callouts when they affect interpretation, especially working day, business hours, local time, utilization, saturation, and availability.

## Progress Update Contract

Keep user-visible progress updates at the workplace level:

- Say what decision you are making for the user, not which skill, MCP tool, CLI command, cache path, SQL query, or local file is being used.
- Do not mention parser misses, reserved SQL words, DuckDB internals, shell commands, skill loading, or tool routing unless the user explicitly asks for debugging.
- If a query misroutes or needs a retry, recover quietly and disclose only the resulting source, scope, freshness, confidence, or caveat needed to trust the final answer.
- Good updates sound like: "I am checking the local historical window and office scope" or "I am using complete local business days (weekdays within the stated local working-hours window) so a partial day does not understate utilization."

## Rules

- Preserve the floorplan as the spatial reference.
- Keep overlays semantically accurate: live availability, historical utilization, benchmark status, and sensor health are different signals.
- Use other spaces as light context when the user asks to focus on a subset.
- Label only what helps interpretation; avoid cluttering every polygon.
- Include a legend, scope, time window, and data-source note.
- If an overlay uses working-day, business-hours, saturation, or utilization language, define it in the legend or subtitle.

## Data Routing

- Historical utilization floorplan artifacts should use `floor_usage_report` when MCP tools are available, or `density viz --html --report floor-usage --format json` as the fallback.
- Historical utilization overlays should use the `utilization` skill.
- Real-time availability overlays should use the `wayfinding` skill.
- Sensor coverage or offline/stale overlays should use the `sensor-health` skill.
- Missing local data or zero-data diagnosis should use the `data-health` skill.
