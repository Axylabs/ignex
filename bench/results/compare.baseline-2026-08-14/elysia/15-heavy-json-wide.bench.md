# Ignus HTTP comparison report — elysia / 15-heavy-json-wide

Generated: 2026-08-14T00:27:16.684Z

Failure trace: `15-heavy-json-wide.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 15-heavy-json-wide |
| Generated | 2026-08-14T00:27:16.684Z |
| Total duration ms | 50055.725 |
| Achieved RPS | 106.00 |
| Total requests | 5306 |
| Successful requests | 5306 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.123 |
| Min latency ms | 0.226 |
| p50 latency ms | 1.025 |
| p75 latency ms | 1.110 |
| p90 latency ms | 1.194 |
| p95 latency ms | 1.284 |
| p99 latency ms | 2.408 |
| p99.9 latency ms | 32.273 |
| Max latency ms | 42.691 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 532 | 0 | 0.00 | 0.499 | 1.267 | 1.160 | 1.636 | 3.071 | 30.418 | 30.418 |
| POST /api/users | 4774 | 0 | 0.00 | 0.226 | 1.107 | 1.015 | 1.209 | 2.156 | 32.385 | 42.691 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
