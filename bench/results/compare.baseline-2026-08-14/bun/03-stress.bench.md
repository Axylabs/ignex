# Ignus HTTP comparison report — bun / 03-stress

Generated: 2026-08-14T00:02:01.114Z

Failure trace: `03-stress.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 03-stress |
| Generated | 2026-08-14T00:02:01.114Z |
| Total duration ms | 106453.334 |
| Achieved RPS | 867.99 |
| Total requests | 92400 |
| Successful requests | 92400 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 2671.795 |
| Min latency ms | 0.068 |
| p50 latency ms | 0.461 |
| p75 latency ms | 0.668 |
| p90 latency ms | 14541.046 |
| p95 latency ms | 19898.648 |
| p99 latency ms | 21077.920 |
| p99.9 latency ms | 21166.898 |
| Max latency ms | 21179.341 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 45976 | 0 | 0.00 | 0.071 | 2662.529 | 0.460 | 19903.858 | 21079.939 | 21167.372 | 21179.341 |
| POST /api/users | 27962 | 0 | 0.00 | 0.088 | 2708.440 | 0.479 | 19899.011 | 21078.286 | 21171.542 | 21179.265 |
| GET /health | 18462 | 0 | 0.00 | 0.068 | 2639.368 | 0.438 | 19874.109 | 21072.524 | 21162.973 | 21178.541 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
