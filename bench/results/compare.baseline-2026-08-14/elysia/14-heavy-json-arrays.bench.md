# Ignus HTTP comparison report — elysia / 14-heavy-json-arrays

Generated: 2026-08-14T00:24:46.473Z

Failure trace: `14-heavy-json-arrays.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 14-heavy-json-arrays |
| Generated | 2026-08-14T00:24:46.473Z |
| Total duration ms | 50048.136 |
| Achieved RPS | 72.03 |
| Total requests | 3605 |
| Successful requests | 2835 |
| Expected error responses | 770 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.249 |
| Min latency ms | 0.336 |
| p50 latency ms | 1.088 |
| p75 latency ms | 1.257 |
| p90 latency ms | 1.525 |
| p95 latency ms | 1.793 |
| p99 latency ms | 3.661 |
| p99.9 latency ms | 15.892 |
| Max latency ms | 147.521 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 1039 | 0 | 0.00 | 0.625 | 1.572 | 1.338 | 2.631 | 5.384 | 15.331 | 58.750 |
| POST /api/users | 2566 | 770 | 30.01 | 0.336 | 1.119 | 1.025 | 1.357 | 2.949 | 15.892 | 147.521 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
