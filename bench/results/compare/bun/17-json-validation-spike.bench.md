# Ignus HTTP comparison report — bun / 17-json-validation-spike

Generated: 2026-08-14T00:34:11.994Z

Failure trace: `17-json-validation-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 17-json-validation-spike |
| Generated | 2026-08-14T00:34:11.994Z |
| Total duration ms | 65058.870 |
| Achieved RPS | 426.69 |
| Total requests | 27760 |
| Successful requests | 27760 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.510 |
| Min latency ms | 0.081 |
| p50 latency ms | 0.469 |
| p75 latency ms | 0.554 |
| p90 latency ms | 0.737 |
| p95 latency ms | 0.949 |
| p99 latency ms | 1.153 |
| p99.9 latency ms | 3.316 |
| Max latency ms | 144.928 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 13847 | 0 | 0.00 | 0.081 | 0.522 | 0.485 | 0.993 | 1.194 | 3.460 | 5.752 |
| GET /api/users | 8383 | 0 | 0.00 | 0.103 | 0.515 | 0.460 | 0.939 | 1.128 | 3.239 | 144.928 |
| GET /health | 5530 | 0 | 0.00 | 0.082 | 0.472 | 0.443 | 0.876 | 1.021 | 3.455 | 15.102 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
