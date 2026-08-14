# Ignus HTTP comparison report — ignus-aot / 13-heavy-json-nested

Generated: 2026-08-14T08:38:51.558Z

Failure trace: `13-heavy-json-nested.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 13-heavy-json-nested |
| Generated | 2026-08-14T08:38:51.558Z |
| Total duration ms | 60042.156 |
| Achieved RPS | 125.01 |
| Total requests | 7506 |
| Successful requests | 6751 |
| Expected error responses | 755 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.868 |
| Min latency ms | 0.101 |
| p50 latency ms | 0.884 |
| p75 latency ms | 0.959 |
| p90 latency ms | 1.015 |
| p95 latency ms | 1.048 |
| p99 latency ms | 1.248 |
| p99.9 latency ms | 2.551 |
| Max latency ms | 45.536 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 7506 | 755 | 10.06 | 0.101 | 0.868 | 0.884 | 1.048 | 1.248 | 2.551 | 45.536 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
