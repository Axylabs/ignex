# Ignus HTTP comparison report — ignus / 07-cors-preflight

Generated: 2026-08-14T00:13:34.309Z

Failure trace: `07-cors-preflight.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 07-cors-preflight |
| Generated | 2026-08-14T00:13:34.309Z |
| Total duration ms | 30010.038 |
| Achieved RPS | 100.03 |
| Total requests | 3002 |
| Successful requests | 3002 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.918 |
| Min latency ms | 0.189 |
| p50 latency ms | 0.814 |
| p75 latency ms | 0.926 |
| p90 latency ms | 1.059 |
| p95 latency ms | 1.143 |
| p99 latency ms | 1.841 |
| p99.9 latency ms | 16.047 |
| Max latency ms | 112.221 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /api/users | 585 | 0 | 0.00 | 0.406 | 1.191 | 1.029 | 1.270 | 12.058 | 16.117 | 16.117 |
| OPTIONS /api/users | 2417 | 0 | 0.00 | 0.189 | 0.852 | 0.780 | 0.992 | 1.499 | 16.022 | 112.221 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
