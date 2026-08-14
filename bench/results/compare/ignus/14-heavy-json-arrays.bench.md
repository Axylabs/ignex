# Ignus HTTP comparison report — ignus / 14-heavy-json-arrays

Generated: 2026-08-14T01:06:02.339Z

Failure trace: `14-heavy-json-arrays.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 14-heavy-json-arrays |
| Generated | 2026-08-14T01:06:02.339Z |
| Total duration ms | 50079.155 |
| Achieved RPS | 72.01 |
| Total requests | 3606 |
| Successful requests | 2855 |
| Expected error responses | 751 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.195 |
| Min latency ms | 0.353 |
| p50 latency ms | 1.019 |
| p75 latency ms | 1.138 |
| p90 latency ms | 1.283 |
| p95 latency ms | 1.492 |
| p99 latency ms | 3.033 |
| p99.9 latency ms | 87.622 |
| Max latency ms | 87.820 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 1050 | 0 | 0.00 | 0.353 | 1.291 | 1.110 | 2.322 | 4.906 | 14.032 | 45.640 |
| POST /api/users | 2556 | 751 | 29.38 | 0.394 | 1.156 | 0.995 | 1.247 | 2.111 | 87.678 | 87.820 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
