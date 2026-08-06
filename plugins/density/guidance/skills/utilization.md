---
name: utilization
description: Use when the user asks historical Density utilization questions, busiest or least-used spaces, meeting-room or phone-booth usage, working-hours averages, designed charts, or local Parquet/DuckDB analytics.
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
- Let `answer_density_question` resolve a named building for an ordinary historical question. Use `available_buildings` first for broad "any building/site" prompts, explicit lifecycle/current-state questions, or a front-door ambiguity.
- Prefer human-readable names and labels. Avoid raw ids unless the user asks or debugging requires them.

## Progress Update Contract

Keep user-visible progress updates at the workplace level:

- Say what decision you are making for the user, not which skill, MCP tool, CLI command, cache path, SQL query, or local file is being used.
- Do not mention parser misses, reserved SQL words, DuckDB internals, shell commands, skill loading, or tool routing unless the user explicitly asks for debugging.
- If a query misroutes or needs a retry, recover quietly and disclose only the resulting source, scope, freshness, confidence, or caveat needed to trust the final answer.
- Good updates sound like: "I am checking the local historical window and office scope" or "I am using complete local business days (weekdays within the stated local working-hours window) so a partial day does not understate utilization."

## Presentable Analytic Answers

- Ordinary historical utilization questions default to the fixed slide presentation through `answer_density_question`.
- Pass the user's exact question unchanged to `answer_density_question`; do not add a metric, time window, freshness request, or exclusion before the tool call.
- When the user explicitly asks for the editorial chart treatment, call `answer_density_question` with `presentation: "broadsheet"`.
- Use `analytic_slide` when a caller needs the slide-only contract directly.
- Let the validated artifact's `confidence` choose the response form: `supported` states the conclusion; `context_needed` relays `measured_observation` and the single `follow_up_question` verbatim, then asks that question; `blocked` states what is missing without estimating.
- Never re-derive or restate numbers beyond the artifact headline, subtitle, or chat text. The validator recomputed those values, and the agent must not introduce new numbers.
- After a supported slide reports `delivered`, display its attachment, copy only the artifact `headline` and `subtitle` exactly, and end the turn. Do not add a link or reformat names, dates, hours, or numbers.
- Display the returned canonical slide attachment in the first answer. Do not replace it with a text ranking or independently generated chart, PNG, or HTML.

For metric definitions and query rules, read `references/atlas-utilization-methodology.md` when the answer depends on math, normalization, rollups, or data-quality interpretation.

## Workflow

1. Route ordinary natural-language questions through one `answer_density_question` call with the exact user text. Use `local_utilization_query` only when the request is already classified as historical and its scope is clear; it should carry effective scope, freshness, confidence, and caveats.
2. Check local readiness with `setup`, `storage_report`, or `data-health` only when the query result says data is missing, stale, all zero, or unsupported.
3. For named or broad building scope, use `available_buildings`. Ordinary utilization artifacts require a live, measured, past-go-live scope with `chartQueryable: true`. Query other lifecycle states only when the user explicitly asks about lifecycle, inventory, setup, or data health.
4. If you must query manually, use Atlas local views and the effective scope rules in `references/atlas-utilization-methodology.md`.
5. Sync or repair only when that is the right next action for the user's request.
6. Report the source layer, tool, date range, business-hours assumption with definition, freshness, confidence, and caveats.
7. When relevant, add the nearest internal comparison first, then use Density benchmark-network context through `benchmark_compare` if benchmark access is available.
8. For broad scope prompts such as "any one building," use the plugin front door or data-profile coverage plus lifecycle readiness to choose a valid measured scope. If the local question router says the scope is missing, do not turn that into a long manual DuckDB/Parquet investigation in the user-facing answer; either recover through the plugin surfaces or ask one crisp clarification.
9. For chart follow-ups, call `answer_density_question` once with the exact follow-up text so it reattaches the prior canonical slide. Do not call a different analytic tool or create a fallback artifact.
10. Treat `orchestration.terminal` as final for the current turn. Deliver `complete` immediately; ask one returned prompt and wait for `clarification_required`; state `blocked` and stop. Never start a manual shell, DuckDB, SQL, or Parquet recovery for an ordinary question.

## Prepared And Freshness Behavior

- Use the organization-scoped prepared metrics cache when it is valid. A cache miss falls back to canonical local views without changing the answer contract.
- Keep cache paths, fingerprints, and repair mechanics out of normal answers. Report them only for setup, data-health, or latency diagnosis.
- Answer ordinary historical questions immediately from the current local snapshot and identify it as local historical data, never live data.
- If the latest eligible completed all-spaces metrics snapshot is older than 24 hours, start at most one organization-deduplicated background metrics refresh. Preserve the current answer if refresh cannot start or fails.
- A per-space or unknown snapshot scope must never broaden to all spaces for refresh. After a successful refresh, rebuild the prepared metrics cache.
- Keep the per-question freshness refresh distinct from onboarding deeper-history background sync. In ordinary answers, report only the freshness and refresh state needed for trust; reserve internal refresh and cache mechanics for setup, data-health, or latency diagnosis.
- Evaluate latency as full-wall time through routing, local analysis, optional benchmark work, artifacts, and PNG rendering.

## Default Assumptions

- Working-day analyses should state the business-hours window used in the same sentence or parenthetical, such as "working day (8am-6pm local time, weekdays)."
- Default Atlas-style utilization charts to the CLI-reported effective scope, usually `8am-6pm` local time.
- Use working days when the user asks for business, working, or weekday usage; otherwise disclose whether all days or weekdays were used.
- If the user gives no window, use the prepared local data window and disclose it.
- If the user says "last two weeks", use 14 days if available.
- For room and booth rankings, prefer time-used or occupied-hours metrics over raw event counts.
