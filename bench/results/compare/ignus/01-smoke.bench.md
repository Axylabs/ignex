# Ignus HTTP comparison report — ignus / 01-smoke

Generated: 2026-08-14T08:20:17.099Z

Failure trace: `01-smoke.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 01-smoke |
| Generated | 2026-08-14T08:20:17.099Z |
| Total duration ms | 10002.262 |
| Achieved RPS | 5.10 |
| Total requests | 51 |
| Successful requests | 51 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.155 |
| Min latency ms | 0.396 |
| p50 latency ms | 1.133 |
| p75 latency ms | 1.255 |
| p90 latency ms | 1.353 |
| p95 latency ms | 1.382 |
| p99 latency ms | 3.562 |
| p99.9 latency ms | 3.562 |
| Max latency ms | 3.562 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 12 | 0 | 0.00 | 0.999 | 1.271 | 1.204 | 2.040 | 2.040 | 2.040 | 2.040 |
| POST /api/users | 22 | 0 | 0.00 | 0.405 | 1.207 | 1.182 | 1.382 | 3.562 | 3.562 | 3.562 |
| GET /health | 17 | 0 | 0.00 | 0.396 | 1.006 | 1.018 | 1.286 | 1.286 | 1.286 | 1.286 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
