# Ignus HTTP comparison report — ignus-aot / 16-crud-validation-mix

Generated: 2026-08-13T23:35:54.895Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-13T23:35:54.895Z |
| Total duration ms | 100021.895 |
| Achieved RPS | 260.02 |
| Total requests | 26008 |
| Successful requests | 23435 |
| Expected error responses | 2573 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.528 |
| Min latency ms | 0.070 |
| p50 latency ms | 0.364 |
| p75 latency ms | 0.552 |
| p90 latency ms | 0.824 |
| p95 latency ms | 0.926 |
| p99 latency ms | 1.696 |
| p99.9 latency ms | 38.970 |
| Max latency ms | 96.156 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 4006 | 0 | 0.00 | 0.074 | 0.545 | 0.369 | 0.938 | 1.966 | 22.286 | 96.156 |
| PATCH /api/users | 2582 | 0 | 0.00 | 0.084 | 0.559 | 0.369 | 0.935 | 1.419 | 43.609 | 65.307 |
| GET /api/users | 10272 | 0 | 0.00 | 0.072 | 0.516 | 0.362 | 0.924 | 1.693 | 38.875 | 65.252 |
| POST /api/users | 9148 | 2573 | 28.13 | 0.070 | 0.526 | 0.362 | 0.924 | 1.651 | 43.200 | 65.535 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
