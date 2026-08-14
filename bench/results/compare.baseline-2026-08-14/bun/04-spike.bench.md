# Ignus HTTP comparison report — bun / 04-spike

Generated: 2026-08-14T00:07:13.654Z

Failure trace: `04-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 04-spike |
| Generated | 2026-08-14T00:07:13.654Z |
| Total duration ms | 100055.262 |
| Achieved RPS | 829.48 |
| Total requests | 82994 |
| Successful requests | 82994 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.412 |
| Min latency ms | 0.057 |
| p50 latency ms | 0.303 |
| p75 latency ms | 0.407 |
| p90 latency ms | 0.563 |
| p95 latency ms | 0.820 |
| p99 latency ms | 2.158 |
| p99.9 latency ms | 9.329 |
| Max latency ms | 112.759 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 41497 | 0 | 0.00 | 0.069 | 0.464 | 0.342 | 0.963 | 2.361 | 9.885 | 112.759 |
| POST /api/users | 41497 | 0 | 0.00 | 0.057 | 0.360 | 0.271 | 0.705 | 1.962 | 9.274 | 27.386 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
