# D-002 · Native acceleration is never a hard dependency

- Status: accepted
- Context: `IGNEX_NATIVE=off` must produce byte-identical behavior on every
  surface, on any Bun runtime.
- Decision: Every native path has a byte-compatible pure-TS fallback; parity
  with the real addon is a CI gate (`smoke:fallback`). The near-identical
  fallback files are intentional parity, not duplication.
- Consequences: No Node compatibility layer; no castrum import outside
  `packages/native` (see D-011). Duplicate-file scans must exclude the
  intentional twins (they fail naive block-level matchers).
- Verification: `packages/native/src/selection.ts`, `packages/native/test/selection.test.ts`, `smoke:fallback`