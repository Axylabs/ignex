# Ignus HTTP comparison report — elysia / 16-crud-validation-mix

Generated: 2026-08-14T08:24:03.960Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-14T08:24:03.960Z |
| Total duration ms | 100020.499 |
| Achieved RPS | 260.03 |
| Total requests | 26008 |
| Successful requests | 23426 |
| Expected error responses | 2582 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.496 |
| Min latency ms | 0.060 |
| p50 latency ms | 0.386 |
| p75 latency ms | 0.623 |
| p90 latency ms | 0.805 |
| p95 latency ms | 0.880 |
| p99 latency ms | 1.209 |
| p99.9 latency ms | 13.518 |
| Max latency ms | 44.327 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 9053 | 2582 | 28.52 | 0.072 | 0.505 | 0.398 | 0.897 | 1.172 | 12.235 | 23.609 |
| PUT /api/users | 3938 | 0 | 0.00 | 0.064 | 0.503 | 0.388 | 0.882 | 1.131 | 17.332 | 24.002 |
| PATCH /api/users | 2571 | 0 | 0.00 | 0.062 | 0.494 | 0.379 | 0.881 | 1.295 | 19.940 | 25.723 |
| GET /api/users | 10446 | 0 | 0.00 | 0.060 | 0.485 | 0.375 | 0.860 | 1.300 | 12.414 | 44.327 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
