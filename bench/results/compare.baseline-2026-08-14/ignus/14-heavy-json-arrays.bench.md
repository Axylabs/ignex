# Ignus HTTP comparison report — ignus / 14-heavy-json-arrays

Generated: 2026-08-14T00:25:36.559Z

Failure trace: `14-heavy-json-arrays.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 14-heavy-json-arrays |
| Generated | 2026-08-14T00:25:36.559Z |
| Total duration ms | 50079.369 |
| Achieved RPS | 71.99 |
| Total requests | 3605 |
| Successful requests | 2830 |
| Expected error responses | 775 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.118 |
| Min latency ms | 0.395 |
| p50 latency ms | 1.047 |
| p75 latency ms | 1.150 |
| p90 latency ms | 1.275 |
| p95 latency ms | 1.393 |
| p99 latency ms | 2.267 |
| p99.9 latency ms | 9.455 |
| Max latency ms | 177.421 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 1082 | 0 | 0.00 | 0.523 | 1.172 | 1.120 | 1.617 | 2.538 | 7.026 | 11.044 |
| POST /api/users | 2523 | 775 | 30.72 | 0.395 | 1.094 | 1.022 | 1.232 | 1.602 | 9.455 | 177.421 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
