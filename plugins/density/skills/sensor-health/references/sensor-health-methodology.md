# Sensor Health Methodology

Sensor health explains whether Density can trust the signal. It is a cloud operational source and does not by itself explain workplace demand.

Do not infer sensor health from local DuckDB, Parquet, historical utilization, or missing local rows. Local data health can explain whether local analytics are ready; cloud sensor health explains whether the live sensing system is healthy.

## Common Health Signals

- online or offline state
- live health states such as `healthy`, `offline`, `unknown`, and `degraded`
- stale last-seen timestamp
- uptime percentage
- missing occupancy or metrics rows
- unavailable live availability
- bad or missing space mapping
- floorplan spaces without a sensor-backed source

## Interpretation

- Healthy and occupied means the space was observed in use.
- Healthy and unoccupied means the space was observed available or empty.
- Offline, unknown, degraded, stale, or unmapped means the answer is unknown or incomplete.
- Missing local historical rows may indicate sync or export problems, not zero utilization.
- Low-uptime metric buckets should be filtered or flagged. The local Atlas-compatible path commonly excludes buckets with `up_time <= 0.8`.

## Reporting

Show:

- affected space, floor, or building
- health status
- last observed time or freshness
- impact on utilization or wayfinding answers
- recommended repair or sync action
