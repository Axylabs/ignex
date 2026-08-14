# Ignus HTTP comparison report — bun / 07-cors-preflight

Generated: 2026-08-14T00:12:34.280Z

Failure trace: `07-cors-preflight.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 07-cors-preflight |
| Generated | 2026-08-14T00:12:34.280Z |
| Total duration ms | 30009.724 |
| Achieved RPS | 100.03 |
| Total requests | 3002 |
| Successful requests | 2411 |
| Expected error responses | 591 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.761 |
| Min latency ms | 0.129 |
| p50 latency ms | 0.767 |
| p75 latency ms | 0.871 |
| p90 latency ms | 0.966 |
| p95 latency ms | 1.022 |
| p99 latency ms | 1.152 |
| p99.9 latency ms | 2.305 |
| Max latency ms | 22.094 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 569 | 0 | 0.00 | 0.199 | 0.882 | 0.919 | 1.119 | 1.228 | 2.052 | 2.052 |
| OPTIONS /api/users | 2433 | 591 | 24.29 | 0.129 | 0.733 | 0.740 | 0.950 | 1.057 | 2.524 | 22.094 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
