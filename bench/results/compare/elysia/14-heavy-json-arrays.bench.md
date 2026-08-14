# Ignus HTTP comparison report — elysia / 14-heavy-json-arrays

Generated: 2026-08-14T01:05:12.254Z

Failure trace: `14-heavy-json-arrays.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 14-heavy-json-arrays |
| Generated | 2026-08-14T01:05:12.254Z |
| Total duration ms | 50049.382 |
| Achieved RPS | 72.01 |
| Total requests | 3604 |
| Successful requests | 2902 |
| Expected error responses | 702 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 1.309 |
| Min latency ms | 0.355 |
| p50 latency ms | 1.098 |
| p75 latency ms | 1.276 |
| p90 latency ms | 1.561 |
| p95 latency ms | 2.109 |
| p99 latency ms | 4.624 |
| p99.9 latency ms | 20.783 |
| Max latency ms | 176.396 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 1108 | 0 | 0.00 | 0.730 | 1.742 | 1.330 | 2.998 | 5.409 | 22.569 | 176.396 |
| POST /api/users | 2496 | 702 | 28.13 | 0.355 | 1.117 | 1.038 | 1.419 | 2.774 | 19.056 | 22.285 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
