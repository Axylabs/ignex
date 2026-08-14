# Ignus HTTP comparison report — ignus / 02-load

Generated: 2026-08-14T07:27:07.271Z

Failure trace: `02-load.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 02-load |
| Generated | 2026-08-14T07:27:07.271Z |
| Total duration ms | 120544.450 |
| Achieved RPS | 211.49 |
| Total requests | 25494 |
| Successful requests | 25494 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.467 |
| Min latency ms | 0.057 |
| p50 latency ms | 0.372 |
| p75 latency ms | 0.618 |
| p90 latency ms | 0.799 |
| p95 latency ms | 0.882 |
| p99 latency ms | 1.080 |
| p99.9 latency ms | 9.237 |
| Max latency ms | 22.306 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 1536 | 0 | 0.00 | 0.100 | 0.526 | 0.397 | 0.962 | 1.275 | 11.588 | 13.287 |
| GET /api/users | 10488 | 0 | 0.00 | 0.069 | 0.497 | 0.386 | 0.903 | 1.111 | 10.903 | 20.258 |
| GET /health | 2982 | 0 | 0.00 | 0.057 | 0.440 | 0.369 | 0.833 | 0.983 | 1.862 | 8.592 |
| POST /api/users | 10488 | 0 | 0.00 | 0.069 | 0.435 | 0.359 | 0.828 | 1.041 | 9.679 | 22.306 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
