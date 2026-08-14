# Ignus HTTP comparison report — bun / 16-crud-validation-mix

Generated: 2026-08-14T08:22:23.928Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-14T08:22:23.928Z |
| Total duration ms | 100023.951 |
| Achieved RPS | 260.02 |
| Total requests | 26008 |
| Successful requests | 23322 |
| Expected error responses | 2686 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.387 |
| Min latency ms | 0.051 |
| p50 latency ms | 0.328 |
| p75 latency ms | 0.511 |
| p90 latency ms | 0.652 |
| p95 latency ms | 0.730 |
| p99 latency ms | 0.897 |
| p99.9 latency ms | 2.695 |
| Max latency ms | 39.953 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 3912 | 0 | 0.00 | 0.060 | 0.388 | 0.330 | 0.747 | 0.920 | 2.251 | 3.732 |
| PATCH /api/users | 2549 | 0 | 0.00 | 0.060 | 0.390 | 0.332 | 0.739 | 0.923 | 3.620 | 9.688 |
| POST /api/users | 9172 | 2686 | 29.28 | 0.051 | 0.386 | 0.329 | 0.726 | 0.911 | 2.820 | 14.007 |
| GET /api/users | 10375 | 0 | 0.00 | 0.057 | 0.386 | 0.326 | 0.722 | 0.863 | 2.695 | 39.953 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
