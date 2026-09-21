# D-005 · Fail-closed on native core faults

- Status: accepted
- Context: A native core fault (ingress/handle/memory) must not silently serve
  wrong results.
- Decision: Core faults surface telemetry plus an optional 503; the default is
  availability-first pass-through, with `IGNEX_INGRESS_FAIL_CLOSED` to harden.
- Consequences: Availability-first default; operators can opt into fail-closed.
- Verification: `packages/native/src/ingress/factory.ts`, `packages/native/test/ingress-binding.test.ts`