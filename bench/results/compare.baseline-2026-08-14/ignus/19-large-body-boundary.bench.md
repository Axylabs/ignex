# Ignus HTTP comparison report — ignus / 19-large-body-boundary

Generated: 2026-08-14T00:37:52.310Z

Failure trace: `19-large-body-boundary.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 19-large-body-boundary |
| Generated | 2026-08-14T00:37:52.310Z |
| Total duration ms | 30050.617 |
| Achieved RPS | 20.03 |
| Total requests | 602 |
| Successful requests | 602 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 2.014 |
| Min latency ms | 0.448 |
| p50 latency ms | 1.261 |
| p75 latency ms | 1.812 |
| p90 latency ms | 4.137 |
| p95 latency ms | 4.457 |
| p99 latency ms | 5.802 |
| p99.9 latency ms | 109.006 |
| Max latency ms | 109.006 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 469 | 0 | 0.00 | 0.609 | 2.283 | 1.401 | 4.710 | 6.088 | 109.006 | 109.006 |
| POST /api/users | 133 | 0 | 0.00 | 0.448 | 1.065 | 1.073 | 1.248 | 1.812 | 2.486 | 2.486 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
