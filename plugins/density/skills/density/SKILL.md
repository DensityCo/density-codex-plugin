---
name: density
description: Use Density as the ordinary front door and parent router for local-first workplace questions, setup, floorplans, wayfinding, utilization, benchmarking, sensor health, data health, and visual artifacts.
---

# Density

Use this skill for any Density setup, data, or workplace question. Route detailed work to the sibling skill that owns it.

## Interaction Contract

- Lead with the practical answer. Add only the source, freshness, denominator, comparison, and caveat needed to trust it.
- Use human building, floor, and room names. Avoid raw ids unless the user asks or two names conflict.
- Keep live/current truth separate from historical/local truth. Local historical data is never live data.
- Explain utilization in plain English. State the analyzed population and operating window when they affect meaning.
- Ask one crisp question only when a missing scope, time window, or intent would materially change the answer, including current availability versus historical utilization. A clarification performs zero local queries, benchmark requests, chart rendering, or artifact writes.
- Keep tool mechanics out of user-facing prose unless the user asks for debugging or an action is blocked.

## Progress Update Contract

- Describe the workplace decision being checked, not the skill, tool, cache, SQL, DuckDB, or file path.
- Recover from routing problems quietly.
- Disclose only the resulting source, scope, freshness, confidence, or caveat needed for trust.

## Fast Route for Ordinary Questions

Route ordinary Density questions through `answer_density_question` before narrower tools. Pass the user's question verbatim.

Do not add metrics, time windows, freshness checks, exclusions, caveats, or presentation language. Those additions can change the analytic intent.

When the user delegates scope selection, select a scope only when that delegation is explicit and the scope is live, measured, and past go-live. Otherwise ask one question. Clarification results use `density.clarification_request.v1` and the `density.clarification` contract.

Treat `orchestration.terminal` as final for the current turn:

- `complete`: display the returned attachment, copy the validated answer, and stop.
- `clarification_required`: ask the returned prompt once, wait, then resume the original question with `clarificationAnswer`.
- `blocked`: state the blocker and stop.

Do not call another Density tool after a terminal result.
Do not fall back to shell, DuckDB, SQL, or hand-built Parquet scans for ordinary questions.
Do not use script fallback for an ordinary question. Report that the front door is unavailable and stop.

## Specialist Routes

Use the sibling skills for non-ordinary work:

- `setup`: installation, auth, recent-first 30 days onboarding, sync, and managed runtime repair.
- `utilization`: historical trends, rankings, heatmaps, and analytical definitions.
- `floorplan`: spatial artifacts.
- `wayfinding`: current availability from the live feed.
- `benchmarking`: approved comparison context.
- `data-health`: local trust, coverage, and storage diagnosis.
- `sensor-health`: cloud sensor status.

Use `available_buildings` only for delegated building selection, lifecycle questions, or ambiguity reported by the front door. Carry status/go-live readiness into selection. Ordinary utilization and benchmark artifacts require a live, measured, past-go-live scope.

## Data Boundaries

- `local_customer_data`: customer-owned historical Parquet queried with DuckDB.
- `benchmark_network_context`: approved, display-safe Density comparison facts. Never expose peer rows or ids.
- `mixed_local_benchmark`: local results plus approved benchmark facts. Label each source and keep local rows local.
- `live_feed`: current presence and availability. Historical data can provide context but not current truth.

## Presentation Contract

Ordinary historical Density questions default to the fixed slide presentation through `answer_density_question`.
Use `presentation: "broadsheet"` only when the user explicitly requests the editorial chart treatment.
Use `analytic_slide` only when a caller requires its slide-only contract.

Use `../../assets/design.md` as the only visual contract for charts, reports, tables, and floorplans.
For slides, `references/slide-orchestration.md` is the orchestration contract: choose only the question, presentation, and theme. The CLI owns chart-family selection, copy, geometry, and the QA gate, and a slide that fails the gate is delivered as validated chat text.

A delivered slide must include a host-visible image or resource. After a supported slide reports `delivered`, display its attachment, copy only the artifact `headline` and `subtitle` exactly, and end the turn.

For `context_needed`, relay the validated observation and follow-up question. For `blocked`, state what is missing without estimating. Never re-derive numbers beyond validated artifact text.

## Runtime Contract

Measure full-wall latency through model routing, the CLI question, optional benchmark work, artifact generation, and PNG rendering. Do not present `localQuestionMs` as end-to-end time.

Answer ordinary historical questions immediately from the current local snapshot. If the latest eligible all-spaces snapshot is older than 24 hours, start at most one deduplicated background metrics refresh. A refresh failure must preserve the current answer. A per-space or unknown snapshot scope must never broaden for refresh. A successful refresh must rebuild the prepared metrics cache.

Parquet is the durable local store. DuckDB is the query engine and disposable catalog. Benchmark work is optional: a timeout leaves a complete local answer labeled `Local`.

## Response Shape

For a delivered slide:

```markdown
Exact artifact headline.
Exact artifact subtitle.

![Short slide alt](/absolute/path/to/canonical-slide.png)
```

Keep implementation details out of the answer unless the user asks.
