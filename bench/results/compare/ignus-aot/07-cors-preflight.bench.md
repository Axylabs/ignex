# Ignus HTTP comparison report — ignus-aot / 07-cors-preflight

Generated: 2026-08-14T08:35:41.215Z

Failure trace: `07-cors-preflight.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 07-cors-preflight |
| Generated | 2026-08-14T08:35:41.215Z |
| Total duration ms | 30009.977 |
| Achieved RPS | 100.03 |
| Total requests | 3002 |
| Successful requests | 3002 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.739 |
| Min latency ms | 0.171 |
| p50 latency ms | 0.724 |
| p75 latency ms | 0.814 |
| p90 latency ms | 0.919 |
| p95 latency ms | 0.992 |
| p99 latency ms | 1.107 |
| p99.9 latency ms | 1.965 |
| Max latency ms | 39.208 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 565 | 0 | 0.00 | 0.210 | 0.885 | 0.903 | 1.072 | 1.162 | 2.116 | 2.116 |
| OPTIONS /api/users | 2437 | 0 | 0.00 | 0.171 | 0.705 | 0.699 | 0.860 | 1.017 | 1.965 | 39.208 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
