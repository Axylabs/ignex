# Ignus HTTP comparison report — bun / 06-edge-cases

Generated: 2026-08-14T07:37:50.419Z

Failure trace: `06-edge-cases.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 06-edge-cases |
| Generated | 2026-08-14T07:37:50.419Z |
| Total duration ms | 30050.466 |
| Achieved RPS | 20.03 |
| Total requests | 602 |
| Successful requests | 198 |
| Expected error responses | 404 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.653 |
| Min latency ms | 0.230 |
| p50 latency ms | 0.622 |
| p75 latency ms | 0.731 |
| p90 latency ms | 0.849 |
| p95 latency ms | 0.955 |
| p99 latency ms | 1.399 |
| p99.9 latency ms | 11.322 |
| Max latency ms | 11.322 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HEAD /health | 27 | 0 | 0.00 | 0.243 | 0.682 | 0.596 | 1.052 | 3.272 | 3.272 | 3.272 |
| GET /api/users | 60 | 0 | 0.00 | 0.333 | 0.743 | 0.776 | 1.004 | 1.062 | 1.062 | 1.062 |
| GET /api/cookies | 46 | 0 | 0.00 | 0.292 | 0.629 | 0.686 | 0.941 | 0.955 | 0.955 | 0.955 |
| POST /api/users | 366 | 301 | 82.24 | 0.230 | 0.669 | 0.629 | 0.910 | 1.611 | 11.322 | 11.322 |
| DELETE /api/users | 40 | 40 | 100.00 | 0.347 | 0.582 | 0.589 | 0.800 | 0.865 | 0.865 | 0.865 |
| GET /api/nonexistent | 63 | 63 | 100.00 | 0.273 | 0.528 | 0.538 | 0.709 | 1.035 | 1.035 | 1.035 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
