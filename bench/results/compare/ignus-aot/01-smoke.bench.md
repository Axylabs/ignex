# Ignus HTTP comparison report — ignus-aot / 01-smoke

Generated: 2026-08-14T08:29:16.564Z

Failure trace: `01-smoke.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 01-smoke |
| Generated | 2026-08-14T08:29:16.564Z |
| Total duration ms | 10202.046 |
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
| Avg latency ms | 1.145 |
| Min latency ms | 0.331 |
| p50 latency ms | 1.166 |
| p75 latency ms | 1.278 |
| p90 latency ms | 1.542 |
| p95 latency ms | 1.669 |
| p99 latency ms | 3.942 |
| p99.9 latency ms | 3.942 |
| Max latency ms | 3.942 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 14 | 0 | 0.00 | 0.440 | 1.279 | 1.228 | 3.942 | 3.942 | 3.942 | 3.942 |
| GET /api/users | 20 | 0 | 0.00 | 0.579 | 1.307 | 1.272 | 3.094 | 3.094 | 3.094 | 3.094 |
| GET /health | 18 | 0 | 0.00 | 0.331 | 0.860 | 1.020 | 1.218 | 1.218 | 1.218 | 1.218 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
