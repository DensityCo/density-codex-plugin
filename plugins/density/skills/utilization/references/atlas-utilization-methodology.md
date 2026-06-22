# Atlas Utilization Methodology

Use Atlas and local CLI contracts as the source of truth for historical utilization math.

## Data Source Priority

1. Local Parquet/DuckDB views for historical analysis.
2. Sync or repair local data when readiness checks show missing, stale, or malformed local inputs.
3. Live/current APIs only for live wayfinding, not historical utilization.

## Local Inputs

Expected local inputs may include:

- `atlas_local_metrics`
- `atlas_spaces_flat`
- `atlas_space_labels`
- `spaces`
- `space_labels`
- `space_children`
- `space_metrics`
- `space_occupancy`

Use parent/child hierarchy when rolling rooms, floors, buildings, and campuses. Do not compare child spaces against parent totals unless the denominator is clear.

## Atlas Defaults

Local answers should inherit Atlas-like defaults before falling back to generic SQL:

- Effective organization comes from the selected CLI state unless the user scopes the query differently.
- Timezone comes from space, floor, or building metadata. UTC is only a fallback and must be disclosed.
- Operating hours default to Atlas-style `8am-6pm` where no explicit user window is given.
- Working-day filters apply when the user asks for business, work, working-hours, or weekday analysis.
- Date windows should prefer recent complete local periods over partial "today so far" windows.
- Use `15minute` buckets for short windows and `hour` buckets for larger windows when both are available.

Precedence:

1. Explicit user filters.
2. Selected Atlas context: org, building, floor, or selected spaces.
3. Space/floor/building metadata: timezone, hierarchy, go-live, status, capacity, and function.
4. Atlas product defaults.
5. Plugin fallback with an explicit caveat.

## Building Lifecycle

Building metadata is not enough to claim a building is available for analysis.
Use lifecycle readiness from `available_buildings` when choosing or explaining building scope.
Historical analysis may query non-live buildings, but planning, retired, inactive, future go-live, and unknown go-live states must remain visible in the response and artifacts.
Treat missing go-live as an uncertainty caveat, not as live readiness.
For chart artifacts, prefer scopes with `chartQueryable: true`; for live wayfinding, require `liveWayfindingEligible: true`.

## Core Metrics

- Occupancy: observed people count for a space and interval.
- Utilization: occupancy relative to the space capacity.
- Time used: share of working time where a space was occupied.
- Hours used per day: sum of interval-used time divided by the number of operating days.
- Person-hours: occupancy integrated over time.

Do not present any of these as standalone numbers. Always add the most relevant known comparison: capacity, available working hours, same floor or building average, customer portfolio average, previous period, same weekday pattern, or another methodologically compatible baseline. If no reliable comparison exists, say so explicitly.
Define the time basis inline when it affects the metric. For example: "working day (8am-6pm local time, weekdays)," "business hours (from building settings)," or "all days (including weekends)."

When ranking meeting rooms and phone booths, use time-used or occupied-hours unless the user asks for person-hours. Person-hours favors larger spaces and answers a different question.

## Working Hours

Always state the working-hours filter. If the user gives one, use it. If not, use the local chart/report default and disclose it. Put the definition next to the phrase on first use, such as "working day (8am-6pm local time, weekdays)" or "business hours (configured for this building)."

Never derive local hour, weekday, or business-day values from raw UTC `space_metrics.timestamp`. Use `atlas_local_metrics.local_datetime`, `day_id`, `weekday`, `hour`, and `time_zone`, which are projected through local space metadata.

For average hours per day:

```text
hours_used_per_day = sum(time_used_fraction * interval_hours) / operating_day_count
```

For 15-minute rows, `interval_hours = 0.25`.

## Data Quality

Filter or flag intervals where uptime is too low when the local data exposes uptime. A common local readiness threshold is uptime above 0.8.

If a result shows zeros where the product UI does not, check these before concluding the space was unused:

- local data freshness
- missing `space_metrics`
- missing normalized space metadata
- parent/child join mistakes
- business-hours filter excluding the active period
- space-type mismatch
- uptime or health filtering
- using person-hours when the user expected occupied hours

## Visual Explanation

For charts and floorplans, show:

- date range
- business-hours window
- metric definition
- data source
- missing-data caveat when applicable

## Atlas Visualization Canon

- Ranked bar charts default to the top or bottom 12 rows; inventory/pie breakdowns may show up to 100.
- Meeting rooms should exclude binary phone-booth-like spaces; phone booths are a separate class.
- Capacity questions should group by seat count and make clear whether the metric is total used hours or average per room.
- Saturation/runout questions must define the threshold, such as all booths occupied, 90% occupied, or no booth available for 15 minutes.
- Heatmaps should use local day/hour fields, gray no-data cells, and a clear intensity ramp.
- Keep zero-use, missing metrics, filtered low-uptime, and unhealthy sensor states visually distinct.
