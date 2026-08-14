# Ignus HTTP comparison report — bun / 20-validation-storm

Generated: 2026-08-14T00:38:42.356Z

Failure trace: `20-validation-storm.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 20-validation-storm |
| Generated | 2026-08-14T00:38:42.356Z |
| Total duration ms | 50015.087 |
| Achieved RPS | 537.90 |
| Total requests | 26903 |
| Successful requests | 24224 |
| Expected error responses | 2679 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.455 |
| Min latency ms | 0.083 |
| p50 latency ms | 0.380 |
| p75 latency ms | 0.492 |
| p90 latency ms | 0.671 |
| p95 latency ms | 0.881 |
| p99 latency ms | 1.033 |
| p99.9 latency ms | 2.979 |
| Max latency ms | 163.242 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PATCH /api/users | 5493 | 0 | 0.00 | 0.116 | 0.475 | 0.387 | 0.905 | 1.041 | 2.344 | 163.242 |
| PUT /api/users | 5457 | 0 | 0.00 | 0.114 | 0.491 | 0.387 | 0.903 | 1.049 | 3.209 | 163.172 |
| POST /api/users | 9387 | 2679 | 28.54 | 0.106 | 0.445 | 0.383 | 0.887 | 1.041 | 3.003 | 28.675 |
| GET /api/users | 3953 | 0 | 0.00 | 0.117 | 0.439 | 0.367 | 0.860 | 1.006 | 3.267 | 71.571 |
| OPTIONS /api/users | 2613 | 0 | 0.00 | 0.083 | 0.401 | 0.367 | 0.762 | 0.922 | 1.973 | 2.812 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
