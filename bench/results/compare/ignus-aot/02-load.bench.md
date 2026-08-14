# Ignus HTTP comparison report — ignus-aot / 02-load

Generated: 2026-08-14T08:31:17.131Z

Failure trace: `02-load.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 02-load |
| Generated | 2026-08-14T08:31:17.131Z |
| Total duration ms | 120544.156 |
| Achieved RPS | 210.84 |
| Total requests | 25416 |
| Successful requests | 25416 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.678 |
| Min latency ms | 0.060 |
| p50 latency ms | 0.663 |
| p75 latency ms | 0.814 |
| p90 latency ms | 0.917 |
| p95 latency ms | 0.974 |
| p99 latency ms | 1.224 |
| p99.9 latency ms | 11.550 |
| Max latency ms | 51.887 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 1554 | 0 | 0.00 | 0.158 | 0.815 | 0.810 | 1.049 | 1.380 | 20.406 | 30.764 |
| GET /api/users | 10410 | 0 | 0.00 | 0.091 | 0.728 | 0.734 | 0.980 | 1.242 | 15.616 | 51.887 |
| POST /api/users | 10410 | 0 | 0.00 | 0.060 | 0.616 | 0.588 | 0.953 | 1.170 | 9.931 | 37.960 |
| GET /health | 3042 | 0 | 0.00 | 0.071 | 0.654 | 0.666 | 0.915 | 1.103 | 8.086 | 16.038 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
