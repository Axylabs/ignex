# Ignus HTTP comparison report — bun / 09-large-payload

Generated: 2026-08-14T00:14:04.423Z

Failure trace: `09-large-payload.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 09-large-payload |
| Generated | 2026-08-14T00:14:04.423Z |
| Total duration ms | 30112.311 |
| Achieved RPS | 10.03 |
| Total requests | 302 |
| Successful requests | 302 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 4.661 |
| Min latency ms | 0.497 |
| p50 latency ms | 3.359 |
| p75 latency ms | 4.342 |
| p90 latency ms | 13.834 |
| p95 latency ms | 15.896 |
| p99 latency ms | 18.040 |
| p99.9 latency ms | 49.177 |
| Max latency ms | 49.177 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 302 | 0 | 0.00 | 0.497 | 4.661 | 3.359 | 15.896 | 18.040 | 49.177 | 49.177 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
