# Ignus HTTP comparison report — ignus / 02-load

Generated: 2026-08-14T09:36:24.574Z

Failure trace: `02-load.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 02-load |
| Generated | 2026-08-14T09:36:24.574Z |
| Total duration ms | 120544.362 |
| Achieved RPS | 211.33 |
| Total requests | 25475 |
| Successful requests | 25475 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.628 |
| Min latency ms | 0.060 |
| p50 latency ms | 0.625 |
| p75 latency ms | 0.785 |
| p90 latency ms | 0.890 |
| p95 latency ms | 0.940 |
| p99 latency ms | 1.089 |
| p99.9 latency ms | 6.710 |
| Max latency ms | 52.935 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/cookies | 1493 | 0 | 0.00 | 0.122 | 0.687 | 0.751 | 1.000 | 1.208 | 2.049 | 2.429 |
| GET /api/users | 10469 | 0 | 0.00 | 0.077 | 0.683 | 0.700 | 0.945 | 1.150 | 14.393 | 52.935 |
| POST /api/users | 10469 | 0 | 0.00 | 0.060 | 0.574 | 0.557 | 0.927 | 1.042 | 3.831 | 38.590 |
| GET /health | 3044 | 0 | 0.00 | 0.060 | 0.594 | 0.610 | 0.878 | 1.005 | 3.026 | 23.180 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
