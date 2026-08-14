# Ignus HTTP comparison report — elysia / 01-smoke

Generated: 2026-08-13T23:54:02.711Z

Failure trace: `01-smoke.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 01-smoke |
| Generated | 2026-08-13T23:54:02.711Z |
| Total duration ms | 10201.077 |
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
| Avg latency ms | 1.171 |
| Min latency ms | 0.396 |
| p50 latency ms | 1.015 |
| p75 latency ms | 1.212 |
| p90 latency ms | 1.324 |
| p95 latency ms | 1.414 |
| p99 latency ms | 9.912 |
| p99.9 latency ms | 9.912 |
| Max latency ms | 9.912 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 17 | 0 | 0.00 | 0.546 | 1.539 | 1.072 | 9.912 | 9.912 | 9.912 | 9.912 |
| GET /api/users | 18 | 0 | 0.00 | 0.609 | 1.140 | 1.058 | 3.424 | 3.424 | 3.424 | 3.424 |
| GET /health | 17 | 0 | 0.00 | 0.396 | 0.836 | 0.959 | 1.183 | 1.183 | 1.183 | 1.183 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
