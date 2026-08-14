# Ignus HTTP comparison report — bun / 14-heavy-json-arrays

Generated: 2026-08-14T00:23:56.419Z

Failure trace: `14-heavy-json-arrays.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 14-heavy-json-arrays |
| Generated | 2026-08-14T00:23:56.419Z |
| Total duration ms | 50080.003 |
| Achieved RPS | 72.00 |
| Total requests | 3606 |
| Successful requests | 2900 |
| Expected error responses | 706 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.947 |
| Min latency ms | 0.295 |
| p50 latency ms | 0.931 |
| p75 latency ms | 1.038 |
| p90 latency ms | 1.178 |
| p95 latency ms | 1.336 |
| p99 latency ms | 2.226 |
| p99.9 latency ms | 6.853 |
| Max latency ms | 9.410 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 1030 | 0 | 0.00 | 0.408 | 1.109 | 1.032 | 1.582 | 2.958 | 7.534 | 9.410 |
| POST /api/users | 2576 | 706 | 27.41 | 0.295 | 0.882 | 0.901 | 1.110 | 1.433 | 4.050 | 9.120 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
