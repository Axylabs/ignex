# Ignus HTTP comparison report — ignus / 01-smoke

Generated: 2026-08-13T23:54:12.914Z

Failure trace: `01-smoke.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 01-smoke |
| Generated | 2026-08-13T23:54:12.914Z |
| Total duration ms | 10201.078 |
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
| Avg latency ms | 1.159 |
| Min latency ms | 0.522 |
| p50 latency ms | 1.069 |
| p75 latency ms | 1.285 |
| p90 latency ms | 1.582 |
| p95 latency ms | 1.791 |
| p99 latency ms | 5.664 |
| p99.9 latency ms | 5.664 |
| Max latency ms | 5.664 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 15 | 0 | 0.00 | 0.680 | 1.565 | 1.285 | 5.664 | 5.664 | 5.664 | 5.664 |
| GET /api/users | 18 | 0 | 0.00 | 0.578 | 1.105 | 1.078 | 1.607 | 1.607 | 1.607 | 1.607 |
| GET /health | 19 | 0 | 0.00 | 0.522 | 0.889 | 0.852 | 1.343 | 1.343 | 1.343 | 1.343 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
