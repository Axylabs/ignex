# Ignus HTTP comparison report — ignus / 02-load

Generated: 2026-08-14T00:00:14.622Z

Failure trace: `02-load.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 02-load |
| Generated | 2026-08-14T00:00:14.622Z |
| Total duration ms | 120547.039 |
| Achieved RPS | 211.81 |
| Total requests | 25533 |
| Successful requests | 25533 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.799 |
| Min latency ms | 0.125 |
| p50 latency ms | 0.642 |
| p75 latency ms | 0.854 |
| p90 latency ms | 1.016 |
| p95 latency ms | 1.098 |
| p99 latency ms | 2.099 |
| p99.9 latency ms | 50.476 |
| Max latency ms | 98.550 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 1494 | 0 | 0.00 | 0.198 | 0.861 | 0.755 | 1.192 | 2.329 | 13.333 | 69.487 |
| GET /api/users | 10527 | 0 | 0.00 | 0.159 | 0.836 | 0.701 | 1.116 | 2.048 | 45.460 | 83.298 |
| POST /api/users | 10527 | 0 | 0.00 | 0.127 | 0.745 | 0.585 | 1.052 | 2.179 | 50.470 | 98.550 |
| GET /health | 2985 | 0 | 0.00 | 0.125 | 0.824 | 0.633 | 1.038 | 1.748 | 50.607 | 69.568 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
