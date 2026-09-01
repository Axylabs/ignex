# RULES.md — ignex (ignus monorepo)

Non-negotiable rules for writing code in this monorepo. Read before editing.
Enforced by convention and CI (`bun run verify` / `verify:full`). `AGENTS.md`
is the how-to guide; `.agents/skills/` holds task-specific runbooks;
`docs/ai/LOCAL_DEV.md` covers cross-repo local development.

## 1. Bun first — Rust core first

- This is a **Bun-first** framework: every package targets `bun >=1.4` (the
  Rust-based runtime — [bun.com/blog/bun-v1.4](https://bun.com/blog/bun-v1.4));
  runtime code uses `Bun.serve`, `Bun.file`, `Bun.env`, Bun-native routing.
  There is no Node compatibility layer — do not add one.
- **Performance comes from the Rust core** via `@ignex/native`, the single
  typed bridge over the **castrum** addon (`optionalDependencies` in
  `packages/native/package.json`; the dev checkout lives at
  `/home/adeel/poc/bun-rust-runtime-bench`). Before writing a hot loop in TS,
  check whether the op exists in `@ignex/native` (crypto, hashing, jwt,
  ed25519, json, packed, route-wire v3, …). Measure before/after with
  `bun run bench:*` — never assume.

## 2. Native = pure acceleration (never a hard dependency)

- `@ignex/native` **never throws when castrum is missing**: every primitive
  ships a **byte-compatible pure-TS fallback** (`*Fallback` exports); the
  `SELECTION` table in `packages/native/src/selection.ts` is the single source
  of truth for which impl wins (`impl`, `nativeRatio`). Treat `SELECTION` as
  **read-only data** — never mutate it.
- New consumers use the unified execution API (`backend.*`, `implFor`,
  `createExecutionBackend`), not ad-hoc castrum calls.
- `IGNEX_NATIVE=off` forces fallbacks (the `smoke:fallback` gate runs this
  way) — new native-backed code MUST keep parity with `IGNEX_NATIVE=off`;
  **that parity is a release gate**, not an afterthought.
- **Never import `castrum`, `@ignex/nova`, or `@ignex/ninox` directly** —
  castrum only through `@ignex/native` (the loader `require()`s the addon;
  a bare `import` is stubbed out by tsconfig paths), nova/ninox only as
  optional-peer/lazy integrations (e.g. `@ignex/nova/events`).
- The cstring/zero-text-encoding FFI conventions live in castrum
  (`bun-rust-runtime-bench`, `docs/FFI_BUN_GUIDE.md`); when changing
  `packages/native`, keep byte parity with castrum's wire contracts
  (`route-wire v3`, `verify-native-route.ts`, `verify-native-ffi.ts`).

## 3. Functional composition — pure functions, no classes

- The public API is **functional composition over explicit state**: factories
  returning plain objects with closures. `@ignex/shared` ships the FP toolkit
  (`compose`, `always`, …) — reuse it; don't roll your own.
- Prefer **pure functions** (same input → same output, no hidden state) so
  they are directly unit-testable without mocks. Isolate side effects
  (sockets, files, timers, env) in dedicated modules.
- **Small functions in small files**: one responsibility per file, grouped
  into domain folders (`packages/core/src/{security,http,data,lifecycle,
  platform,content,plugins}/`, compiler `phases/`, cli `commands/`). Never
  build god-files.

## 4. Structure & maintainability

- New code ships in small, focused files under the right package/folder —
  consult `AGENTS.md` + `docs/ai/TREE.md` before adding a file. New packages
  go through `bun scripts/new-package.ts` and are **source-only**: ship
  `src/index.ts` as `main`/`module`/`types` (Bun runs TS natively) — no build
  step (only `packages/app` produces a `dist/`).
- **Cache-version discipline**: any change to generated-code output bumps
  `COMPILER_CACHE_VERSION` (`packages/compiler/src/cache.ts`) and/or
  `MODULES_CACHE_VERSION` (`frontend/persist.ts`) — enforced by
  `check:cache-versions` (pre-push).
- **Never hand-edit generated artifacts**: compiler output
  (`packages/app/dist/`, `.ignex/`, `validators/*.cjs`, `serializers`), SDK
  clients, and generated types — regenerate through the compiler/SDK pipeline.
- Don't reinvent: check `packages/shared`, `packages/core`, and `@ignex/native`
  before writing a new implementation; check the sibling core repos one
  directory back (`/home/adeel/poc/` — castrum, `@ignex/ninox`,
  `@ignex/nova`) before adding ecosystem surface.
- Public surfaces are barrels (`packages/*/src/index.ts`); the folder layout
  is an internal implementation detail — consumers import from the package
  root (or documented subpaths like `@ignex/core/http`).
- **JSDoc on every public export** — `jsdoc:check:strict` is part of
  `verify:quick`; new exports ship with a doc block or the gate fails.

## 5. Tests ship with code (vitest)

- Tests run on **vitest** (`bun run test` / `test:parallel`), not `bun test`.
  Suites live under `packages/*/test`; run a package with
  `bunx vitest run packages/<name>/test` (or the package's own `test` script).
- Pure functions get direct unit tests; compiler/native changes get
  round-trip/parity coverage; generated servers get smoke-tested
  (`bun run smoke` + `smoke:fallback`).
- Native-backed tests gate addon cases with `it.skipIf(!isNativeAvailable())`;
  the real-addon path is `test:native:real` (`--no-file-parallelism`).
- Coverage thresholds (CI floor): lines 70 / functions 60 / statements 65 /
  branches 50.
- Keep `verify:quick` green before pushing: typecheck + typecheck:cli + lint +
  jsdoc:check:strict.

## 6. Docs discipline (anti-hallucination)

- Docs must match code. Never document behavior you did not verify in the
  source; if a doc and the code disagree, fix the doc.
- When you add/rename/move files or exports, update `AGENTS.md`, `RULES.md`,
  the relevant `.agents/skills/`, `docs/*.md`, and regenerate the scaffolding
  map (`bun run gen:ai-map`).
- Keep `CHANGELOG.md` in sync with `package.json` (currently 0.1.11); keep
  JSDoc on exported symbols (`jsdoc:check:strict`).

## 7. Local development with core projects (maintainers & AI only)

- Core packages live one directory back in `/home/adeel/poc/`. This repo IS a
  core project: consumers `bun link` its packages. When testing against local
  castrum, link it into `packages/native`; when testing local `@ignex/nova`,
  link it into `packages/core` (optional peer). See
  `docs/ai/LOCAL_DEV.md`. Never publish from a linked tree; CI/releases
  resolve from the registry (`scripts/publish.ts`).
