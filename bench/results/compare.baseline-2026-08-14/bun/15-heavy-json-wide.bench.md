# Ignus HTTP comparison report — bun / 15-heavy-json-wide

Generated: 2026-08-14T00:26:26.621Z

Failure trace: `15-heavy-json-wide.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 15-heavy-json-wide |
| Generated | 2026-08-14T00:26:26.621Z |
| Total duration ms | 50055.069 |
| Achieved RPS | 106.00 |
| Total requests | 5306 |
| Successful requests | 2085 |
| Expected error responses | 3221 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.043 |
| Min latency ms | 0.214 |
| p50 latency ms | 0.947 |
| p75 latency ms | 1.023 |
| p90 latency ms | 1.081 |
| p95 latency ms | 1.120 |
| p99 latency ms | 1.371 |
| p99.9 latency ms | 24.632 |
| Max latency ms | 86.658 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 4765 | 3221 | 67.60 | 0.258 | 1.023 | 0.952 | 1.122 | 1.355 | 18.313 | 86.475 |
| POST /api/echo | 541 | 0 | 0.00 | 0.214 | 1.222 | 0.909 | 1.077 | 1.627 | 86.658 | 86.658 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
