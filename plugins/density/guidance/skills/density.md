---
name: density
description: Use Density for workplace questions, setup, historical analysis, floorplans, live wayfinding, benchmarks, and data or sensor health.
---

# Density

Use this skill to activate the Density plugin and select the correct data mode.
This skill supplies the shared instructions in Codex. Do not read the fallback
prompt file during a normal Codex turn. Other MCP clients can load the canonical
`density` prompt from `../../guidance/density-system-prompt.md`.

## Interaction Contract

Preserve the user's explicit scope, period or window, population, metric,
denominator, aggregation, timezone, and presentation. Ask one clarification
only when the answer could materially change the result. Ask before querying or
rendering. Do not render a chart until the user resolves the material ambiguity.

## Progress Update Contract

Describe the workplace question being checked. Do not describe tools, SQL,
files, skills, or cache operations.

## Routes

- Use `status` when the user asks what is configured, downloaded, current, or ready. Do not call it before every analysis.
- Use `query_db` for historical workplace questions, rankings, and trends.
- Use `render_chart` for a presentation-only change when existing evidence fully supports it.
- Use `configure_brand` when the user supplies brand guidelines or a logo for future charts.
- Use `live_wayfinding_status` and the `wayfinding` skill for current availability.
- Use `benchmark_compare` and the `benchmarking` skill for approved benchmark context.
- Use `floor_usage_report` and the `floorplan` skill for spatial artifacts.
- Use the `setup` skill for installation, authentication, onboarding, and recent-first 30-day preparation.
- Use the `data-health` skill for missing, stale, zero, or inconsistent local data.
- Use the `sensor-health` skill for current cloud sensor status and historical sensor uptime.

Use `available_buildings` for lifecycle questions, scope selection when names
are ambiguous, or diagnosis after missing historical evidence. Current status
must not remove spaces with valid historical rows.

## Historical queries

Do not search or inspect the global tool inventory for a normal historical
question. Call `read_mcp_resource({ server: "density", uri: "density://schema" })`
directly. Then call `mcp__density__query_db` with the analysis and SQL. If the
user requests a chart, call `mcp__density__render_chart` with the returned
evidence ID and the chart declaration.

Read the schema once per historical question. Do not list tools or resources
first. After a successful read, do not read the schema again for that question.

Read `density://schema` before `query_db`. Use its exact customer-scoped table
and field names. Omit `dataDir` so the host-selected customer profile remains
authoritative.

Prefer one SELECT that returns the requested result and its necessary evidence.
Do not use a planning query when the answer query can resolve the same facts.
Do not convert missing evidence into zero.

When a room question says use, usage, busiest, or utilization without specifying
a unit, use average time-used percentage over the requested window, not total
used hours.

Use complete local calendar days ending on each building's latest complete
local day. Calculate each local window, convert its boundaries to UTC, and
filter `bucket_start` before aggregation. Do not use a fixed UTC offset.

Use the canonical `local_date`, `weekday`, and `hour` fields only after the
`bucket_start` filter. Use `building_id`, `floor_id`, and `space_function`
directly when those fields resolve the requested population.

Use unrounded values for bin assignment, threshold tests, ordering, and
comparisons. Return raw numeric values from SQL. Multiply fractional percentage
values by 100 without rounding them. The renderer applies display precision.
Use one decimal for average occupancy and average time-used labels. Show whole
discrete people and whole hours. Preserve missing values as missing. Never
convert them to zero.

For percentage bars, set `chart.display.scaleMax` to 100. Set `chart.scopeLabel`
to the exact requested building, floor, or space. Declare population counts only
through constant aliases that every returned row contains.

The chart renderer owns layout and representation validation. The model assigns
returned fields to evidence roles and may recommend a faithful response form.
For a weekday-hour heatmap, declare weekday as `entity`, local hour as `time`,
and the percentage as `measure`. Do not use `series` for this single heatmap.

Keep ranked charts legible. When the user does not request a displayed count,
use `chart.display.top` to show at most 15 rows in a bar chart. Do not shorten
the SQL result. The renderer states the displayed and total row counts. Offer
the remaining rows or slides. Do not use a silent or fixed query row limit.

Before calling `render_chart`, use model judgment to choose a supported Brief
body. When a clear request names an exact visualization that does not fit the
Brief grammar, answer the question and automatically render the nearest
truthful, relevant Brief chart. Do not reject the chart, offer a lesser version,
or ask permission to use another chart. Make one deliberate supported choice.
Do not create a chart fallback cascade. Never use the previous renderer.
If `render_chart` rejects the deliberate Brief declaration, stop and state the
representation limit. Do not retry another body.

When one chart cannot faithfully combine different units, populations,
periods, timezones, denominators, or aggregations, render separate supported
Brief charts. Label each chart for the evidence it shows. Do not imply that
related context directly answers a different question. If no truthful,
relevant visualization exists, state the evidence limit and do not render one.

`query_db` returns an evidence ID. For each chart you render, use that ID with
`render_chart`. Run a new query only when the requested meaning or evidence
changes.

## Data boundaries

Keep customer historical data, current live data, approved benchmark context,
and cloud sensor health separate. Label each source when an answer combines
compatible modes.
