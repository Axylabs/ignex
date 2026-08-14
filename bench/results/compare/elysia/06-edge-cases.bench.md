# Ignus HTTP comparison report — elysia / 06-edge-cases

Generated: 2026-08-14T07:38:20.471Z

Failure trace: `06-edge-cases.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 06-edge-cases |
| Generated | 2026-08-14T07:38:20.471Z |
| Total duration ms | 30050.109 |
| Achieved RPS | 20.03 |
| Total requests | 602 |
| Successful requests | 291 |
| Expected error responses | 311 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.821 |
| Min latency ms | 0.247 |
| p50 latency ms | 0.765 |
| p75 latency ms | 0.928 |
| p90 latency ms | 1.104 |
| p95 latency ms | 1.197 |
| p99 latency ms | 2.825 |
| p99.9 latency ms | 10.397 |
| Max latency ms | 10.397 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 75 | 0 | 0.00 | 0.372 | 0.958 | 0.898 | 1.416 | 4.637 | 4.637 | 4.637 |
| POST /api/users | 340 | 221 | 65.00 | 0.288 | 0.859 | 0.791 | 1.237 | 3.756 | 10.397 | 10.397 |
| GET /api/users | 70 | 0 | 0.00 | 0.347 | 0.864 | 0.825 | 1.145 | 4.858 | 4.858 | 4.858 |
| DELETE /api/users | 33 | 33 | 100.00 | 0.326 | 0.602 | 0.584 | 0.853 | 0.870 | 0.870 | 0.870 |
| GET /api/nonexistent | 57 | 57 | 100.00 | 0.247 | 0.606 | 0.618 | 0.832 | 2.182 | 2.182 | 2.182 |
| HEAD /health | 27 | 0 | 0.00 | 0.281 | 0.568 | 0.588 | 0.763 | 0.777 | 0.777 | 0.777 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
