# D-014 · Every dependency edge is enforced (one-way layers)

- Status: accepted
- Context: The package layering (`shared ← native ← core ← compiler ← cli`,
  with `mcp` as an optional peer of `cli` and the reference `app` on top) has
  been documented since the first architecture pass, but only in prose. Nothing
  failed when a lower tier imported a higher one, so the rule could rot
  silently. Wiring up the first executable check found **two real runtime
  import cycles in the compiler** (`utils/ast/handler.ts` ↔
  `utils/ast/constant.ts` and `phases/schema-loader.ts` ↔
  `phases/schema-convert.ts`) that no existing gate could see.

- Decision: Add `scripts/check-layers.ts` as an executable architecture fitness
  function. It reads every `import` / `export … from` in the package `src`
  trees, applies an explicit tier table, and fails on any upward or same-tier
  edge that is not a documented exception (the `cli ↔ mcp` optional-peer pair)
  and on any import cycle inside a package. It runs in `verify`,
  `verify:quick`, `verify:full`, the CI `quality` job and the `lefthook`
  pre-push hook. The tier table and the exception list live in the script;
  `--report` and `--mermaid` print the graph so a contributor can read the
  architecture from the tool rather than from a wiki page.

- Consequences: The one-way rule is a merge gate, not an aspiration. A new
  package must be registered in the tier table (the gate fails with
  instructions). An upward edge requires a deliberate, documented exception —
  a peer dependency is a decision, not an accident. Cycles are reported with
  the file list and a fix direction. The two cycles found on introduction were
  removed by move-only extractions (`utils/ast/handler-node.ts`,
  `phases/schema-marker.ts`).

- Verification: `scripts/check-layers.ts` (`--self-test` covers the rule
  engine; `bun run check:layers` runs in `verify:quick`, `verify`, CI and the
  pre-push hook), `docs/architecture.md`
