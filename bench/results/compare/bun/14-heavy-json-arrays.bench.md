# Ignus HTTP comparison report — bun / 14-heavy-json-arrays

Generated: 2026-08-14T01:04:22.195Z

Failure trace: `14-heavy-json-arrays.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 14-heavy-json-arrays |
| Generated | 2026-08-14T01:04:22.195Z |
| Total duration ms | 50076.074 |
| Achieved RPS | 72.01 |
| Total requests | 3606 |
| Successful requests | 2868 |
| Expected error responses | 738 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.114 |
| Min latency ms | 0.279 |
| p50 latency ms | 0.944 |
| p75 latency ms | 1.049 |
| p90 latency ms | 1.253 |
| p95 latency ms | 1.551 |
| p99 latency ms | 3.132 |
| p99.9 latency ms | 46.825 |
| Max latency ms | 173.162 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 1098 | 0 | 0.00 | 0.445 | 1.279 | 1.081 | 2.273 | 4.106 | 29.356 | 49.958 |
| POST /api/users | 2508 | 738 | 29.43 | 0.279 | 1.041 | 0.908 | 1.102 | 2.327 | 46.825 | 173.162 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
