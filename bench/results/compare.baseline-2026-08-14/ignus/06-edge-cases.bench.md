# Ignus HTTP comparison report — ignus / 06-edge-cases

Generated: 2026-08-14T00:12:04.267Z

Failure trace: `06-edge-cases.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 06-edge-cases |
| Generated | 2026-08-14T00:12:04.267Z |
| Total duration ms | 30049.987 |
| Achieved RPS | 20.03 |
| Total requests | 602 |
| Successful requests | 209 |
| Expected error responses | 393 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.184 |
| Min latency ms | 0.275 |
| p50 latency ms | 1.070 |
| p75 latency ms | 1.184 |
| p90 latency ms | 1.302 |
| p95 latency ms | 1.401 |
| p99 latency ms | 1.747 |
| p99.9 latency ms | 35.880 |
| Max latency ms | 35.880 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 57 | 0 | 0.00 | 0.751 | 1.214 | 1.246 | 1.492 | 1.574 | 1.574 | 1.574 |
| GET /api/users | 60 | 0 | 0.00 | 0.577 | 1.157 | 1.159 | 1.433 | 1.526 | 1.526 | 1.526 |
| POST /api/users | 365 | 302 | 82.74 | 0.304 | 1.206 | 1.070 | 1.345 | 2.026 | 35.880 | 35.880 |
| DELETE /api/users | 30 | 30 | 100.00 | 0.275 | 1.006 | 1.017 | 1.227 | 1.252 | 1.252 | 1.252 |
| GET /api/nonexistent | 61 | 61 | 100.00 | 0.340 | 1.260 | 0.988 | 1.165 | 21.108 | 21.108 | 21.108 |
| HEAD /health | 29 | 0 | 0.00 | 0.435 | 0.923 | 0.989 | 1.138 | 1.257 | 1.257 | 1.257 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
