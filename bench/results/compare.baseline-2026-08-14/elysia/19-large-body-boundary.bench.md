# Ignus HTTP comparison report — elysia / 19-large-body-boundary

Generated: 2026-08-14T00:37:22.255Z

Failure trace: `19-large-body-boundary.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 19-large-body-boundary |
| Generated | 2026-08-14T00:37:22.255Z |
| Total duration ms | 30011.216 |
| Achieved RPS | 20.03 |
| Total requests | 601 |
| Successful requests | 601 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 2.484 |
| Min latency ms | 0.531 |
| p50 latency ms | 1.574 |
| p75 latency ms | 3.199 |
| p90 latency ms | 5.505 |
| p95 latency ms | 6.480 |
| p99 latency ms | 8.467 |
| p99.9 latency ms | 14.097 |
| Max latency ms | 14.097 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 468 | 0 | 0.00 | 0.784 | 2.889 | 1.780 | 6.872 | 8.816 | 14.097 | 14.097 |
| POST /api/users | 133 | 0 | 0.00 | 0.531 | 1.058 | 1.064 | 1.818 | 2.108 | 2.803 | 2.803 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
