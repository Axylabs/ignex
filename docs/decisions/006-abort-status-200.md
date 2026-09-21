# D-006 · Aborted-request responses are 200

- Status: accepted
- Context: The original castrum-adoption plan proposed abort status 499; the
  interpreted lifecycle and Elysia use 200.
- Decision: Pre-aborted requests respond with 200, not 499. Deviation recorded
  in the plan close-out.
- Consequences: Matches ecosystem behavior; no custom status-code leak.
- Verification: `packages/core/src/http/abort.ts`, `packages/core/test/abort.test.ts`