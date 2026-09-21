# D-012 · Off-thread consumers for hot-path async work

- Status: accepted (design) — implementation tracks the public async API decision
- Context: Password verify / gzip compress on the hot path must not block the
  event loop.
- Decision: Hot-path async work routes through the shared task-consumer pool;
  the public API shape is tracked in the follow-on plan.
- Consequences: Pattern is defined; implementation lands with the API decision.
- Verification: `packages/native/src/tasks.ts`, `packages/native/test/tasks.test.ts`