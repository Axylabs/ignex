# Ignus HTTP comparison report — ignus-aot / 14-heavy-json-arrays

Generated: 2026-08-14T08:39:41.643Z

Failure trace: `14-heavy-json-arrays.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 14-heavy-json-arrays |
| Generated | 2026-08-14T08:39:41.643Z |
| Total duration ms | 50078.972 |
| Achieved RPS | 72.01 |
| Total requests | 3606 |
| Successful requests | 2892 |
| Expected error responses | 714 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.949 |
| Min latency ms | 0.214 |
| p50 latency ms | 0.916 |
| p75 latency ms | 1.005 |
| p90 latency ms | 1.156 |
| p95 latency ms | 1.311 |
| p99 latency ms | 2.426 |
| p99.9 latency ms | 5.642 |
| Max latency ms | 7.109 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 1081 | 0 | 0.00 | 0.330 | 1.121 | 1.026 | 2.021 | 3.212 | 5.191 | 5.635 |
| POST /api/users | 2525 | 714 | 28.28 | 0.214 | 0.876 | 0.889 | 1.064 | 1.352 | 5.682 | 7.109 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
