# Ignus HTTP comparison report — ignus-native / 16-crud-validation-mix

Generated: 2026-08-16T19:42:51.721Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-native |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-16T19:42:51.721Z |
| Total duration ms | 100020.606 |
| Achieved RPS | 260.03 |
| Total requests | 26008 |
| Successful requests | 23437 |
| Expected error responses | 2571 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.481 |
| Min latency ms | 0.079 |
| p50 latency ms | 0.400 |
| p75 latency ms | 0.580 |
| p90 latency ms | 0.722 |
| p95 latency ms | 0.808 |
| p99 latency ms | 1.433 |
| p99.9 latency ms | 10.523 |
| Max latency ms | 43.848 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 3862 | 0 | 0.00 | 0.083 | 0.506 | 0.414 | 0.819 | 1.618 | 15.507 | 43.848 |
| PATCH /api/users | 2574 | 0 | 0.00 | 0.101 | 0.499 | 0.397 | 0.813 | 2.050 | 14.950 | 21.590 |
| POST /api/users | 9140 | 2571 | 28.13 | 0.079 | 0.474 | 0.401 | 0.811 | 1.357 | 9.172 | 22.945 |
| GET /api/users | 10432 | 0 | 0.00 | 0.080 | 0.473 | 0.396 | 0.799 | 1.368 | 10.523 | 33.387 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
