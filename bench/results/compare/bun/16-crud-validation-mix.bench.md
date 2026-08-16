# Ignus HTTP comparison report — bun / 16-crud-validation-mix

Generated: 2026-08-16T19:37:51.603Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-16T19:37:51.603Z |
| Total duration ms | 100022.807 |
| Achieved RPS | 260.02 |
| Total requests | 26008 |
| Successful requests | 23443 |
| Expected error responses | 2565 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.518 |
| Min latency ms | 0.078 |
| p50 latency ms | 0.472 |
| p75 latency ms | 0.568 |
| p90 latency ms | 0.677 |
| p95 latency ms | 0.751 |
| p99 latency ms | 1.087 |
| p99.9 latency ms | 18.805 |
| Max latency ms | 42.668 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 3856 | 0 | 0.00 | 0.114 | 0.519 | 0.480 | 0.770 | 1.038 | 18.870 | 23.126 |
| POST /api/users | 9033 | 2565 | 28.40 | 0.090 | 0.523 | 0.478 | 0.757 | 1.067 | 19.661 | 42.668 |
| PATCH /api/users | 2554 | 0 | 0.00 | 0.102 | 0.535 | 0.482 | 0.747 | 1.075 | 19.171 | 38.004 |
| GET /api/users | 10565 | 0 | 0.00 | 0.078 | 0.510 | 0.463 | 0.739 | 1.126 | 17.025 | 37.947 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
