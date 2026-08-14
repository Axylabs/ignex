# Ignus HTTP comparison report — elysia / 04-spike

Generated: 2026-08-14T00:08:53.884Z

Failure trace: `04-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 04-spike |
| Generated | 2026-08-14T00:08:53.884Z |
| Total duration ms | 100151.556 |
| Achieved RPS | 830.46 |
| Total requests | 83172 |
| Successful requests | 83172 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.428 |
| Min latency ms | 0.063 |
| p50 latency ms | 0.345 |
| p75 latency ms | 0.465 |
| p90 latency ms | 0.653 |
| p95 latency ms | 0.922 |
| p99 latency ms | 1.931 |
| p99.9 latency ms | 4.415 |
| Max latency ms | 84.563 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 41586 | 0 | 0.00 | 0.075 | 0.469 | 0.381 | 1.022 | 2.101 | 4.595 | 84.563 |
| POST /api/users | 41586 | 0 | 0.00 | 0.063 | 0.386 | 0.317 | 0.799 | 1.774 | 3.969 | 11.282 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
