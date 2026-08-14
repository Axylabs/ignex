# Ignus HTTP comparison report — elysia / 09-large-payload

Generated: 2026-08-14T00:14:34.455Z

Failure trace: `09-large-payload.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | elysia |
| Scenario | 09-large-payload |
| Generated | 2026-08-14T00:14:34.455Z |
| Total duration ms | 30029.391 |
| Achieved RPS | 10.02 |
| Total requests | 301 |
| Successful requests | 301 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 5.566 |
| Min latency ms | 0.731 |
| p50 latency ms | 4.260 |
| p75 latency ms | 6.185 |
| p90 latency ms | 13.959 |
| p95 latency ms | 15.710 |
| p99 latency ms | 17.445 |
| p99.9 latency ms | 20.207 |
| Max latency ms | 20.207 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/echo | 301 | 0 | 0.00 | 0.731 | 5.566 | 4.260 | 15.710 | 17.445 | 20.207 | 20.207 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
