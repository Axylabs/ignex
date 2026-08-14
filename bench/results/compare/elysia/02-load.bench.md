# Ignus HTTP comparison report — elysia / 02-load

Generated: 2026-08-14T07:25:06.704Z

Failure trace: `02-load.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 02-load |
| Generated | 2026-08-14T07:25:06.704Z |
| Total duration ms | 120544.299 |
| Achieved RPS | 211.32 |
| Total requests | 25473 |
| Successful requests | 25473 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.676 |
| Min latency ms | 0.065 |
| p50 latency ms | 0.691 |
| p75 latency ms | 0.806 |
| p90 latency ms | 0.886 |
| p95 latency ms | 0.931 |
| p99 latency ms | 1.040 |
| p99.9 latency ms | 2.412 |
| Max latency ms | 20.584 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 1560 | 0 | 0.00 | 0.143 | 0.800 | 0.816 | 1.004 | 1.083 | 4.714 | 6.556 |
| GET /api/users | 10467 | 0 | 0.00 | 0.074 | 0.728 | 0.756 | 0.933 | 1.049 | 2.446 | 7.484 |
| POST /api/users | 10467 | 0 | 0.00 | 0.065 | 0.613 | 0.606 | 0.913 | 1.013 | 2.397 | 20.584 |
| GET /health | 2979 | 0 | 0.00 | 0.086 | 0.654 | 0.674 | 0.870 | 0.967 | 1.190 | 1.261 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
