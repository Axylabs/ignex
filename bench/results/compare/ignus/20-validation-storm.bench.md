# Ignus HTTP comparison report — ignus / 20-validation-storm

Generated: 2026-08-14T00:40:22.450Z

Failure trace: `20-validation-storm.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 20-validation-storm |
| Generated | 2026-08-14T00:40:22.450Z |
| Total duration ms | 50014.221 |
| Achieved RPS | 537.79 |
| Total requests | 26897 |
| Successful requests | 24231 |
| Expected error responses | 2666 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.524 |
| Min latency ms | 0.091 |
| p50 latency ms | 0.424 |
| p75 latency ms | 0.561 |
| p90 latency ms | 0.812 |
| p95 latency ms | 1.014 |
| p99 latency ms | 1.191 |
| p99.9 latency ms | 12.161 |
| Max latency ms | 168.465 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 5229 | 0 | 0.00 | 0.131 | 0.538 | 0.439 | 1.053 | 1.216 | 4.583 | 29.379 |
| PATCH /api/users | 5445 | 0 | 0.00 | 0.122 | 0.552 | 0.432 | 1.035 | 1.206 | 4.284 | 168.465 |
| POST /api/users | 9463 | 2666 | 28.17 | 0.101 | 0.530 | 0.428 | 1.032 | 1.194 | 13.164 | 25.443 |
| GET /api/users | 4061 | 0 | 0.00 | 0.091 | 0.509 | 0.411 | 0.975 | 1.124 | 13.167 | 25.615 |
| OPTIONS /api/users | 2699 | 0 | 0.00 | 0.113 | 0.444 | 0.365 | 0.827 | 1.049 | 13.150 | 20.909 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
