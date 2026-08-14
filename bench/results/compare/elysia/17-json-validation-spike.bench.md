# Ignus HTTP comparison report — elysia / 17-json-validation-spike

Generated: 2026-08-14T00:35:17.085Z

Failure trace: `17-json-validation-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 17-json-validation-spike |
| Generated | 2026-08-14T00:35:17.085Z |
| Total duration ms | 65058.745 |
| Achieved RPS | 426.72 |
| Total requests | 27762 |
| Successful requests | 27762 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.564 |
| Min latency ms | 0.113 |
| p50 latency ms | 0.520 |
| p75 latency ms | 0.619 |
| p90 latency ms | 0.821 |
| p95 latency ms | 1.013 |
| p99 latency ms | 1.217 |
| p99.9 latency ms | 2.946 |
| Max latency ms | 137.704 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 13926 | 0 | 0.00 | 0.137 | 0.593 | 0.543 | 1.061 | 1.250 | 3.279 | 137.704 |
| GET /api/users | 8289 | 0 | 0.00 | 0.116 | 0.544 | 0.504 | 0.990 | 1.158 | 2.759 | 16.730 |
| GET /health | 5547 | 0 | 0.00 | 0.113 | 0.522 | 0.488 | 0.939 | 1.130 | 2.338 | 12.253 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
