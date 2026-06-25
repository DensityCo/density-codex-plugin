---
name: utilization
description: Use when the user asks historical Density utilization questions, busiest spaces, least-used spaces, meeting-room or phone-booth usage, working-hours averages, or local Parquet/DuckDB analytics.
---

# Density Utilization

Use this skill for historical utilization, occupancy, time-used, and ranking questions.

Always prefer local Parquet/DuckDB data first. Use live APIs only when the user asks for real-time/current availability.

Always use `../../assets/design.md` for visual artifacts.

## Interaction Contract

- Lead with the practical workplace answer, then the source, freshness, confidence, and caveat needed to trust it.
- Do not give standalone utilization numbers. Pair occupied hours, percent utilized, time used, saturation, or rankings with a denominator or comparison such as capacity, working-hours window, prior period, floor average, building average, portfolio average, or another known internal baseline.
- Prefer numeric context over qualitative shorthand: say "5.8% of the working day (8am-6pm local time), 1.9 points above the building baseline of 3.9%" rather than only saying "higher pressure."
- Define operational terms in place the first time they matter. Prefer "working day (8am-6pm local time, weekdays)" over "working day" and "time used (share of intervals with occupancy above zero)" over "time used" when that definition affects interpretation.
- Keep CLI, MCP, shell, cache, and tool-routing mechanics out of user-facing prose unless the user asks, an action is blocked, or those mechanics change the next step.
- Ask one crisp clarifying question when building, floor, space type, time window, or current-versus-historical scope is ambiguous.
- Keep local historical data, live availability, benchmark context, and sensor health separate.
- Check building lifecycle before making building-level claims. If `available_buildings` is available, use it for named buildings and broad "any building/site" prompts before presenting analysis or artifacts.
- Prefer human-readable names and labels. Avoid raw ids unless the user asks or debugging requires them.

## Progress Update Contract

Keep user-visible progress updates at the workplace level:

- Say what decision you are making for the user, not which skill, MCP tool, CLI command, cache path, SQL query, or local file is being used.
- Do not mention parser misses, reserved SQL words, DuckDB internals, shell commands, skill loading, or tool routing unless the user explicitly asks for debugging.
- If a query misroutes or needs a retry, recover quietly and disclose only the resulting source, scope, freshness, confidence, or caveat needed to trust the final answer.
- Good updates sound like: "I am checking the local historical window and office scope" or "I am using complete local business days (weekdays within the stated local working-hours window) so a partial day does not understate utilization."

For metric definitions and query rules, read `references/atlas-utilization-methodology.md` when the answer depends on math, normalization, rollups, or data-quality interpretation.

## Workflow

1. Use `local_utilization_query` directly for normal historical questions. It should carry effective scope, freshness, confidence, and caveats.
2. Check local readiness with `setup`, `storage_report`, or `data-health` only when the query result says data is missing, stale, all zero, or unsupported.
3. For named or broad building scope, use `available_buildings` and prefer buildings with `chartQueryable: true` for artifacts. If a building is planning, retired, inactive, future go-live, or unknown go-live, query only with that caveat visible in the response.
4. If you must query manually, use Atlas local views and the effective scope rules in `references/atlas-utilization-methodology.md`.
5. Sync or repair only when that is the right next action for the user's request.
6. Report the source layer, tool, date range, business-hours assumption with definition, freshness, confidence, and caveats.
7. When relevant, add the nearest internal comparison first, then use Density benchmark-network context through `benchmark_compare` if benchmark access is available.
8. For broad scope prompts such as "any one building," use the plugin front door or data-profile coverage plus lifecycle readiness to choose a valid measured scope. If the local question router says the scope is missing, do not turn that into a long manual DuckDB/Parquet investigation in the user-facing answer; either recover through the plugin surfaces or ask one crisp clarification.
9. For chart follow-ups, reuse a prior chart artifact or use the plugin chart path before creating any fallback script.

## Default Assumptions

- Working-day analyses should state the business-hours window used in the same sentence or parenthetical, such as "working day (8am-6pm local time, weekdays)."
- Default Atlas-style utilization charts to the CLI-reported effective scope, usually `8am-6pm` local time.
- Use working days when the user asks for business, working, or weekday usage; otherwise disclose whether all days or weekdays were used.
- If the user gives no window, use the prepared local data window and disclose it.
- If the user says "last two weeks", use 14 days if available.
- For room and booth rankings, prefer time-used or occupied-hours metrics over raw event counts.
