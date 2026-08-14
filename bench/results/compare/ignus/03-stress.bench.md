# Ignus HTTP comparison report — ignus / 03-stress

Generated: 2026-08-14T07:32:19.880Z

Failure trace: `03-stress.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 03-stress |
| Generated | 2026-08-14T07:32:19.880Z |
| Total duration ms | 103720.733 |
| Achieved RPS | 924.09 |
| Total requests | 95847 |
| Successful requests | 95847 |
| Expected error responses | 0 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 2360.250 |
| Min latency ms | 0.041 |
| p50 latency ms | 0.219 |
| p75 latency ms | 1.855 |
| p90 latency ms | 11970.891 |
| p95 latency ms | 15982.919 |
| p99 latency ms | 17807.720 |
| p99.9 latency ms | 17954.009 |
| Max latency ms | 17959.564 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET /api/users | 47823 | 0 | 0.00 | 0.044 | 2381.725 | 0.217 | 15999.908 | 17795.570 | 17951.962 | 17959.162 |
| POST /api/users | 28908 | 0 | 0.00 | 0.049 | 2358.305 | 0.227 | 15979.095 | 17804.536 | 17956.147 | 17959.564 |
| GET /health | 19116 | 0 | 0.00 | 0.041 | 2309.468 | 0.211 | 15958.304 | 17821.954 | 17953.926 | 17959.198 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
