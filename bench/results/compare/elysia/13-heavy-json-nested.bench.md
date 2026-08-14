# Ignus HTTP comparison report — elysia / 13-heavy-json-nested

Generated: 2026-08-14T00:22:06.274Z

Failure trace: `13-heavy-json-nested.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 13-heavy-json-nested |
| Generated | 2026-08-14T00:22:06.274Z |
| Total duration ms | 60043.310 |
| Achieved RPS | 125.01 |
| Total requests | 7506 |
| Successful requests | 6729 |
| Expected error responses | 777 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.131 |
| Min latency ms | 0.170 |
| p50 latency ms | 0.979 |
| p75 latency ms | 1.075 |
| p90 latency ms | 1.162 |
| p95 latency ms | 1.228 |
| p99 latency ms | 1.589 |
| p99.9 latency ms | 24.101 |
| Max latency ms | 129.727 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 7506 | 777 | 10.35 | 0.170 | 1.131 | 0.979 | 1.228 | 1.589 | 24.101 | 129.727 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
