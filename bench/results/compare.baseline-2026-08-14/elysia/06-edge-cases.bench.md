# Ignus HTTP comparison report — elysia / 06-edge-cases

Generated: 2026-08-14T00:11:34.214Z

Failure trace: `06-edge-cases.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 06-edge-cases |
| Generated | 2026-08-14T00:11:34.214Z |
| Total duration ms | 30050.964 |
| Achieved RPS | 20.03 |
| Total requests | 602 |
| Successful requests | 266 |
| Expected error responses | 336 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.528 |
| Min latency ms | 0.347 |
| p50 latency ms | 1.113 |
| p75 latency ms | 1.266 |
| p90 latency ms | 1.424 |
| p95 latency ms | 1.516 |
| p99 latency ms | 3.341 |
| p99.9 latency ms | 161.302 |
| Max latency ms | 161.302 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 59 | 0 | 0.00 | 0.690 | 1.423 | 1.231 | 1.598 | 13.327 | 13.327 | 13.327 |
| POST /api/users | 366 | 245 | 66.94 | 0.617 | 1.796 | 1.157 | 1.548 | 5.995 | 161.302 | 161.302 |
| GET /api/users | 56 | 0 | 0.00 | 0.629 | 1.164 | 1.151 | 1.414 | 3.152 | 3.152 | 3.152 |
| DELETE /api/users | 33 | 33 | 100.00 | 0.454 | 0.931 | 0.926 | 1.243 | 1.326 | 1.326 | 1.326 |
| GET /api/nonexistent | 58 | 58 | 100.00 | 0.570 | 0.931 | 0.950 | 1.196 | 1.577 | 1.577 | 1.577 |
| HEAD /health | 30 | 0 | 0.00 | 0.347 | 0.947 | 1.003 | 1.151 | 1.273 | 1.273 | 1.273 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
