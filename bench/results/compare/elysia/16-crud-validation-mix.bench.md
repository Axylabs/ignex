# Ignus HTTP comparison report — elysia / 16-crud-validation-mix

Generated: 2026-08-16T19:39:31.647Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-16T19:39:31.647Z |
| Total duration ms | 100020.235 |
| Achieved RPS | 260.03 |
| Total requests | 26008 |
| Successful requests | 23434 |
| Expected error responses | 2574 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.513 |
| Min latency ms | 0.071 |
| p50 latency ms | 0.496 |
| p75 latency ms | 0.630 |
| p90 latency ms | 0.766 |
| p95 latency ms | 0.843 |
| p99 latency ms | 1.050 |
| p99.9 latency ms | 3.923 |
| Max latency ms | 47.725 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 9143 | 2574 | 28.15 | 0.084 | 0.540 | 0.515 | 0.875 | 1.103 | 4.800 | 47.725 |
| PUT /api/users | 3885 | 0 | 0.00 | 0.090 | 0.505 | 0.494 | 0.842 | 1.026 | 3.369 | 5.837 |
| PATCH /api/users | 2668 | 0 | 0.00 | 0.111 | 0.503 | 0.490 | 0.830 | 1.005 | 4.863 | 10.095 |
| GET /api/users | 10312 | 0 | 0.00 | 0.071 | 0.496 | 0.483 | 0.818 | 1.010 | 4.269 | 21.304 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
