# Ignus HTTP comparison report — ignus / 01-smoke

Generated: 2026-08-15T22:14:15.722Z

Failure trace: `01-smoke.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 01-smoke |
| Generated | 2026-08-15T22:14:15.722Z |
| Total duration ms | 10200.439 |
| Achieved RPS | 5.10 |
| Total requests | 52 |
| Successful requests | 52 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.127 |
| Min latency ms | 0.316 |
| p50 latency ms | 0.650 |
| p75 latency ms | 0.901 |
| p90 latency ms | 1.433 |
| p95 latency ms | 3.379 |
| p99 latency ms | 11.638 |
| p99.9 latency ms | 11.638 |
| Max latency ms | 11.638 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /health | 16 | 0 | 0.00 | 0.316 | 1.867 | 0.671 | 11.638 | 11.638 | 11.638 | 11.638 |
| POST /api/users | 19 | 0 | 0.00 | 0.481 | 0.946 | 0.657 | 2.910 | 2.910 | 2.910 | 2.910 |
| GET /api/users | 17 | 0 | 0.00 | 0.370 | 0.632 | 0.608 | 1.186 | 1.186 | 1.186 | 1.186 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
