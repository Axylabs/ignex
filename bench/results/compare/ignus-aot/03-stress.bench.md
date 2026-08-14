# Ignus HTTP comparison report — ignus-aot / 03-stress

Generated: 2026-08-14T08:33:01.008Z

Failure trace: `03-stress.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 03-stress |
| Generated | 2026-08-14T08:33:01.008Z |
| Total duration ms | 103847.148 |
| Achieved RPS | 923.15 |
| Total requests | 95866 |
| Successful requests | 95866 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 2371.899 |
| Min latency ms | 0.043 |
| p50 latency ms | 0.192 |
| p75 latency ms | 2.414 |
| p90 latency ms | 12052.417 |
| p95 latency ms | 16293.771 |
| p99 latency ms | 17468.923 |
| p99.9 latency ms | 17530.090 |
| Max latency ms | 17589.210 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 47924 | 0 | 0.00 | 0.047 | 2377.301 | 0.189 | 16300.826 | 17474.087 | 17532.538 | 17589.210 |
| POST /api/users | 28892 | 0 | 0.00 | 0.051 | 2387.513 | 0.206 | 16295.105 | 17461.317 | 17529.956 | 17588.950 |
| GET /health | 19050 | 0 | 0.00 | 0.043 | 2334.626 | 0.180 | 16268.086 | 17466.751 | 17530.003 | 17586.875 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
