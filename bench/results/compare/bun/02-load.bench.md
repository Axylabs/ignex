# Ignus HTTP comparison report — bun / 02-load

Generated: 2026-08-14T07:23:06.136Z

Failure trace: `02-load.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 02-load |
| Generated | 2026-08-14T07:23:06.136Z |
| Total duration ms | 120504.149 |
| Achieved RPS | 211.44 |
| Total requests | 25479 |
| Successful requests | 25479 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.527 |
| Min latency ms | 0.046 |
| p50 latency ms | 0.546 |
| p75 latency ms | 0.694 |
| p90 latency ms | 0.798 |
| p95 latency ms | 0.847 |
| p99 latency ms | 0.945 |
| p99.9 latency ms | 2.142 |
| Max latency ms | 35.368 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 10473 | 0 | 0.00 | 0.052 | 0.565 | 0.611 | 0.858 | 0.959 | 2.293 | 35.368 |
| GET /api/cookies | 1517 | 0 | 0.00 | 0.074 | 0.553 | 0.601 | 0.847 | 0.939 | 2.071 | 6.629 |
| POST /api/users | 10473 | 0 | 0.00 | 0.060 | 0.489 | 0.489 | 0.842 | 0.950 | 2.152 | 5.170 |
| GET /health | 3016 | 0 | 0.00 | 0.046 | 0.511 | 0.552 | 0.797 | 0.878 | 1.574 | 2.193 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
