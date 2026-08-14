# Ignus HTTP comparison report — elysia / 10-mixed-realistic

Generated: 2026-08-14T00:17:14.774Z

Failure trace: `10-mixed-realistic.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 10-mixed-realistic |
| Generated | 2026-08-14T00:17:14.774Z |
| Total duration ms | 65057.119 |
| Achieved RPS | 630.02 |
| Total requests | 40987 |
| Successful requests | 40987 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.573 |
| Min latency ms | 0.068 |
| p50 latency ms | 0.519 |
| p75 latency ms | 0.676 |
| p90 latency ms | 0.855 |
| p95 latency ms | 0.945 |
| p99 latency ms | 1.127 |
| p99.9 latency ms | 16.252 |
| Max latency ms | 143.173 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 8353 | 0 | 0.00 | 0.096 | 0.682 | 0.622 | 1.020 | 1.181 | 16.118 | 29.894 |
| GET /health | 5926 | 0 | 0.00 | 0.079 | 0.641 | 0.580 | 0.942 | 1.125 | 16.801 | 26.350 |
| GET /api/users | 26708 | 0 | 0.00 | 0.068 | 0.524 | 0.472 | 0.908 | 1.087 | 16.063 | 143.173 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
