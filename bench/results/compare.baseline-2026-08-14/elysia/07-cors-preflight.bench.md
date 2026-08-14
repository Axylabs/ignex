# Ignus HTTP comparison report — elysia / 07-cors-preflight

Generated: 2026-08-14T00:13:04.294Z

Failure trace: `07-cors-preflight.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 07-cors-preflight |
| Generated | 2026-08-14T00:13:04.294Z |
| Total duration ms | 30010.499 |
| Achieved RPS | 100.03 |
| Total requests | 3002 |
| Successful requests | 3002 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.169 |
| Min latency ms | 0.173 |
| p50 latency ms | 0.864 |
| p75 latency ms | 0.961 |
| p90 latency ms | 1.052 |
| p95 latency ms | 1.108 |
| p99 latency ms | 1.327 |
| p99.9 latency ms | 132.713 |
| Max latency ms | 132.945 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 643 | 0 | 0.00 | 0.362 | 1.245 | 1.001 | 1.167 | 1.408 | 86.598 | 86.598 |
| OPTIONS /api/users | 2359 | 0 | 0.00 | 0.173 | 1.148 | 0.836 | 1.024 | 1.321 | 132.756 | 132.945 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
