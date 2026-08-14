# Ignus HTTP comparison report — bun / 11-concurrent-burst

Generated: 2026-08-14T00:18:55.069Z

Failure trace: `11-concurrent-burst.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 11-concurrent-burst |
| Generated | 2026-08-14T00:18:55.069Z |
| Total duration ms | 35201.643 |
| Achieved RPS | 847.20 |
| Total requests | 29823 |
| Successful requests | 29823 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.661 |
| Min latency ms | 0.089 |
| p50 latency ms | 0.446 |
| p75 latency ms | 0.509 |
| p90 latency ms | 0.583 |
| p95 latency ms | 0.642 |
| p99 latency ms | 1.216 |
| p99.9 latency ms | 132.067 |
| Max latency ms | 143.875 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 11850 | 0 | 0.00 | 0.096 | 0.659 | 0.461 | 0.656 | 1.636 | 132.216 | 143.775 |
| GET /api/users | 17973 | 0 | 0.00 | 0.089 | 0.663 | 0.437 | 0.630 | 1.065 | 132.041 | 143.875 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
