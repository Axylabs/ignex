# Perf baseline (perf hard gate)

Recorded **2026-08-17** before the functional-composition refactor (Phase 0).

> Gate rule: relative to THIS baseline on the same machine. Fail-fast if any phase
> shows >±5% drift in encode latency or throughput, or any new allocations
> (B/op > 0 on the `quote` zero-alloc path). Repo-memory historical numbers
> (~191ns quote, ~1.24M msg/s) are informational only — machine-dependent.

## `bun run bench:serialize`

```
serialize latency (min-of-N ns/op):
  quote     Rust FFI ZERO-ALLOC       :    230.0 ns   (encodeToScratch, no JSON)
  quote     Rust FFI (owned copy)     :    328.0 ns   (encodeEvent incl. 1 alloc)
  quote     JS-side flatc pack        :    593.0 ns
  portfolio Rust FFI (packed vector)  :    945.0 ns   (no JSON)
  portfolio JS-side flatc pack        :   1699.0 ns
  LARGE     Rust FFI (packed vector)  :  27082.0 ns   (200 positions, no JSON)
  LARGE     JS-side flatc pack        :  64204.0 ns

allocations (heap delta/op, after GC):
  quote encodeToScratch (zero-alloc)  :      0.0 B/op
  quote encodeEvent (owned copy)      :     -0.0 B/op
  quote speedup (zero-alloc vs JS)    : 2.58×
  portfolio speedup (Rust vs JS)      : 1.80×
  LARGE speedup (Rust vs JS)          : 2.37×
```

## `bun run bench:throughput`

```
server publish ×20000: 18.3 ms → 1090129 msg/s (server-side)
client received: 20000/20000
```

## Key gate numbers

| metric | baseline | gate (fail if) |
| --- | --- | --- |
| quote encodeToScratch | 230.0 ns / 0.0 B/op | > ~241 ns or B/op > 0 |
| portfolio (packed vector) | 945.0 ns | > ~992 ns |
| LARGE (200 positions) | 27082.0 ns | > ~28436 ns |
| throughput | 1,090,129 msg/s | < ~1.04M msg/s |
