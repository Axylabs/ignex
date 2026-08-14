# Ignus HTTP comparison report — ignus-aot / 04-spike

Generated: 2026-08-14T08:34:41.150Z

Failure trace: `04-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 04-spike |
| Generated | 2026-08-14T08:34:41.150Z |
| Total duration ms | 100103.186 |
| Achieved RPS | 833.30 |
| Total requests | 83416 |
| Successful requests | 83416 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.183 |
| Min latency ms | 0.043 |
| p50 latency ms | 0.128 |
| p75 latency ms | 0.180 |
| p90 latency ms | 0.264 |
| p95 latency ms | 0.561 |
| p99 latency ms | 1.017 |
| p99.9 latency ms | 1.929 |
| Max latency ms | 36.575 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 41708 | 0 | 0.00 | 0.043 | 0.202 | 0.135 | 0.703 | 1.080 | 1.954 | 36.575 |
| POST /api/users | 41708 | 0 | 0.00 | 0.044 | 0.165 | 0.120 | 0.506 | 0.888 | 1.845 | 5.603 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
