# Ignus HTTP comparison report — elysia / 01-smoke

Generated: 2026-08-14T08:20:07.095Z

Failure trace: `01-smoke.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 01-smoke |
| Generated | 2026-08-14T08:20:07.095Z |
| Total duration ms | 10001.929 |
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
| Avg latency ms | 1.375 |
| Min latency ms | 0.318 |
| p50 latency ms | 1.017 |
| p75 latency ms | 1.154 |
| p90 latency ms | 1.246 |
| p95 latency ms | 1.785 |
| p99 latency ms | 18.894 |
| p99.9 latency ms | 18.894 |
| Max latency ms | 18.894 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 13 | 0 | 0.00 | 0.994 | 2.473 | 1.104 | 18.894 | 18.894 | 18.894 | 18.894 |
| GET /api/users | 19 | 0 | 0.00 | 0.441 | 1.169 | 1.092 | 3.581 | 3.581 | 3.581 | 3.581 |
| GET /health | 19 | 0 | 0.00 | 0.318 | 0.829 | 0.794 | 1.785 | 1.785 | 1.785 | 1.785 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
