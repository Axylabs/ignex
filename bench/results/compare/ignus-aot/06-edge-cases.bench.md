# Ignus HTTP comparison report — ignus-aot / 06-edge-cases

Generated: 2026-08-14T08:35:11.201Z

Failure trace: `06-edge-cases.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 06-edge-cases |
| Generated | 2026-08-14T08:35:11.201Z |
| Total duration ms | 30049.478 |
| Achieved RPS | 20.03 |
| Total requests | 602 |
| Successful requests | 205 |
| Expected error responses | 397 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.943 |
| Min latency ms | 0.326 |
| p50 latency ms | 0.937 |
| p75 latency ms | 1.027 |
| p90 latency ms | 1.137 |
| p95 latency ms | 1.241 |
| p99 latency ms | 1.668 |
| p99.9 latency ms | 2.466 |
| Max latency ms | 2.466 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 67 | 0 | 0.00 | 0.355 | 1.095 | 1.108 | 1.348 | 1.575 | 1.575 | 1.575 |
| DELETE /api/users | 30 | 30 | 100.00 | 0.500 | 0.870 | 0.868 | 1.304 | 1.658 | 1.658 | 1.658 |
| GET /api/users | 55 | 0 | 0.00 | 0.609 | 1.062 | 1.054 | 1.287 | 1.921 | 1.921 | 1.921 |
| POST /api/users | 365 | 311 | 85.21 | 0.326 | 0.926 | 0.932 | 1.137 | 1.782 | 2.466 | 2.466 |
| HEAD /health | 29 | 0 | 0.00 | 0.433 | 0.888 | 0.902 | 1.094 | 1.257 | 1.257 | 1.257 |
| GET /api/nonexistent | 56 | 56 | 100.00 | 0.572 | 0.820 | 0.848 | 0.979 | 1.008 | 1.008 | 1.008 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
