# Ignus HTTP comparison report — ignus / 03-stress

Generated: 2026-08-14T00:05:33.488Z

Failure trace: `03-stress.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 03-stress |
| Generated | 2026-08-14T00:05:33.488Z |
| Total duration ms | 106251.386 |
| Achieved RPS | 875.03 |
| Total requests | 92973 |
| Successful requests | 92973 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 2617.848 |
| Min latency ms | 0.086 |
| p50 latency ms | 0.542 |
| p75 latency ms | 0.967 |
| p90 latency ms | 13938.057 |
| p95 latency ms | 18948.459 |
| p99 latency ms | 20102.622 |
| p99.9 latency ms | 20257.876 |
| Max latency ms | 20263.541 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 27907 | 0 | 0.00 | 0.136 | 2643.424 | 0.580 | 19171.424 | 20114.022 | 20257.283 | 20263.537 |
| GET /health | 18682 | 0 | 0.00 | 0.086 | 2652.922 | 0.512 | 18940.798 | 20119.291 | 20260.865 | 20263.519 |
| GET /api/users | 46384 | 0 | 0.00 | 0.091 | 2588.334 | 0.531 | 18735.423 | 20083.259 | 20257.771 | 20263.541 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
