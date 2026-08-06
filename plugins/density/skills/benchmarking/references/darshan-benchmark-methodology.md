# Darshan Benchmark Methodology

This reference captures the benchmark mechanics the plugin should follow.

## Core Stance

- Prefer floor-level analysis when possible.
- Use a rolling historical window when available; six months is the standard benchmark window.
- Use dynamic comparisons and capacity buckets instead of static made-up thresholds.
- Treat busy-day slices as a secondary layer, not the only view.
- Do not expose raw peer distributions, peer rows, or histogram buckets in Codex output.

## Prime Native Overlay Contract

The native benchmarked utilization chart is deliberately narrower than the full benchmark methodology:

- Resolve one exact floor. Do not choose an arbitrary floor for an organization or building comparison.
- Require one space function: `meeting_room` or `phone_booth`.
- Require a live, measured, chart-queryable scope with local rows and complete or explicitly confirmed past go-live evidence.
- Match the approved `time_used` section for that space function and the `avg` evaluation.
- Draw a numeric target range only when the local grain is `avg_used_hours_per_day` and the benchmark unit is `hours_per_day`. For total `used_hours`, keep the comparison sentence-only.
- Fail closed as `hidden`, `not_comparable`, `suppressed`, or `unavailable` when any gate fails. Never coerce a nearby metric, scope, unit, or segment.

Benchmark retrieval is optional and bounded. If it is incompatible, suppressed, unavailable, or timed out, preserve the complete local answer with a `Local` badge, not `Mixed`. Use `Mixed` only when an approved display-safe benchmark fact is actually shown.

Keep local customer metric rows and room-level result rows local; they are never sent to the benchmark service. Send only the authorized floor, organization, and date-window identifiers required for the scorecard request. Accept only the public scorecard response, and reject raw peer rows, peer identities, distributions, snapshots, and histogram buckets.

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
