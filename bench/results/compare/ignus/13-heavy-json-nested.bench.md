# Ignus HTTP comparison report — ignus / 13-heavy-json-nested

Generated: 2026-08-14T00:23:06.330Z

Failure trace: `13-heavy-json-nested.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 13-heavy-json-nested |
| Generated | 2026-08-14T00:23:06.330Z |
| Total duration ms | 60044.083 |
| Achieved RPS | 125.01 |
| Total requests | 7506 |
| Successful requests | 6763 |
| Expected error responses | 743 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.003 |
| Min latency ms | 0.204 |
| p50 latency ms | 1.004 |
| p75 latency ms | 1.099 |
| p90 latency ms | 1.175 |
| p95 latency ms | 1.223 |
| p99 latency ms | 1.636 |
| p99.9 latency ms | 5.589 |
| Max latency ms | 86.171 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 7506 | 743 | 9.90 | 0.204 | 1.003 | 1.004 | 1.223 | 1.636 | 5.589 | 86.171 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
