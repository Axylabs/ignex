# Ignus HTTP comparison report — elysia / 20-validation-storm

Generated: 2026-08-14T00:39:32.403Z

Failure trace: `20-validation-storm.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 20-validation-storm |
| Generated | 2026-08-14T00:39:32.403Z |
| Total duration ms | 50015.579 |
| Achieved RPS | 537.41 |
| Total requests | 26879 |
| Successful requests | 24234 |
| Expected error responses | 2645 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.548 |
| Min latency ms | 0.097 |
| p50 latency ms | 0.431 |
| p75 latency ms | 0.557 |
| p90 latency ms | 0.805 |
| p95 latency ms | 0.989 |
| p99 latency ms | 1.150 |
| p99.9 latency ms | 22.307 |
| Max latency ms | 164.375 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 5462 | 0 | 0.00 | 0.130 | 0.546 | 0.430 | 1.019 | 1.163 | 22.723 | 29.662 |
| POST /api/users | 9279 | 2645 | 28.51 | 0.124 | 0.572 | 0.451 | 1.011 | 1.161 | 20.587 | 164.375 |
| PATCH /api/users | 5467 | 0 | 0.00 | 0.136 | 0.579 | 0.433 | 0.998 | 1.169 | 27.256 | 39.665 |
| GET /api/users | 4025 | 0 | 0.00 | 0.130 | 0.495 | 0.413 | 0.948 | 1.101 | 10.419 | 41.393 |
| OPTIONS /api/users | 2646 | 0 | 0.00 | 0.097 | 0.482 | 0.388 | 0.871 | 1.022 | 19.108 | 27.344 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
