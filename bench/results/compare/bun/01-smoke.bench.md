# Ignus HTTP comparison report — bun / 01-smoke

Generated: 2026-08-14T08:19:57.091Z

Failure trace: `01-smoke.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 01-smoke |
| Generated | 2026-08-14T08:19:57.091Z |
| Total duration ms | 10202.343 |
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
| Avg latency ms | 0.750 |
| Min latency ms | 0.330 |
| p50 latency ms | 0.706 |
| p75 latency ms | 0.864 |
| p90 latency ms | 0.975 |
| p95 latency ms | 1.359 |
| p99 latency ms | 1.754 |
| p99.9 latency ms | 1.754 |
| Max latency ms | 1.754 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 13 | 0 | 0.00 | 0.333 | 0.862 | 0.891 | 1.754 | 1.754 | 1.754 | 1.754 |
| GET /health | 20 | 0 | 0.00 | 0.330 | 0.675 | 0.665 | 1.727 | 1.727 | 1.727 | 1.727 |
| GET /api/users | 19 | 0 | 0.00 | 0.330 | 0.752 | 0.752 | 1.359 | 1.359 | 1.359 | 1.359 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
