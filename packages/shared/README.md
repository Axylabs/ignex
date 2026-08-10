# @flux/shared

Dependency-free shared toolkit used by every other package: the functional
core and the **compiler ↔ runtime AOT contract**.

Source-only (`exports` → `src/index.ts`).

## Contents (`src/`)

| File              | Responsibility                                                        |
| ----------------- | --------------------------------------------------------------------- |
| `fp.ts`           | `Result` / `Task` / `pipe` / `compose` / `ok` / `err` / `tryCatch*` … |
| `context-usage.ts`| `ContextUsage` — the per-request usage bitmap (AOT specialization)     |
| `index.ts`        | `export *` of both                                                     |

`ContextUsage` is the single source of truth for which `ctx.*` members a
handler touches. The compiler reads it to emit a specialized context; the
runtime implements the members. See [docs/architecture.md](../../docs/architecture.md)
for the contract.

## Tests

`packages/shared/test/fp.test.ts` and `context-usage.test.ts` cover the FP
toolkit and the usage bitmap. Run with `bun run test:shared` from the root.
