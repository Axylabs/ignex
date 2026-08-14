# Ignus HTTP comparison report — ignus / 16-crud-validation-mix

Generated: 2026-08-14T08:25:44.000Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-14T08:25:44.000Z |
| Total duration ms | 100025.126 |
| Achieved RPS | 259.99 |
| Total requests | 26006 |
| Successful requests | 23447 |
| Expected error responses | 2559 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.475 |
| Min latency ms | 0.070 |
| p50 latency ms | 0.394 |
| p75 latency ms | 0.642 |
| p90 latency ms | 0.797 |
| p95 latency ms | 0.889 |
| p99 latency ms | 1.165 |
| p99.9 latency ms | 4.739 |
| Max latency ms | 34.640 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 3924 | 0 | 0.00 | 0.075 | 0.481 | 0.401 | 0.901 | 1.130 | 3.828 | 27.936 |
| POST /api/users | 9180 | 2559 | 27.88 | 0.070 | 0.476 | 0.393 | 0.895 | 1.238 | 5.472 | 34.640 |
| PATCH /api/users | 2587 | 0 | 0.00 | 0.076 | 0.470 | 0.384 | 0.882 | 1.159 | 9.868 | 13.891 |
| GET /api/users | 10315 | 0 | 0.00 | 0.073 | 0.472 | 0.394 | 0.881 | 1.124 | 4.838 | 30.716 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
