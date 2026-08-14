# Ignus HTTP comparison report — ignus / 11-concurrent-burst

Generated: 2026-08-14T00:20:05.527Z

Failure trace: `11-concurrent-burst.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 11-concurrent-burst |
| Generated | 2026-08-14T00:20:05.527Z |
| Total duration ms | 35199.605 |
| Achieved RPS | 848.05 |
| Total requests | 29851 |
| Successful requests | 29851 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.615 |
| Min latency ms | 0.095 |
| p50 latency ms | 0.512 |
| p75 latency ms | 0.597 |
| p90 latency ms | 0.693 |
| p95 latency ms | 0.784 |
| p99 latency ms | 2.060 |
| p99.9 latency ms | 19.014 |
| Max latency ms | 135.355 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 11876 | 0 | 0.00 | 0.095 | 0.614 | 0.539 | 0.797 | 2.096 | 16.852 | 135.353 |
| GET /api/users | 17975 | 0 | 0.00 | 0.108 | 0.616 | 0.498 | 0.774 | 2.038 | 26.550 | 135.355 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
