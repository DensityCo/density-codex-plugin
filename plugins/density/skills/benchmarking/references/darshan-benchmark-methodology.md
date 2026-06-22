# Darshan Benchmark Methodology

This reference captures the benchmark mechanics the plugin should follow.

## Core Stance

- Prefer floor-level analysis when possible.
- Use a rolling historical window when available; six months is the standard benchmark window.
- Use dynamic comparisons and capacity buckets instead of static made-up thresholds.
- Treat busy-day slices as a secondary layer, not the only view.
- Do not expose raw peer distributions, peer rows, or histogram buckets in Codex output.

## Minimum Sample Sizes

- Space-level benchmark segments need at least 50 observations.
- Floor-level benchmark segments need at least 15 observations.

If the sample is smaller, present the result as directional or insufficient.

## Preferred Panels

- floor utilization
- time used by space function
- meeting-room efficiency
- group size
- saturation by floor and function
- in-real-life collaboration
- social time
- hybrid pattern
- amenity time used for enclosed workspaces, phone booths, open collaboration spaces, lounges, and cafes

## Metric Guidance

Avoid percent occupancy as a primary benchmark when floor capacity is unreliable. Prefer floor utilization based on observed effective capacity, such as p95 daily peak when that is the approved local/benchmark contract.

For recommendations, distinguish:

- observed customer behavior
- peer comparison
- target range or opportunity
- confidence or sample-size caveat

## Audience Handling

Use the same underlying math for every audience. Change the wording and level of methodology detail only:

- executive: concise findings and opportunities
- practitioner: direct panel names and operational detail
- design: ratios and target ranges
- analytical: methodology-forward with definitions
- agent API: structured and display-safe
