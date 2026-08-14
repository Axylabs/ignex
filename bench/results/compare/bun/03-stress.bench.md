# Ignus HTTP comparison report — bun / 03-stress

Generated: 2026-08-14T07:28:52.012Z

Failure trace: `03-stress.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 03-stress |
| Generated | 2026-08-14T07:28:52.012Z |
| Total duration ms | 104703.614 |
| Achieved RPS | 902.26 |
| Total requests | 94470 |
| Successful requests | 94470 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 2482.585 |
| Min latency ms | 0.036 |
| p50 latency ms | 0.191 |
| p75 latency ms | 0.644 |
| p90 latency ms | 12791.688 |
| p95 latency ms | 17787.841 |
| p99 latency ms | 19175.819 |
| p99.9 latency ms | 19302.353 |
| Max latency ms | 19307.872 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /health | 18887 | 0 | 0.00 | 0.036 | 2506.699 | 0.180 | 17895.012 | 19175.827 | 19303.073 | 19307.798 |
| GET /api/users | 47431 | 0 | 0.00 | 0.040 | 2479.636 | 0.190 | 17811.482 | 19175.358 | 19301.501 | 19307.813 |
| POST /api/users | 28152 | 0 | 0.00 | 0.042 | 2471.375 | 0.200 | 17625.058 | 19177.367 | 19303.812 | 19307.872 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
