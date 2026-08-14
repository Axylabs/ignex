# Ignus HTTP comparison report — ignus / 15-heavy-json-wide

Generated: 2026-08-14T00:28:06.747Z

Failure trace: `15-heavy-json-wide.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 15-heavy-json-wide |
| Generated | 2026-08-14T00:28:06.747Z |
| Total duration ms | 50055.607 |
| Achieved RPS | 106.00 |
| Total requests | 5306 |
| Successful requests | 2117 |
| Expected error responses | 3189 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.068 |
| Min latency ms | 0.337 |
| p50 latency ms | 1.051 |
| p75 latency ms | 1.135 |
| p90 latency ms | 1.202 |
| p95 latency ms | 1.243 |
| p99 latency ms | 1.613 |
| p99.9 latency ms | 5.794 |
| Max latency ms | 126.857 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 4782 | 3189 | 66.69 | 0.345 | 1.081 | 1.061 | 1.248 | 1.688 | 5.878 | 126.857 |
| POST /api/echo | 524 | 0 | 0.00 | 0.337 | 0.958 | 0.984 | 1.176 | 1.458 | 4.967 | 4.967 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
