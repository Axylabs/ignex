# Ignus HTTP comparison report — elysia / 11-concurrent-burst

Generated: 2026-08-14T00:19:30.299Z

Failure trace: `11-concurrent-burst.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 11-concurrent-burst |
| Generated | 2026-08-14T00:19:30.299Z |
| Total duration ms | 35201.398 |
| Achieved RPS | 845.85 |
| Total requests | 29775 |
| Successful requests | 29775 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.466 |
| Min latency ms | 0.110 |
| p50 latency ms | 0.422 |
| p75 latency ms | 0.530 |
| p90 latency ms | 0.639 |
| p95 latency ms | 0.709 |
| p99 latency ms | 1.244 |
| p99.9 latency ms | 3.650 |
| Max latency ms | 126.744 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 11962 | 0 | 0.00 | 0.130 | 0.486 | 0.439 | 0.730 | 1.304 | 4.291 | 126.744 |
| GET /api/users | 17813 | 0 | 0.00 | 0.110 | 0.452 | 0.410 | 0.694 | 1.205 | 3.650 | 124.116 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
