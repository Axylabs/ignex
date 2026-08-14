# Ignus HTTP comparison report — elysia / 03-stress

Generated: 2026-08-14T00:03:47.199Z

Failure trace: `03-stress.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 03-stress |
| Generated | 2026-08-14T00:03:47.199Z |
| Total duration ms | 106047.439 |
| Achieved RPS | 878.71 |
| Total requests | 93185 |
| Successful requests | 93185 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 2614.336 |
| Min latency ms | 0.067 |
| p50 latency ms | 0.514 |
| p75 latency ms | 0.891 |
| p90 latency ms | 13726.933 |
| p95 latency ms | 18577.456 |
| p99 latency ms | 20114.171 |
| p99.9 latency ms | 20228.328 |
| Max latency ms | 20249.044 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 46513 | 0 | 0.00 | 0.070 | 2633.645 | 0.509 | 18646.441 | 20118.275 | 20228.328 | 20248.942 |
| GET /health | 18648 | 0 | 0.00 | 0.091 | 2592.036 | 0.488 | 18569.573 | 20090.563 | 20224.805 | 20249.044 |
| POST /api/users | 28024 | 0 | 0.00 | 0.067 | 2597.125 | 0.538 | 18471.480 | 20118.731 | 20228.812 | 20248.459 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
