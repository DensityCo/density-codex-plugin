# Density Artifact Design

Use this file as the single visual contract for Density plugin artifacts. If a user wants customer-specific branding, edit this file instead of adding a second competing style guide.

## Immutable Editorial Constitution

- The canonical default Density presentation is the fixed slide layout: a stable header, fixed chart region, right evidence rail, legend, and footer.
- The immutable constitution is the editorial structure: one plain-English claim, evidence-led hierarchy, restrained rules, high signal-to-ink ratio, and explicit trust context.
- Broadsheet/Tufte is the explicit chart variant and compatibility fallback. It keeps the cream page, Density rust, serif display typography, and editorial chart treatment.
- In the default theme, use cream or warm off-white for the page and Density rust `#8c2f1d` for the primary editorial accent.
- Approved render-time themes such as Density Blue, indigo, deep teal, or a customer brand accent may change data accents and supporting washes. They must not change the editorial hierarchy or repurpose reserved trust, source, benchmark, missing, zero, or filtered encodings.
- Customer branding may add approved identifiers and accents while preserving the fixed slide structure, semantic encoding, and analytical restraint. The Broadsheet variant also preserves its serif claim voice.

## Principles

- The default presentation is the fixed slide. Keep the scope eyebrow, descriptive title, data subtitle, chart, optional evidence rail, legend, and footer in their assigned regions across questions and sites. The eyebrow is `LOCAL · ORG · SCOPE`; never repeat the user's question on the slide.
- The Broadsheet/Tufte variant is a concise analytical brief with a high signal-to-ink ratio, direct claims, restrained rules, and no generic dashboard chrome.
- Lead with the answer, then show the evidence.
- Make every important number comparative. Show the measured value with the denominator or baseline that makes it interpretable, then add the nearest internal comparison and a named Density benchmark when available.
- Define analytical terms where the reader sees them. Put working day, business hours, local time, utilization, time used, saturation, and availability definitions in subtitles, labels, legends, or notes instead of relying on chat context.
- Prefer calm analytical briefs over generic dashboards.
- Make floorplans, charts, tables, caveats, and provenance feel like one system.
- Keep visuals useful when exported, screenshotted, or read without the chat context.
- Never hide data-quality caveats behind decorative design.

## Default Slide Look

- Background: warm off-white or white.
- Text: dark neutral, high contrast.
- Accent: Density rust `#8c2f1d` for the primary finding.
- Secondary colors: restrained neutrals, muted teal, and muted blue for comparisons or availability states.
- Typography: large serif descriptive titles for report pages; compact sans-serif labels and table text for dense analytical surfaces. Put the measured claim in the answer text or rail, not the title.
- Radius: 8px or less for cards, controls, and repeated items.
- Avoid decorative gradients, floating blobs, heavy shadows, and marketing-style hero layouts.
- Avoid chart-card styling when the artifact itself is the answer. The chart should feel like a page or brief, not a screenshot of a dashboard tile.

## Native Delivery

- The canonical artifact is the validated `1920x1080` fixed-slide HTML.
- The inline preview comes from that exact HTML.
- Do not reconstruct the chart, copy, rail, legend, or footer independently.
- A generated file path is not delivery.
- Report a delivered slide only when the host receives a renderable image, embedded resource, or supported panel target.
- Keep the native response compact.
- A short caption may accompany the slide.
- A complete answer or inline chart is terminal.
- Do not screenshot, re-render, or rebuild a delivered artifact.
- If a preview fails, relay the text answer and the stated reason.

## Semantic Encoding Rules

- A datum trust state outranks any edition accent. Missing, stale, unavailable, or unhealthy data must keep its defined semantic treatment even when an accent would otherwise color the mark.
- Benchmark gold is benchmark-only. Use it only for named Density benchmark-network context, never for local customer data, live data, ranking emphasis, decoration, or edition identity.
- Keep source, freshness, and caveats visible at thumbnail size and in exports. Do not depend on hover, interaction, chat context, or a hidden appendix to disclose them.
- Preserve the source labels and meanings defined below. Editorial styling may change presentation hierarchy, but it must not change `Local`, `Live`, `Benchmark`, or `Mixed` provenance.
- Use editorial accents only after trust and source semantics are clear. When they conflict, trust state wins first, source encoding second, and editorial or edition accent last.

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
- Avoid naked stats in titles, labels, and callouts.
- Match the denominator to the question.
- For one room over time, use `<value>% of working hours (<window>)`.
- For hour-of-day charts, use `<value>% of available measured rooms were occupied at <hour>`.
- Use the accent color only for the lead series or important highlight.
- Keep comparison series muted.
- Include the time window, business-hours assumption with definition, timezone basis, and data freshness when relevant.
- Use the Density MCP or plugin chart contract for generated chart artifacts.
- Do not use an ad hoc fallback after delivery or a preview failure.

## Atlas Analytics Defaults

- Treat Atlas as the baseline product grammar for local analytics.
- Show effective scope when it affects interpretation: org, building/floor, timezone, date window, operating hours, working days, and interval.
- Default utilization charts to local Atlas operating hours, typically `8am-6pm`, unless the artifact says otherwise.
- Use local timezone projections from Atlas-style views for hour, weekday, heatmap, and working-hours displays.
- Never label a UTC-grouped chart as local business-hour analysis.
- Keep ranked bars readable. Use a disclosed subset or additional slides when one chart cannot show every returned row clearly.
- State the displayed and total row counts. Offer the remaining rows or slides.
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

## Governed Themes

- The Density MCP theme registry is an authorized render-time selector. Implementations may expose a `theme` option accepting the ten named registry themes (`product_clean`, `editorial`, `swiss`, `boardroom_dark`, `ft_editorial`, `monograph`, `blueprint`, `humanist`, `newsprint_mono`, `marketplace_warm`), the three accent presets (`density_blue`, `indigo`, `deep_teal`), or a customer `#RRGGBB` brand accent gated by the runtime's reserved-hue and contrast checks.
- A named theme restyles surfaces, ink ramps, type families, and data accents only. Every theme inherits the immutable editorial constitution, the semantic encoding rules, the fixed slide zones, and the reserved trust encodings; no theme may reposition a zone or repurpose a reserved color.
- When no theme is selected, non-interactive and headless rendering uses `product_clean` as the deterministic fallback.
- See `references/slide-orchestration.md` under the density skill for the orchestration contract that governs theme and chart-family selection.

## Future Governed Editions

- Future governed editions may add reviewed, bounded layout or supporting-accent variants in this same design file; do not create a second style file.
- An edition must inherit the immutable editorial constitution and semantic encoding rules. It may not redefine trust states, provenance labels, benchmark gold, caveat visibility, or the fixed slide hierarchy.
- The authorized presentation values are `slide` and `broadsheet`. These select a governed layout. Implementations must not expose an edition API or any selector beyond `presentation` and the governed `theme` option until a separate product contract authorizes one.
- Until an edition is approved here, the canonical constitution plus the governed theme registry is the only artifact style family.

## Modification Contract

Users may modify this file to match customer branding. Keep the file name and role stable so all Density skills continue to share one visual source of truth.
