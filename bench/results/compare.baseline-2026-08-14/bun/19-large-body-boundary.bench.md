# Ignus HTTP comparison report — bun / 19-large-body-boundary

Generated: 2026-08-14T00:36:52.240Z

Failure trace: `19-large-body-boundary.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 19-large-body-boundary |
| Generated | 2026-08-14T00:36:52.240Z |
| Total duration ms | 30059.714 |
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
| Avg latency ms | 1.725 |
| Min latency ms | 0.573 |
| p50 latency ms | 1.184 |
| p75 latency ms | 1.786 |
| p90 latency ms | 3.820 |
| p95 latency ms | 4.316 |
| p99 latency ms | 5.789 |
| p99.9 latency ms | 7.876 |
| Max latency ms | 7.876 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 481 | 0 | 0.00 | 0.573 | 1.912 | 1.290 | 4.534 | 6.218 | 7.876 | 7.876 |
| POST /api/users | 121 | 0 | 0.00 | 0.590 | 0.982 | 0.962 | 1.265 | 2.082 | 2.415 | 2.415 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
