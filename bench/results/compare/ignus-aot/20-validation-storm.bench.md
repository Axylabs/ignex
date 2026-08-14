# Ignus HTTP comparison report — ignus-aot / 20-validation-storm

Generated: 2026-08-14T08:44:36.927Z

Failure trace: `20-validation-storm.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus-aot |
| Scenario | 20-validation-storm |
| Generated | 2026-08-14T08:44:36.927Z |
| Total duration ms | 50013.429 |
| Achieved RPS | 539.97 |
| Total requests | 27006 |
| Successful requests | 24302 |
| Expected error responses | 2704 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.296 |
| Min latency ms | 0.046 |
| p50 latency ms | 0.235 |
| p75 latency ms | 0.328 |
| p90 latency ms | 0.643 |
| p95 latency ms | 0.867 |
| p99 latency ms | 0.991 |
| p99.9 latency ms | 1.557 |
| Max latency ms | 43.254 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 5358 | 0 | 0.00 | 0.056 | 0.310 | 0.239 | 0.902 | 1.015 | 1.747 | 33.214 |
| PATCH /api/users | 5418 | 0 | 0.00 | 0.056 | 0.299 | 0.237 | 0.891 | 1.014 | 1.369 | 2.214 |
| POST /api/users | 9515 | 2704 | 28.42 | 0.056 | 0.301 | 0.236 | 0.879 | 0.990 | 1.685 | 43.254 |
| GET /api/users | 4088 | 0 | 0.00 | 0.053 | 0.282 | 0.230 | 0.829 | 0.952 | 1.691 | 3.600 |
| OPTIONS /api/users | 2627 | 0 | 0.00 | 0.046 | 0.262 | 0.224 | 0.716 | 0.854 | 1.207 | 1.424 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
