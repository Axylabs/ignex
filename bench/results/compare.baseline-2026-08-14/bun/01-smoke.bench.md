# Ignus HTTP comparison report — bun / 01-smoke

Generated: 2026-08-13T23:53:52.508Z

Failure trace: `01-smoke.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 01-smoke |
| Generated | 2026-08-13T23:53:52.508Z |
| Total duration ms | 10201.181 |
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
| Avg latency ms | 1.000 |
| Min latency ms | 0.332 |
| p50 latency ms | 0.994 |
| p75 latency ms | 1.110 |
| p90 latency ms | 1.215 |
| p95 latency ms | 1.263 |
| p99 latency ms | 2.409 |
| p99.9 latency ms | 2.409 |
| Max latency ms | 2.409 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 16 | 0 | 0.00 | 0.706 | 1.166 | 1.094 | 2.409 | 2.409 | 2.409 | 2.409 |
| GET /api/users | 22 | 0 | 0.00 | 0.613 | 0.991 | 1.048 | 1.148 | 1.249 | 1.249 | 1.249 |
| GET /health | 14 | 0 | 0.00 | 0.332 | 0.823 | 0.883 | 0.956 | 0.956 | 0.956 | 0.956 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
