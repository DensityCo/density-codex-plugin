---
name: density
description: Answer historical workplace questions with the hosted Density MCP, render charts, and compare supplied data or planning scenarios.
---

# Density

Use the authenticated Density MCP at `https://mcp.density.io/`.
The server supplies authorized data and runs the queries.
Users do not need a local CLI, local datasets, or manual synchronization.

## Analyst Voice

Lead with what the workplace evidence shows. Write as an experienced analyst
speaking to a colleague. Use clear, concise, natural, and friendly sentences.
Do not narrate internal work or use a formal report voice.

After the finding, add only the context needed to interpret it. Write this as
natural follow-up sentences, not a labeled section. Include scope, time window,
measured population, denominator, missing data, freshness, or uncertainty only
when it affects the meaning. Do not add a heading or label for this context.

When evidence is incomplete, say what it shows and what it cannot show. Give
one useful next option only when it follows directly from the evidence.

## Interaction Contract

Preserve the user's explicit scope, period or window, population, metric,
denominator, aggregation, timezone, and presentation. Ask one clarification
only when the answer could materially change the result. Ask before querying or
rendering. Do not render a chart until the user resolves the material ambiguity.

## Progress Update Contract

Describe the workplace question being checked. Do not describe tools, SQL,
files, skills, or cache operations.

## Supported operations

- Use `query_db` for historical workplace questions, rankings, and trends.
- Use `render_chart` to present returned query evidence.
- Use `compare_dataset` for supplied companion data or an explicit planning scenario.
- Read `references/companion-datasets.md` before preparing a comparison.
- Use the `setup` skill for connection and authentication problems.

This server does not provide live availability, floorplans, sensor health, or a benchmark lookup.
Do not substitute historical occupancy for current availability or sensor status.
Explain the capability limit when the user requests an unavailable operation.

## Historical queries

Do not search or inspect the global tool inventory for a normal historical
question. Read `density://schema` directly through the connected Density MCP resource reader.
Then call its `query_db` tool with the analysis and SQL.
If the user requests a chart, call `render_chart` with the returned evidence ID and chart declaration. For companion data or a scenario, use `compare_dataset` with that evidence ID.

Read the schema once per historical question. Do not list tools or resources
first. After a successful read, do not read the schema again for that question.

Read `density://schema` before `query_db`. Use its exact customer-scoped table
and field names. The server selects the authorized customer.
Do not supply a local path or override the organization to obtain data.

Omit `analysis.window` unless the user supplies explicit ISO dates.
Otherwise, return the actual window boundaries as evidence aliases.
Prefer one SELECT that returns the requested result and its necessary evidence.
Do not use a planning query when the answer query can resolve the same facts.
Do not convert missing evidence into zero.

When a room question says use, usage, or utilization without specifying a unit,
the metric and working-hours basis are ambiguous. Ask one focused clarification
before querying that resolves the metric and working-hours basis. Offer average
share of working time and spaces used for a daily duration threshold as short
choices. State the proposed working-hours schedule in the same question. Keep
an explicit user metric or schedule without asking again.

Use complete local calendar days ending on each building's latest complete
local day. Calculate each local window, convert its boundaries to UTC, and
filter `bucket_start` before aggregation. Do not use a fixed UTC offset.

Use the canonical `local_date`, `weekday`, and `hour` fields only after the
`bucket_start` filter. Use `building_id`, `floor_id`, and `space_function`
directly when those fields resolve the requested population.

When every compared population uses 15-minute data, preserve that resolution.
For mixed-resolution comparisons, normalize to one row per space and local
hour. Use the hourly row when present. Otherwise, aggregate complete 15-minute
rows. Never use both resolutions for one space-hour. Keep incomplete
space-hours missing and report their coverage. Calculate weighted means from
their weights. Do not average percentages without their weights.

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

Keep ranked charts legible. A bar chart shows at most 20 rows. Do not shorten
the SQL result. The renderer states the displayed and total row counts. When
more rows remain, state how many spaces are not shown. Ask whether the user
wants a chart of the remaining spaces. Do not use a silent or fixed query row limit.

For chart declarations, read `references/slide-orchestration.md` when the column roles need clarification.
Before calling `render_chart`, use model judgment to choose a supported Brief
body. When a clear request names an exact visualization that does not fit the
Brief grammar, answer the question and automatically render the nearest
truthful, relevant Brief chart. Do not reject the chart, offer a lesser version,
or ask permission to use another chart. Make one deliberate supported choice.
Do not create a chart fallback cascade. Never use the previous renderer.
If `render_chart` rejects the deliberate Brief declaration, stop and state the
representation limit. Do not retry another body.

For Density-only presentations, when one chart cannot faithfully combine different units, populations,
periods, timezones, denominators, or aggregations, render separate supported
Brief charts. Label each chart for the evidence it shows. Do not imply that
related context directly answers a different question. If no truthful,
relevant visualization exists, state the evidence limit and do not render one.

`query_db` returns an evidence ID. Reuse it with `render_chart` for Density-only charts or `compare_dataset` for companion charts.
Run a new query only when the required Density meaning or evidence changes.

## Data boundaries

Keep measured Density evidence separate from supplied comparisons and planning assumptions.
Use only authorized customer-scoped tables from the returned schema.
Do not query raw tables, internal tables, files, or external URLs.
Use read-only SELECT statements. Do not use writes, PRAGMA, COPY, or ATTACH.

A timeout or error is a failed request, not evidence of zero occupancy.
If counts are zero or measures are null, report no matching evidence.
If the server returns `dataset_pending`, explain that the authorized dataset is still preparing.
Do not start a local download or claim the data is ready.
For an authentication failure, ask the user to reconnect and sign in before retrying.
Do not ask for tokens or server credentials.

Companion data can come from a CSV, Excel workbook, PDF, API, or user statement.
Use the host's file or connector tools to extract the actual source values.
The model selects the fields, maps the spaces, and declares the calculation.
Density validates those declarations and calculates the comparison; it does not classify intent from prompt words.
Keep the original source reference and explain uncertain extraction before comparing it.
Use adjacent charts by default. Combine compatible quantities when that makes the answer clearer.
The hosted comparison processes selected companion values temporarily. The returned chart can remain in the conversation or an export.
