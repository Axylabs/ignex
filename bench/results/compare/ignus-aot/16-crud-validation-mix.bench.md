# Ignus HTTP comparison report — ignus-aot / 16-crud-validation-mix

Generated: 2026-08-16T19:44:31.767Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-16T19:44:31.767Z |
| Total duration ms | 100020.945 |
| Achieved RPS | 260.03 |
| Total requests | 26008 |
| Successful requests | 23465 |
| Expected error responses | 2543 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.575 |
| Min latency ms | 0.074 |
| p50 latency ms | 0.511 |
| p75 latency ms | 0.642 |
| p90 latency ms | 0.769 |
| p95 latency ms | 0.850 |
| p99 latency ms | 1.572 |
| p99.9 latency ms | 9.173 |
| Max latency ms | 89.458 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 3870 | 0 | 0.00 | 0.087 | 0.605 | 0.523 | 0.876 | 2.055 | 11.394 | 86.176 |
| PATCH /api/users | 2644 | 0 | 0.00 | 0.115 | 0.639 | 0.522 | 0.864 | 1.453 | 61.055 | 89.458 |
| POST /api/users | 9011 | 2543 | 28.22 | 0.092 | 0.586 | 0.509 | 0.851 | 1.782 | 10.755 | 88.059 |
| GET /api/users | 10483 | 0 | 0.00 | 0.074 | 0.537 | 0.504 | 0.835 | 1.286 | 7.178 | 21.184 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
