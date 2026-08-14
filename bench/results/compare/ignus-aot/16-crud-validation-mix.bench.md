# Ignus HTTP comparison report — ignus-aot / 16-crud-validation-mix

Generated: 2026-08-14T08:42:11.749Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-14T08:42:11.749Z |
| Total duration ms | 100022.240 |
| Achieved RPS | 260.02 |
| Total requests | 26008 |
| Successful requests | 23388 |
| Expected error responses | 2620 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.695 |
| Min latency ms | 0.066 |
| p50 latency ms | 0.724 |
| p75 latency ms | 0.863 |
| p90 latency ms | 0.949 |
| p95 latency ms | 0.990 |
| p99 latency ms | 1.099 |
| p99.9 latency ms | 2.239 |
| Max latency ms | 32.890 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 3847 | 0 | 0.00 | 0.088 | 0.724 | 0.753 | 1.011 | 1.115 | 2.130 | 32.890 |
| PATCH /api/users | 2538 | 0 | 0.00 | 0.084 | 0.703 | 0.734 | 1.007 | 1.108 | 2.273 | 2.499 |
| POST /api/users | 9125 | 2620 | 28.71 | 0.066 | 0.689 | 0.718 | 0.989 | 1.091 | 2.183 | 4.307 |
| GET /api/users | 10498 | 0 | 0.00 | 0.070 | 0.688 | 0.718 | 0.976 | 1.095 | 2.366 | 4.359 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
