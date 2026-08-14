# Ignus HTTP comparison report — elysia / 04-spike

Generated: 2026-08-14T07:35:40.178Z

Failure trace: `04-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 04-spike |
| Generated | 2026-08-14T07:35:40.178Z |
| Total duration ms | 100149.002 |
| Achieved RPS | 833.84 |
| Total requests | 83508 |
| Successful requests | 83508 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.207 |
| Min latency ms | 0.041 |
| p50 latency ms | 0.119 |
| p75 latency ms | 0.162 |
| p90 latency ms | 0.248 |
| p95 latency ms | 0.481 |
| p99 latency ms | 1.067 |
| p99.9 latency ms | 14.751 |
| Max latency ms | 19.139 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 41754 | 0 | 0.00 | 0.041 | 0.234 | 0.130 | 0.560 | 1.229 | 16.932 | 19.139 |
| POST /api/users | 41754 | 0 | 0.00 | 0.042 | 0.180 | 0.105 | 0.428 | 0.885 | 11.214 | 18.754 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
