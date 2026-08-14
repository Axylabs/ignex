# Ignus HTTP comparison report — elysia / 16-crud-validation-mix

Generated: 2026-08-14T00:31:26.852Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-14T00:31:26.852Z |
| Total duration ms | 100021.949 |
| Achieved RPS | 260.02 |
| Total requests | 26008 |
| Successful requests | 23361 |
| Expected error responses | 2647 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.809 |
| Min latency ms | 0.157 |
| p50 latency ms | 0.764 |
| p75 latency ms | 0.934 |
| p90 latency ms | 1.034 |
| p95 latency ms | 1.089 |
| p99 latency ms | 1.218 |
| p99.9 latency ms | 27.747 |
| Max latency ms | 75.705 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 9084 | 2647 | 29.14 | 0.169 | 0.816 | 0.790 | 1.120 | 1.255 | 7.821 | 45.191 |
| PUT /api/users | 3905 | 0 | 0.00 | 0.177 | 0.856 | 0.767 | 1.091 | 1.219 | 44.016 | 75.705 |
| PATCH /api/users | 2529 | 0 | 0.00 | 0.192 | 0.801 | 0.784 | 1.087 | 1.200 | 5.729 | 45.045 |
| GET /api/users | 10490 | 0 | 0.00 | 0.157 | 0.787 | 0.738 | 1.056 | 1.158 | 31.759 | 45.377 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
