# Ignus HTTP comparison report — ignus-aot / 17-json-validation-spike

Generated: 2026-08-14T08:43:16.831Z

Failure trace: `17-json-validation-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 17-json-validation-spike |
| Generated | 2026-08-14T08:43:16.831Z |
| Total duration ms | 65058.499 |
| Achieved RPS | 426.71 |
| Total requests | 27761 |
| Successful requests | 27761 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.240 |
| Min latency ms | 0.043 |
| p50 latency ms | 0.159 |
| p75 latency ms | 0.235 |
| p90 latency ms | 0.616 |
| p95 latency ms | 0.878 |
| p99 latency ms | 1.021 |
| p99.9 latency ms | 1.499 |
| Max latency ms | 42.476 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 14014 | 0 | 0.00 | 0.054 | 0.249 | 0.165 | 0.924 | 1.048 | 1.505 | 2.727 |
| GET /api/users | 8227 | 0 | 0.00 | 0.047 | 0.236 | 0.151 | 0.838 | 0.969 | 1.490 | 42.476 |
| GET /health | 5520 | 0 | 0.00 | 0.043 | 0.224 | 0.152 | 0.806 | 0.942 | 1.478 | 3.477 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
