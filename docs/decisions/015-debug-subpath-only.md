# D-015 · The debug toolkit is subpath-only, not a root export

- Status: accepted
- Context: `@ignex/core` re-exported the debug / observatory primitives through
  `packages/core/src/publ/debug.ts` and the root barrel, so a plain
  `import { … } from "@ignex/core"` pulled the tracing, logging, metrics,
  SQLite-history and knowledge-tree module graph into every consumer — including
  apps that never enable the debugbar. The toolkit is large (55 files under
  `packages/core/src/debug/`) and opt-in, and it already had its own subpath
  (`@ignex/core/debug` → `packages/core/src/debug/index.ts`) that is a strict
  superset of the root re-export.

- Decision: The root barrel re-exports the runtime domains only. The debug /
  observatory toolkit is served solely from `@ignex/core/debug`;
  `packages/core/src/publ/debug.ts` is deleted and `export * from "./publ/debug"`
  is removed from `packages/core/src/index.ts`. The `@ignex/core/debug` subpath
  is unchanged and stays the single home for every tracing, logging, metrics,
  leak, sourcemap and knowledge-tree helper.

- Consequences: The root surface drops 47 names (to 321 exports) and no longer
  re-exports the debug module graph. This is a **breaking change** for a
  consumer importing a debug primitive from the package root — pre-1.0, so it
  lands as a minor. The debugbar plugin itself (`debugbar()`) still ships from
  the root plugins barrel; only the primitives moved. `AGENTS.md` already
  documented `@ignex/core/debug` as a subpath, so the guidance is unchanged.

- Verification: `packages/core/test/public-surface.test.ts` (the root entry must
  not publish a debug symbol, and the subpath must), `RULES.md`,
  `docs/architecture.md`
