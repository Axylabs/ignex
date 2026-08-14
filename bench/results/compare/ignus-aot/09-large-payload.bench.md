# Ignus HTTP comparison report — ignus-aot / 09-large-payload

Generated: 2026-08-14T08:36:11.231Z

Failure trace: `09-large-payload.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 09-large-payload |
| Generated | 2026-08-14T08:36:11.231Z |
| Total duration ms | 30013.678 |
| Achieved RPS | 10.03 |
| Total requests | 301 |
| Successful requests | 301 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 4.340 |
| Min latency ms | 0.494 |
| p50 latency ms | 3.184 |
| p75 latency ms | 4.208 |
| p90 latency ms | 12.913 |
| p95 latency ms | 14.346 |
| p99 latency ms | 14.957 |
| p99.9 latency ms | 19.975 |
| Max latency ms | 19.975 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 301 | 0 | 0.00 | 0.494 | 4.340 | 3.184 | 14.346 | 14.957 | 19.975 | 19.975 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
