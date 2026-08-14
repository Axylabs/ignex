# Ignus HTTP comparison report — elysia / 03-stress

Generated: 2026-08-14T07:30:36.127Z

Failure trace: `03-stress.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 03-stress |
| Generated | 2026-08-14T07:30:36.127Z |
| Total duration ms | 104084.530 |
| Achieved RPS | 918.11 |
| Total requests | 95561 |
| Successful requests | 95561 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 2399.260 |
| Min latency ms | 0.037 |
| p50 latency ms | 0.186 |
| p75 latency ms | 1.222 |
| p90 latency ms | 12232.490 |
| p95 latency ms | 16207.995 |
| p99 latency ms | 17936.870 |
| p99.9 latency ms | 17972.097 |
| Max latency ms | 17973.962 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 28764 | 0 | 0.00 | 0.049 | 2411.922 | 0.196 | 16331.217 | 17935.508 | 17971.900 | 17973.962 |
| GET /api/users | 47667 | 0 | 0.00 | 0.045 | 2407.983 | 0.185 | 16189.956 | 17938.859 | 17972.280 | 17973.840 |
| GET /health | 19130 | 0 | 0.00 | 0.037 | 2358.485 | 0.174 | 16052.732 | 17935.098 | 17972.112 | 17973.725 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
