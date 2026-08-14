# Ignus HTTP comparison report — ignus-aot / 19-large-body-boundary

Generated: 2026-08-14T08:43:46.889Z

Failure trace: `19-large-body-boundary.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 19-large-body-boundary |
| Generated | 2026-08-14T08:43:46.889Z |
| Total duration ms | 30055.708 |
| Achieved RPS | 20.03 |
| Total requests | 602 |
| Successful requests | 602 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.714 |
| Min latency ms | 0.377 |
| p50 latency ms | 1.147 |
| p75 latency ms | 1.793 |
| p90 latency ms | 3.822 |
| p95 latency ms | 4.342 |
| p99 latency ms | 5.089 |
| p99.9 latency ms | 6.958 |
| Max latency ms | 6.958 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 487 | 0 | 0.00 | 0.377 | 1.888 | 1.240 | 4.430 | 5.567 | 6.958 | 6.958 |
| POST /api/users | 115 | 0 | 0.00 | 0.406 | 0.977 | 0.973 | 1.193 | 1.625 | 2.031 | 2.031 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
