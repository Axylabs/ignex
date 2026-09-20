# D-NNN · <Title>

- Status: <accepted | superseded-by-D-NNN>
- Context: <why this decision exists>

  <paragraphs>

- Decision: <what was decided>

  <paragraphs>

- Consequences: <what flows from it>

  <bullet list>

- Verification: <test/gate/path(s) that pin this decision, in backticks>

---

## How to use this registry

Every behavioral "why" in ignex that is not obvious from the code gets a file
here (ADR-lite). Rules:

- Number sequentially; never reuse a number. Supersede in place —
  `Status: superseded-by-D-NNN` — instead of editing history.
- The `Verification:` bullet must cite at least one existing repo path in
  backticks; `scripts/check-maintainability.ts` (rule 6) fails on dangling
  paths, so update a decision in the same commit that moves/deletes a cited
  file.
- New native error codes / `reportDegradation` reasons must also add a row to
  `docs/ai/maintaining.md` (game/peek the playbook).