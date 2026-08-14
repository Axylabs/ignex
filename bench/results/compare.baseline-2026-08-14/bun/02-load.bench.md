# Ignus HTTP comparison report — bun / 02-load

Generated: 2026-08-13T23:56:13.486Z

Failure trace: `02-load.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 02-load |
| Generated | 2026-08-13T23:56:13.486Z |
| Total duration ms | 120544.261 |
| Achieved RPS | 211.71 |
| Total requests | 25520 |
| Successful requests | 25520 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.573 |
| Min latency ms | 0.087 |
| p50 latency ms | 0.503 |
| p75 latency ms | 0.665 |
| p90 latency ms | 0.834 |
| p95 latency ms | 0.918 |
| p99 latency ms | 1.232 |
| p99.9 latency ms | 9.050 |
| Max latency ms | 61.869 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 1503 | 0 | 0.00 | 0.125 | 0.680 | 0.542 | 0.946 | 2.135 | 19.238 | 61.869 |
| GET /api/users | 10514 | 0 | 0.00 | 0.099 | 0.599 | 0.539 | 0.935 | 1.200 | 6.549 | 49.534 |
| POST /api/users | 10514 | 0 | 0.00 | 0.087 | 0.529 | 0.467 | 0.893 | 1.194 | 8.001 | 54.648 |
| GET /health | 2989 | 0 | 0.00 | 0.108 | 0.583 | 0.505 | 0.882 | 1.344 | 12.029 | 57.488 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
