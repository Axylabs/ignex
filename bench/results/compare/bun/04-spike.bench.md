# Ignus HTTP comparison report — bun / 04-spike

Generated: 2026-08-14T07:33:59.984Z

Failure trace: `04-spike.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | bun |
| Scenario | 04-spike |
| Generated | 2026-08-14T07:33:59.984Z |
| Total duration ms | 100054.253 |
| Achieved RPS | 834.51 |
| Total requests | 83496 |
| Successful requests | 83496 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.146 |
| Min latency ms | 0.036 |
| p50 latency ms | 0.103 |
| p75 latency ms | 0.141 |
| p90 latency ms | 0.215 |
| p95 latency ms | 0.425 |
| p99 latency ms | 0.881 |
| p99.9 latency ms | 1.674 |
| Max latency ms | 19.524 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 41748 | 0 | 0.00 | 0.037 | 0.169 | 0.118 | 0.522 | 0.956 | 1.809 | 15.089 |
| POST /api/users | 41748 | 0 | 0.00 | 0.036 | 0.122 | 0.087 | 0.350 | 0.718 | 1.322 | 19.524 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
