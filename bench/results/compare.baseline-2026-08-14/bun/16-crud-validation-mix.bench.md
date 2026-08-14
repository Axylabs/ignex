# Ignus HTTP comparison report — bun / 16-crud-validation-mix

Generated: 2026-08-14T00:29:46.799Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-14T00:29:46.799Z |
| Total duration ms | 100021.832 |
| Achieved RPS | 260.02 |
| Total requests | 26008 |
| Successful requests | 23372 |
| Expected error responses | 2636 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.723 |
| Min latency ms | 0.144 |
| p50 latency ms | 0.685 |
| p75 latency ms | 0.862 |
| p90 latency ms | 0.959 |
| p95 latency ms | 1.010 |
| p99 latency ms | 1.133 |
| p99.9 latency ms | 9.937 |
| Max latency ms | 166.473 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 3906 | 0 | 0.00 | 0.160 | 0.738 | 0.710 | 1.033 | 1.198 | 10.106 | 10.652 |
| PATCH /api/users | 2608 | 0 | 0.00 | 0.166 | 0.785 | 0.698 | 1.018 | 1.138 | 9.776 | 163.206 |
| POST /api/users | 9148 | 2636 | 28.82 | 0.154 | 0.734 | 0.690 | 1.013 | 1.144 | 10.118 | 166.473 |
| GET /api/users | 10346 | 0 | 0.00 | 0.144 | 0.691 | 0.670 | 0.995 | 1.108 | 9.427 | 10.587 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
