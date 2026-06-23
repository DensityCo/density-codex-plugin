# Density Artifact Design

Use this file as the single visual contract for Density plugin artifacts. If a user wants customer-specific branding, edit this file instead of adding a second competing style guide.

## Principles

- The default aesthetic is Broadsheet/Tufte: concise analytical brief, high signal-to-ink ratio, direct claims, restrained rules, and no generic dashboard chrome.
- Lead with the answer, then show the evidence.
- Make every important number comparative. Show the measured value with the denominator or baseline that makes it interpretable, then add the nearest internal comparison and a named Density benchmark when available.
- Define analytical terms where the reader sees them. Put working day, business hours, local time, utilization, time used, saturation, and availability definitions in subtitles, labels, legends, or notes instead of relying on chat context.
- Prefer calm analytical briefs over generic dashboards.
- Make floorplans, charts, tables, caveats, and provenance feel like one system.
- Keep visuals useful when exported, screenshotted, or read without the chat context.
- Never hide data-quality caveats behind decorative design.

## Default Look

- Background: warm off-white or white.
- Text: dark neutral, high contrast.
- Accent: Density rust `#8c2f1d` for the primary finding.
- Secondary colors: restrained neutrals, muted teal, and muted blue for comparisons or availability states.
- Typography: large serif titles for report pages; compact sans-serif labels and table text for dense analytical surfaces. Chart titles should read like a sentence-case claim, not a dashboard widget label.
- Radius: 8px or less for cards, controls, and repeated items.
- Avoid decorative gradients, floating blobs, heavy shadows, and marketing-style hero layouts.
- Avoid chart-card styling when the artifact itself is the answer. The chart should feel like a page or brief, not a screenshot of a dashboard tile.

## Charts

- Show a visible source badge: `Local`, `Live`, `Benchmark`, or `Mixed`.
- `Local` means customer-owned historical data from local Parquet/DuckDB.
- `Live` means current availability or presence from the authenticated live feed.
- `Benchmark` means display-safe Density benchmark-network context.
- `Mixed` means the artifact combines more than one source layer; label each part clearly.
- Use direct labels when practical.
- Use legends only when direct labels would clutter the chart.
- Legends, badges, subtitles, and labels must never overlap the title, marks, axes, or each other. Prefer direct labels or a below-chart legend when the title is long.
- Sort ranked charts by the metric being discussed.
- Show units in labels or subtitles, such as hours per day, person-hours, percent of working hours, or spaces.
- Analyze only available measured spaces for normal utilization charts. Planning, inactive, retired, decommissioned, and unavailable spaces are eligibility inputs, not commentary, unless the chart is explicitly about data health, setup, lifecycle coverage, or missing inventory.
- Avoid naked stats in titles, labels, and callouts. Match the denominator to the question: for one room over time, use language like "busy for 12% of working hours"; for hour-of-day charts across rooms, use "at 2pm, 13% of available measured rooms were occupied" instead of room-hour language.
- Use the accent color only for the lead series or important highlight.
- Keep comparison series muted.
- Include the time window, business-hours assumption with definition, timezone basis, and data freshness when relevant.
- Keep chart generation dependency-light but not layout-blind. If rendering by hand, reserve explicit title, subtitle, legend, plot, and footnote regions before drawing marks.
- Prefer generated chart artifacts from the Density CLI or plugin chart contract over ad hoc one-off scripts. If a one-off fallback is unavoidable, it must still follow this design file and be visually inspected for collisions.

## Atlas Analytics Defaults

- Treat Atlas as the baseline product grammar for local analytics.
- Show effective scope when it affects interpretation: org, building/floor, timezone, date window, operating hours, working days, and interval.
- Default utilization charts to local Atlas operating hours, typically `8am-6pm`, unless the artifact says otherwise.
- Use local timezone projections from Atlas-style views for hour, weekday, heatmap, and working-hours displays.
- Never label a UTC-grouped chart as local business-hour analysis.
- Prefer top/bottom 12 ranked bars for room, booth, and capacity findings.
- Use gray for no data, a separate neutral for zero observed use, and an explicit caveat for low uptime or unhealthy signals.
- For saturation/runout visuals, write the threshold in the subtitle or legend.

## Floorplans

- Preserve the user's ability to read the base floorplan.
- Use overlays for the analytical signal, not for decoration.
- Use a clear status palette:
  - available: muted green or teal
  - occupied or most-used: Density rust
  - unavailable, stale, or unhealthy: muted gray
  - missing data: light neutral with explicit label or legend entry
- For historical utilization, use rank, intensity, or labels rather than live availability wording.
- For real-time wayfinding, use current availability wording and avoid implying a historical trend.

## Tables And Lists

- Put ranked findings in a compact table or list near the visualization.
- Include space name, space type, capacity when known, metric value, comparison value, delta or ratio, and data-quality note when needed.
- Keep numbers rounded enough to scan, but not so rounded that rankings become misleading.

## Caveats And Provenance

Every analytical artifact should make these visible when they matter:

- customer or org scope
- building, floor, or space scope
- date range
- business-hours window, including timezone and weekday/all-day basis
- local data freshness
- whether the answer used local Parquet/DuckDB, live APIs, or benchmark APIs
- missing, stale, or filtered data

## Modification Contract

Users may modify this file to match customer branding. Keep the file name and role stable so all Density skills continue to share one visual source of truth.
