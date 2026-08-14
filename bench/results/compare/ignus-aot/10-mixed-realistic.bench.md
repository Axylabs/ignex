# Ignus HTTP comparison report — ignus-aot / 10-mixed-realistic

Generated: 2026-08-14T08:37:16.294Z

Failure trace: `10-mixed-realistic.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 10-mixed-realistic |
| Generated | 2026-08-14T08:37:16.294Z |
| Total duration ms | 65046.471 |
| Achieved RPS | 628.98 |
| Total requests | 40913 |
| Successful requests | 40913 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.353 |
| Min latency ms | 0.042 |
| p50 latency ms | 0.281 |
| p75 latency ms | 0.506 |
| p90 latency ms | 0.731 |
| p95 latency ms | 0.840 |
| p99 latency ms | 0.982 |
| p99.9 latency ms | 2.092 |
| Max latency ms | 37.790 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 8390 | 0 | 0.00 | 0.056 | 0.434 | 0.365 | 0.923 | 1.038 | 2.095 | 2.924 |
| GET /health | 5963 | 0 | 0.00 | 0.047 | 0.416 | 0.349 | 0.846 | 0.950 | 2.216 | 22.447 |
| GET /api/users | 26560 | 0 | 0.00 | 0.042 | 0.313 | 0.246 | 0.788 | 0.951 | 1.994 | 37.790 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
