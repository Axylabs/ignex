# Ignus HTTP comparison report — elysia / 02-load

Generated: 2026-08-13T23:58:14.045Z

Failure trace: `02-load.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 02-load |
| Generated | 2026-08-13T23:58:14.045Z |
| Total duration ms | 120544.077 |
| Achieved RPS | 211.13 |
| Total requests | 25450 |
| Successful requests | 25450 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.618 |
| Min latency ms | 0.098 |
| p50 latency ms | 0.493 |
| p75 latency ms | 0.661 |
| p90 latency ms | 0.864 |
| p95 latency ms | 0.974 |
| p99 latency ms | 2.145 |
| p99.9 latency ms | 22.209 |
| Max latency ms | 80.724 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 1527 | 0 | 0.00 | 0.192 | 0.734 | 0.568 | 1.070 | 3.050 | 32.500 | 39.389 |
| GET /api/users | 10444 | 0 | 0.00 | 0.098 | 0.652 | 0.521 | 0.992 | 2.172 | 30.969 | 66.881 |
| POST /api/users | 10444 | 0 | 0.00 | 0.103 | 0.579 | 0.458 | 0.930 | 2.090 | 22.132 | 80.724 |
| GET /health | 3035 | 0 | 0.00 | 0.135 | 0.579 | 0.486 | 0.914 | 2.003 | 16.055 | 19.396 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
