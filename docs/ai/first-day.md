# First day in ignex

Welcome. This repo is a Bun-first monorepo for an AOT-compiled TypeScript
framework; the pitch, compiler tour and status are in `README.md`. By the end
of this page you can run it, find your way around, and pass review gates.

## ① Run it

```sh
bun install          # workspace deps (castrum addon comes via optionalDependencies)
bun run verify:quick # typecheck + typecheck:cli + lint + jsdoc — the entry gate
bun run dev          # start the reference app in packages/app
```

`verify:quick` is the fastest full sanity check; the full sweep (`bun run
verify`) adds tests, dead-code scan and the parity gates. `bun run
verify:full` adds coverage, the native smoke lanes and cache-version checks.
See the command table in `AGENTS.md` and `docs/stability.md` for what each gate
protects.

## ② The three-layer mental model

Debugging and feature work both use the same three layers:

1. **Mechanical** — `scripts/check-maintainability.ts` (+ `maintainability.json`):
   size cap (29-file `knownOver` allowlist), debt markers, orphan build dirs,
   duplicate files, `@fileoverview`, and the doc-rot guard (backticked repo
   paths in `docs/decisions` Verification lines, `.agents/skills/**/SKILL.md`,
   `docs/ai/*.md` must resolve).
2. **Why** — `docs/decisions/` (D-001 … D-012): each accepted design choice with
   a Verification clause. One owner per topic, one template.
3. **Where from** — `docs/ai/maintaining.md`: symptom → origin module → pinning
   test/script. Start here when a bug report says "it returns a weird 429".

## ③ Three canned exercises

- **(a) Trace a bug.** Pick any row in `docs/ai/maintaining.md`, open the Origin
  module, read its decisions entry, run the pinning test, then change one
  behavior and watch that test fail before reverting.
- **(b) Add a route plugin.** Follow section A of `docs/adding-a-feature.md`
  (factory, no classes; export + JSDoc; add it to the playbook if it touches
  telemetry). Run `bun run verify:quick` before pushing.
- **(c) Run the gates.** `bun run verify:quick`, `bun run test:parallel`, and
  `bun run smoke:fallback` (`IGNEX_NATIVE=off` — the no-native parity lane).

## ④ Where things live

| Package | Role |
| --- | --- |
| `packages/shared` | FP toolkit (`compose`, `pipe`, `Result`, `Task`) + the AOT contract (`ContextUsage`) |
| `packages/native` | ★ the castrum bridge: `backend.*` execution API, `SELECTION` table, byte-exact pure-TS fallbacks |
| `packages/core` | runtime primitives by domain folder (security/ http/ data/ lifecycle/ platform/ plugins/ debug/) |
| `packages/compiler` | AOT pipeline: discovery → IR → analysis → optimization → codegen → linker |
| `packages/cli` | `ignex` binary: dev, build, create, sdk |
| `packages/mcp` | Model Context Protocol server (debugger + tools) |
| `packages/app` | reference app (`builder.ts` → `dist/__server.js`) |
| `packages/create` | `create-ignex` scaffolder |
| `docs/ai/TREE.md` | generated structural snapshot (`bun run gen:ai-map`) |

Skills (`.agents/skills/*/SKILL.md`) carry the per-area runbooks — the skill
tool surfaces them; `docs/architecture.md` is the deep dive.

## Rules to remember

`RULES.md` is short and non-negotiable: Bun first / Rust core first,
native-is-acceleration (never a hard dependency; `IGNEX_NATIVE=off` parity is a
gate), functional composition (no classes on public surfaces), vitest, and the
docs discipline (code, docs, skills, TREE stay in sync).