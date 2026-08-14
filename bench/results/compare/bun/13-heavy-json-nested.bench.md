# Ignus HTTP comparison report — bun / 13-heavy-json-nested

Generated: 2026-08-14T00:21:06.218Z

Failure trace: `13-heavy-json-nested.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 13-heavy-json-nested |
| Generated | 2026-08-14T00:21:06.218Z |
| Total duration ms | 60043.977 |
| Achieved RPS | 125.01 |
| Total requests | 7506 |
| Successful requests | 6759 |
| Expected error responses | 747 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.994 |
| Min latency ms | 0.196 |
| p50 latency ms | 0.887 |
| p75 latency ms | 1.008 |
| p90 latency ms | 1.156 |
| p95 latency ms | 1.306 |
| p99 latency ms | 1.513 |
| p99.9 latency ms | 31.983 |
| Max latency ms | 146.217 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 7506 | 747 | 9.95 | 0.196 | 0.994 | 0.887 | 1.306 | 1.513 | 31.983 | 146.217 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
