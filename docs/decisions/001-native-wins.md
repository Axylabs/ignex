# D-001 · Native-wins selection (SELECTION + FFI_WINS)

- Status: accepted
- Context: Every hot primitive has a native (castrum) implementation and a
  pure-TS implementation. The repo must pick one deterministically and must
  never silently regress to a slower path.
- Decision: `@ignex/native` consults the SELECTION table (mode gates) plus the
  measured FFI_WINS overrides in `packages/native/src/selection.ts`. SELECTION
  is read-only data — never mutated at runtime.
- Consequences: A new addon symbol does not flip behavior until it is measured
  and recorded. Deterministic fast path; the fallback parity lane stays green.
- Verification: `packages/native/src/selection.ts`, `packages/native/test/selection.test.ts`