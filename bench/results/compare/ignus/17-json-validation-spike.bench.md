# Ignus HTTP comparison report — ignus / 17-json-validation-spike

Generated: 2026-08-14T00:36:22.177Z

Failure trace: `17-json-validation-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 17-json-validation-spike |
| Generated | 2026-08-14T00:36:22.177Z |
| Total duration ms | 65059.184 |
| Achieved RPS | 426.70 |
| Total requests | 27761 |
| Successful requests | 27761 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.595 |
| Min latency ms | 0.113 |
| p50 latency ms | 0.545 |
| p75 latency ms | 0.657 |
| p90 latency ms | 0.891 |
| p95 latency ms | 1.076 |
| p99 latency ms | 1.550 |
| p99.9 latency ms | 2.954 |
| Max latency ms | 113.405 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 13901 | 0 | 0.00 | 0.114 | 0.626 | 0.573 | 1.127 | 1.603 | 3.002 | 113.405 |
| GET /api/users | 8233 | 0 | 0.00 | 0.113 | 0.568 | 0.520 | 1.026 | 1.354 | 3.141 | 7.199 |
| GET /health | 5627 | 0 | 0.00 | 0.119 | 0.557 | 0.510 | 1.004 | 1.554 | 2.600 | 3.315 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
