# Ignus HTTP comparison report — bun / 06-edge-cases

Generated: 2026-08-14T00:11:04.160Z

Failure trace: `06-edge-cases.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 06-edge-cases |
| Generated | 2026-08-14T00:11:04.160Z |
| Total duration ms | 30050.120 |
| Achieved RPS | 20.03 |
| Total requests | 602 |
| Successful requests | 222 |
| Expected error responses | 380 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.942 |
| Min latency ms | 0.284 |
| p50 latency ms | 0.957 |
| p75 latency ms | 1.052 |
| p90 latency ms | 1.151 |
| p95 latency ms | 1.223 |
| p99 latency ms | 1.328 |
| p99.9 latency ms | 1.466 |
| Max latency ms | 1.466 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 64 | 0 | 0.00 | 0.332 | 1.085 | 1.097 | 1.325 | 1.466 | 1.466 | 1.466 |
| POST /api/users | 361 | 298 | 82.55 | 0.376 | 0.944 | 0.957 | 1.210 | 1.322 | 1.442 | 1.442 |
| GET /api/cookies | 69 | 0 | 0.00 | 0.396 | 0.951 | 0.981 | 1.188 | 1.438 | 1.438 | 1.438 |
| HEAD /health | 26 | 0 | 0.00 | 0.550 | 0.873 | 0.951 | 1.140 | 1.318 | 1.318 | 1.318 |
| DELETE /api/users | 22 | 22 | 100.00 | 0.508 | 0.892 | 0.935 | 1.075 | 1.114 | 1.114 | 1.114 |
| GET /api/nonexistent | 60 | 60 | 100.00 | 0.284 | 0.818 | 0.848 | 1.062 | 1.163 | 1.163 | 1.163 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
