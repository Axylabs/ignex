# Ignus HTTP comparison report — ignus / 06-edge-cases

Generated: 2026-08-14T07:38:50.525Z

Failure trace: `06-edge-cases.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 06-edge-cases |
| Generated | 2026-08-14T07:38:50.525Z |
| Total duration ms | 30050.232 |
| Achieved RPS | 20.03 |
| Total requests | 602 |
| Successful requests | 188 |
| Expected error responses | 414 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.821 |
| Min latency ms | 0.241 |
| p50 latency ms | 0.705 |
| p75 latency ms | 0.838 |
| p90 latency ms | 0.974 |
| p95 latency ms | 1.086 |
| p99 latency ms | 2.147 |
| p99.9 latency ms | 43.817 |
| Max latency ms | 43.817 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 50 | 0 | 0.00 | 0.348 | 0.833 | 0.886 | 1.209 | 1.236 | 1.236 | 1.236 |
| GET /api/users | 58 | 0 | 0.00 | 0.351 | 0.781 | 0.806 | 1.167 | 2.173 | 2.173 | 2.173 |
| POST /api/users | 351 | 305 | 86.89 | 0.247 | 0.782 | 0.711 | 1.039 | 2.249 | 24.104 | 24.104 |
| DELETE /api/users | 34 | 34 | 100.00 | 0.255 | 1.901 | 0.679 | 0.992 | 43.817 | 43.817 | 43.817 |
| GET /api/nonexistent | 75 | 75 | 100.00 | 0.250 | 0.629 | 0.637 | 0.943 | 1.683 | 1.683 | 1.683 |
| HEAD /health | 34 | 0 | 0.00 | 0.241 | 0.626 | 0.610 | 0.902 | 2.147 | 2.147 | 2.147 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
