# Ignus HTTP comparison report — bun / 07-cors-preflight

Generated: 2026-08-14T07:39:20.538Z

Failure trace: `07-cors-preflight.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 07-cors-preflight |
| Generated | 2026-08-14T07:39:20.538Z |
| Total duration ms | 30008.973 |
| Achieved RPS | 100.04 |
| Total requests | 3002 |
| Successful requests | 2365 |
| Expected error responses | 637 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.458 |
| Min latency ms | 0.117 |
| p50 latency ms | 0.444 |
| p75 latency ms | 0.561 |
| p90 latency ms | 0.654 |
| p95 latency ms | 0.720 |
| p99 latency ms | 1.066 |
| p99.9 latency ms | 4.858 |
| Max latency ms | 7.168 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 565 | 0 | 0.00 | 0.200 | 0.538 | 0.539 | 0.820 | 1.249 | 4.858 | 4.858 |
| OPTIONS /api/users | 2437 | 637 | 26.14 | 0.117 | 0.439 | 0.431 | 0.666 | 1.032 | 5.090 | 7.168 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
