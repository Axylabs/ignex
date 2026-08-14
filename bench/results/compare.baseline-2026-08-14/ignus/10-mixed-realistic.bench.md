# Ignus HTTP comparison report — ignus / 10-mixed-realistic

Generated: 2026-08-14T00:18:19.838Z

Failure trace: `10-mixed-realistic.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 10-mixed-realistic |
| Generated | 2026-08-14T00:18:19.838Z |
| Total duration ms | 65018.123 |
| Achieved RPS | 628.61 |
| Total requests | 40871 |
| Successful requests | 40871 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.603 |
| Min latency ms | 0.085 |
| p50 latency ms | 0.554 |
| p75 latency ms | 0.710 |
| p90 latency ms | 0.899 |
| p95 latency ms | 0.998 |
| p99 latency ms | 1.211 |
| p99.9 latency ms | 6.489 |
| Max latency ms | 150.245 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 8404 | 0 | 0.00 | 0.154 | 0.712 | 0.657 | 1.079 | 1.340 | 6.420 | 150.245 |
| GET /health | 5963 | 0 | 0.00 | 0.104 | 0.730 | 0.622 | 1.007 | 1.342 | 19.262 | 150.139 |
| GET /api/users | 26504 | 0 | 0.00 | 0.085 | 0.541 | 0.506 | 0.952 | 1.156 | 5.854 | 19.262 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
