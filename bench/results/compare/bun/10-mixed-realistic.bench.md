# Ignus HTTP comparison report — bun / 10-mixed-realistic

Generated: 2026-08-14T00:16:09.668Z

Failure trace: `10-mixed-realistic.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 10-mixed-realistic |
| Generated | 2026-08-14T00:16:09.668Z |
| Total duration ms | 65050.629 |
| Achieved RPS | 632.54 |
| Total requests | 41147 |
| Successful requests | 41147 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.567 |
| Min latency ms | 0.057 |
| p50 latency ms | 0.481 |
| p75 latency ms | 0.621 |
| p90 latency ms | 0.798 |
| p95 latency ms | 0.883 |
| p99 latency ms | 1.045 |
| p99.9 latency ms | 30.576 |
| Max latency ms | 177.749 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 8308 | 0 | 0.00 | 0.111 | 0.655 | 0.562 | 0.955 | 1.098 | 27.559 | 31.006 |
| GET /health | 5951 | 0 | 0.00 | 0.108 | 0.713 | 0.552 | 0.887 | 1.178 | 32.120 | 177.682 |
| GET /api/users | 26888 | 0 | 0.00 | 0.057 | 0.507 | 0.437 | 0.846 | 1.000 | 27.731 | 177.749 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
