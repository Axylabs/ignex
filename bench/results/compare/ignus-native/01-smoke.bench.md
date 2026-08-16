# Ignus HTTP comparison report — ignus-native / 01-smoke

Generated: 2026-08-15T22:13:59.461Z

Failure trace: `01-smoke.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-native |
| Scenario | 01-smoke |
| Generated | 2026-08-15T22:13:59.461Z |
| Total duration ms | 10201.073 |
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
| Avg latency ms | 0.831 |
| Min latency ms | 0.453 |
| p50 latency ms | 0.717 |
| p75 latency ms | 1.074 |
| p90 latency ms | 1.279 |
| p95 latency ms | 1.545 |
| p99 latency ms | 1.778 |
| p99.9 latency ms | 1.778 |
| Max latency ms | 1.778 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 20 | 0 | 0.00 | 0.496 | 0.898 | 0.825 | 1.778 | 1.778 | 1.778 | 1.778 |
| POST /api/users | 16 | 0 | 0.00 | 0.564 | 0.939 | 0.729 | 1.562 | 1.562 | 1.562 | 1.562 |
| GET /health | 16 | 0 | 0.00 | 0.453 | 0.640 | 0.617 | 1.160 | 1.160 | 1.160 | 1.160 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
