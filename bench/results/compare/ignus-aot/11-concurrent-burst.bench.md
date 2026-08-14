# Ignus HTTP comparison report — ignus-aot / 11-concurrent-burst

Generated: 2026-08-14T08:37:51.507Z

Failure trace: `11-concurrent-burst.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 11-concurrent-burst |
| Generated | 2026-08-14T08:37:51.507Z |
| Total duration ms | 35201.076 |
| Achieved RPS | 855.54 |
| Total requests | 30116 |
| Successful requests | 30116 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.203 |
| Min latency ms | 0.045 |
| p50 latency ms | 0.148 |
| p75 latency ms | 0.218 |
| p90 latency ms | 0.258 |
| p95 latency ms | 0.308 |
| p99 latency ms | 0.987 |
| p99.9 latency ms | 5.358 |
| Max latency ms | 33.843 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 12002 | 0 | 0.00 | 0.051 | 0.207 | 0.154 | 0.317 | 1.018 | 4.892 | 33.843 |
| GET /api/users | 18114 | 0 | 0.00 | 0.045 | 0.201 | 0.145 | 0.299 | 0.972 | 5.549 | 33.793 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
