# Ignus HTTP comparison report — ignus-aot / 15-heavy-json-wide

Generated: 2026-08-14T08:40:31.704Z

Failure trace: `15-heavy-json-wide.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 15-heavy-json-wide |
| Generated | 2026-08-14T08:40:31.704Z |
| Total duration ms | 50054.293 |
| Achieved RPS | 106.00 |
| Total requests | 5306 |
| Successful requests | 2101 |
| Expected error responses | 3205 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.890 |
| Min latency ms | 0.121 |
| p50 latency ms | 0.897 |
| p75 latency ms | 0.959 |
| p90 latency ms | 1.012 |
| p95 latency ms | 1.050 |
| p99 latency ms | 1.363 |
| p99.9 latency ms | 2.208 |
| Max latency ms | 38.768 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 4773 | 3205 | 67.15 | 0.121 | 0.897 | 0.904 | 1.056 | 1.363 | 2.316 | 38.768 |
| POST /api/echo | 533 | 0 | 0.00 | 0.225 | 0.823 | 0.838 | 0.996 | 1.441 | 2.043 | 2.043 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
