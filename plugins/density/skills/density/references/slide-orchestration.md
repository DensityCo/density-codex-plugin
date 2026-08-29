# Density query and chart orchestration contract

For a historical chart question, interpret the user's meaning and use `query_db` with the supplied schema resource.
Preserve the requested scope, window, population, metric, denominator, and timezone.

`query_db` executes the SQL and returns the evidence rows.
Use the returned evidence ID with `render_chart` to render those same rows.
The chart declaration is a downstream presentation request.
It does not change the query or select a database table.
The declaration may include a preferred body from the expanded chart vocabulary.
Use an optional `time` field, an optional `entity` field for time series, at most one `series` field only with `time`, and one or more numeric `measure` fields.
Use `bin`, `low`, and `high` together for a histogram.
An `entity` field is required for entity charts and heatmaps, but not scalar tiles.
For a weekday-hour heatmap, declare weekday as `entity`, local hour as `time`, and the percentage as `measure`. Do not use `series` for this single heatmap.

The direct-query renderer has verified projections for bars, line, heatmap,
histogram, tiles, table, stacked bars, scatter, slope, range, area, pie, and
donut results.
When a requested body is incompatible or unavailable, return the explicit warning and suggest a supported alternative.

Chart requests use the governed fixed slide renderer and preserve the same 1920×1080 artifact in the inline preview and downloaded output.
Do not invent or claim a chart body that the renderer did not produce.
Return the supported text, table, or direct-query chart result, or explain that the requested artifact is unavailable.

If valid text or table rows exist but chart rendering fails, preserve those rows and explain that the chart is unavailable.
Do not screenshot, re-render, or rebuild an artifact.
