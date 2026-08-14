# Ignus HTTP comparison report — ignus / 04-spike

Generated: 2026-08-14T07:37:20.367Z

Failure trace: `04-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 04-spike |
| Generated | 2026-08-14T07:37:20.367Z |
| Total duration ms | 100148.321 |
| Achieved RPS | 833.66 |
| Total requests | 83490 |
| Successful requests | 83490 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.276 |
| Min latency ms | 0.043 |
| p50 latency ms | 0.127 |
| p75 latency ms | 0.178 |
| p90 latency ms | 0.279 |
| p95 latency ms | 0.560 |
| p99 latency ms | 1.734 |
| p99.9 latency ms | 27.379 |
| Max latency ms | 55.225 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 41745 | 0 | 0.00 | 0.044 | 0.295 | 0.135 | 0.674 | 2.178 | 19.239 | 55.225 |
| POST /api/users | 41745 | 0 | 0.00 | 0.043 | 0.257 | 0.116 | 0.496 | 1.410 | 27.417 | 51.786 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
