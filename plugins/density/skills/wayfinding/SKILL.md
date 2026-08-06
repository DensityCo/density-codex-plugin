---
name: wayfinding
description: Use when the user wants real-time Density availability, live occupancy, open rooms, desks, phone booths, or navigable wayfinding on a floorplan.
---

# Density Wayfinding

Use this skill for live or real-time availability. Do not use historical utilization tables to answer live wayfinding questions.

Always use `../../assets/design.md` for visual artifacts.

## Interaction Contract

- Lead with the practical workplace answer, then the source, freshness, confidence, and caveat needed to trust it.
- Keep CLI, MCP, shell, cache, and tool-routing mechanics out of user-facing prose unless the user asks, an action is blocked, or those mechanics change the next step.
- Ask one crisp clarifying question when building, floor, space type, time window, or current-versus-historical scope is ambiguous.
- Keep local historical data, live availability, benchmark context, and sensor health separate.
- Prefer human-readable names and labels. Avoid raw ids unless the user asks or debugging requires them.

## Progress Update Contract

Keep user-visible progress updates at the workplace level:

- Say what decision you are making for the user, not which skill, MCP tool, CLI command, cache path, SQL query, or local file is being used.
- Do not mention parser misses, reserved SQL words, DuckDB internals, shell commands, skill loading, or tool routing unless the user explicitly asks for debugging.
- If a query misroutes or needs a retry, recover quietly and disclose only the resulting source, scope, freshness, confidence, or caveat needed to trust the final answer.
- Good updates sound like: "I am checking the local historical window and office scope" or "I am using complete local business days (weekdays within the stated local working-hours window) so a partial day does not understate utilization."

## Rules

- Treat "available now", "open", "occupied", "live", "real-time", and "wayfinding" as current-state questions.
- Use `live_wayfinding_status` or live availability/presence data when available.
- Before making a walkable recommendation for a building, use `available_buildings` when available and require `liveWayfindingEligible: true`.
- The live wayfinding source is floor presence, such as `v3/{orgId}/analytics/ws/floor/{floorId}/presence`, when the CLI or app can access it.
- Clearly separate live status from historical popularity.
- If a live source is unavailable, say that plainly and offer the closest historical alternative as a fallback, not as a replacement.
- When the user asks for only one space type, hide other types or show them only as faint spatial context.
- If the building is planning, inactive, retired, future go-live, or unknown go-live, do not present it as live wayfinding-ready.
- Do not ask users to create or paste API tokens for wayfinding. Live wayfinding should use browser-auth/Atlas session permissions.
- Always say that availability means occupancy availability, not calendar booking status.
- If route geometry or floorplan highlighting is missing, do not promise directions. Return the available room or matching space information instead.

## Live Floorplans

For floor-level availability or desk availability, prefer the dynamic wayfinding floorplan artifact when the CLI/tool returns one.
The artifact must be live-updating, not a static snapshot.
It should render cached floorplan geometry once, then let the page own current presence state.

When handling live floorplan state:

- Keep a browser-side `presenceBySpace` map keyed by space id.
- Apply both `refresh` and `live` socket messages into that map.
- Ignore out-of-order updates when an incoming timestamp is older than the current value for a space.
- Re-render affected floorplan polygons and counts after each message.
- Reconnect after socket close or error; do not freeze the page after the first refresh.
- Show floor local time and the observed timestamp range so all-available/all-occupied displays can be interpreted against office hours and signal freshness.

## Floorplan Labels

Use current-state language:

- available
- occupied
- unavailable
- unknown
- stale or unhealthy when the live signal is not trustworthy

If a live response includes health state, treat `healthy` as trustworthy, and treat `offline`, `unknown`, or `degraded` as a reason to avoid confident availability claims.
