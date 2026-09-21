# D-007 · Metrics binding is lazy + optional

- Status: accepted
- Context: Pre-symbol addons and hosts without `bun:ffi` must not crash metric
  collection.
- Decision: The metrics surface binds lazily and degrades to `null`; a bind-time
  probe (`__probe_total`) guards against partial symbol surfaces; the NAPI-plus
  wrapper accounts for the null case.
- Consequences: Metric loss instead of crashes on exotic hosts.
- Verification: `packages/native/test/metrics.test.ts`, `packages/native/src/runtime.ts`