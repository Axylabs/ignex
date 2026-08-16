# Ignus HTTP comparison report — ignus / 16-crud-validation-mix

Generated: 2026-08-16T19:41:11.689Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-16T19:41:11.689Z |
| Total duration ms | 100020.834 |
| Achieved RPS | 260.03 |
| Total requests | 26008 |
| Successful requests | 23478 |
| Expected error responses | 2530 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.558 |
| Min latency ms | 0.080 |
| p50 latency ms | 0.451 |
| p75 latency ms | 0.602 |
| p90 latency ms | 0.752 |
| p95 latency ms | 0.863 |
| p99 latency ms | 2.049 |
| p99.9 latency ms | 16.575 |
| Max latency ms | 78.303 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 3961 | 0 | 0.00 | 0.104 | 0.598 | 0.454 | 0.876 | 2.297 | 19.895 | 49.755 |
| POST /api/users | 9111 | 2530 | 27.77 | 0.080 | 0.565 | 0.450 | 0.865 | 2.092 | 16.525 | 74.126 |
| PATCH /api/users | 2615 | 0 | 0.00 | 0.087 | 0.558 | 0.450 | 0.860 | 2.053 | 18.111 | 49.108 |
| GET /api/users | 10321 | 0 | 0.00 | 0.084 | 0.535 | 0.451 | 0.859 | 1.902 | 16.421 | 78.303 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
