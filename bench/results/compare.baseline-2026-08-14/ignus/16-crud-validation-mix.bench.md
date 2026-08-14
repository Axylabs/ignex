# Ignus HTTP comparison report — ignus / 16-crud-validation-mix

Generated: 2026-08-14T00:33:06.903Z

Failure trace: `16-crud-validation-mix.failures.ndjson`

## Overview

| Metric | Value |
| --- | --- |
| Server | ignus |
| Scenario | 16-crud-validation-mix |
| Generated | 2026-08-14T00:33:06.903Z |
| Total duration ms | 100020.812 |
| Achieved RPS | 260.03 |
| Total requests | 26008 |
| Successful requests | 23367 |
| Expected error responses | 2641 |
| Unexpected failed requests | 0 |
| Timeouts | 0 |
| Network errors | 0 |
| Unexpected statuses | 0 |
| Response shape failures | 0 |
| Unexpected error rate % | 0.00 |
| Avg latency ms | 0.798 |
| Min latency ms | 0.178 |
| p50 latency ms | 0.781 |
| p75 latency ms | 0.969 |
| p90 latency ms | 1.071 |
| p95 latency ms | 1.123 |
| p99 latency ms | 1.259 |
| p99.9 latency ms | 9.439 |
| Max latency ms | 104.143 |

## Error groups

These are unexpected failures. This table tells you which request failed and why.

| Count | Method | Route | Status | Error code | Error message | First ms | Last ms | Sample response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Route latency

| Route | Count | Errors | Error % | Min ms | Avg ms | p50 ms | p95 ms | p99 ms | p99.9 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PUT /api/users | 3893 | 0 | 0.00 | 0.178 | 0.830 | 0.788 | 1.133 | 1.274 | 10.808 | 104.143 |
| PATCH /api/users | 2694 | 0 | 0.00 | 0.210 | 0.786 | 0.771 | 1.130 | 1.265 | 8.361 | 9.534 |
| POST /api/users | 9040 | 2641 | 29.21 | 0.183 | 0.794 | 0.786 | 1.125 | 1.253 | 9.356 | 12.015 |
| GET /api/users | 10381 | 0 | 0.00 | 0.188 | 0.793 | 0.778 | 1.119 | 1.256 | 9.439 | 14.330 |

## Failure samples

| Time ms | VU | Iter | Method | Route | Status | Latency ms | Error code | Error message | Response snippet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
