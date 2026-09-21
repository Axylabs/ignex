# D-010 · Compose over classes (RULES.md rule 3)

- Status: accepted
- Context: Public surfaces must be factories/composition with no classes.
- Decision: No classes on public surfaces; small pure functions in small files
  by domain. The maintainability system adds no abstraction layer on top — it
  enforces size and documentation instead.
- Consequences: Simpler mental model for newcomers; the 400-line cap is the
  guardrail, not more indirection.
- Verification: `RULES.md`, `packages/core/src/lifecycle/run.ts`