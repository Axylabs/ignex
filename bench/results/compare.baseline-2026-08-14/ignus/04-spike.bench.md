# Ignus HTTP comparison report — ignus / 04-spike

Generated: 2026-08-14T00:10:34.108Z

Failure trace: `04-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 04-spike |
| Generated | 2026-08-14T00:10:34.108Z |
| Total duration ms | 100149.309 |
| Achieved RPS | 825.17 |
| Total requests | 82640 |
| Successful requests | 82640 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.619 |
| Min latency ms | 0.082 |
| p50 latency ms | 0.420 |
| p75 latency ms | 0.638 |
| p90 latency ms | 1.118 |
| p95 latency ms | 1.641 |
| p99 latency ms | 3.093 |
| p99.9 latency ms | 6.601 |
| Max latency ms | 156.675 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 41320 | 0 | 0.00 | 0.082 | 0.667 | 0.435 | 1.764 | 3.187 | 6.844 | 155.228 |
| POST /api/users | 41320 | 0 | 0.00 | 0.083 | 0.572 | 0.405 | 1.510 | 2.972 | 5.857 | 156.675 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
