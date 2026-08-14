# Ignus HTTP comparison report — ignus / 09-large-payload

Generated: 2026-08-14T00:15:04.570Z

Failure trace: `09-large-payload.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 09-large-payload |
| Generated | 2026-08-14T00:15:04.570Z |
| Total duration ms | 30113.126 |
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
| Avg latency ms | 4.909 |
| Min latency ms | 0.719 |
| p50 latency ms | 3.367 |
| p75 latency ms | 4.389 |
| p90 latency ms | 14.947 |
| p95 latency ms | 15.575 |
| p99 latency ms | 17.281 |
| p99.9 latency ms | 31.559 |
| Max latency ms | 31.559 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 302 | 0 | 0.00 | 0.719 | 4.909 | 3.367 | 15.575 | 17.281 | 31.559 | 31.559 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
