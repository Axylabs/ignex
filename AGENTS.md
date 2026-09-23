# AGENTS.md — ignex monorepo

Guidance for AI coding agents working in this repository. Read this before
editing code. Human-facing docs: `README.md` (pitch + quick start + status) and
`docs/*.md` (architecture, router, native-acceleration, sdk, release-process,
getting-started, cookbook, …). Agent skills: `.agents/skills/*/SKILL.md`.

**New here?** Run [First day](#first-day) below — it takes you from a cold clone
to a passing gate, then gives you the three-layer mental model and three
exercises. Local cross-repo work is in
[Local development](#local-development-with-the-core-projects-bun-link).

**AI scaffolding index** (this repo):
- `RULES.md` — the non-negotiable coding rules (bun-first, rust-core-first via
  `@ignex/native`, functional composition, vitest discipline, docs discipline).
- `.agents/skills/` — task-specific runbooks (codebase map, core framework,
  native/castrum bridge, cli & compiler, sdk & openapi, contributing).
- `docs/ai/maintaining.md` — symptom → origin module → pinning test.
- `docs/decisions/` — accepted design choices (D-001…), each with a
  Verification clause.

## What this project is

`ignex` — a private, Bun-first monorepo (workspaces `packages/*`) for an
**AOT-first TypeScript framework on Bun 1.4+** (the Rust-based runtime):
routes are files; the compiler (`@ignex/compiler`) turns them into an
optimized `Bun.serve` server with generated types, an OpenAPI spec, and a
typed client. Native performance comes from the **castrum** Rust addon through
`@ignex/native` (pure-TS fallbacks when castrum is absent). Runtime primitives
live in `@ignex/core` (functional composition, no classes). Tests use
**vitest**; lint is oxlint + Biome.

## Commands (root)

| Task | Command |
|------|---------|
| Typecheck (root + cli) | `bun run typecheck` / `bun run typecheck:cli` |
| Quick verify gate | `bun run verify:quick` (typecheck + typecheck:cli + lint + jsdoc:check:strict) |
| Full verify | `bun run verify` (adds tests + check:dead); `bun run verify:full` (adds coverage, build, smoke, smoke:fallback, check:cache-versions) |
| Tests (all packages, parallel) | `bun run test:parallel` (core/compiler/shared/cli/mcp) |
| Single package tests | `bunx vitest run packages/<name>/test`; `bun run test:native` / `test:native:real` |
| Lint / fix | `bun run lint` (oxlint + biome) / `bun run lint:fix` |
| Dead-code scan | `bun run check:dead` (knip — unused files/exports/deps; config in `knip.json`; part of `verify`) |
| Build + run app | `bun run build` → `bun run dev` / `bun run start` |
| App dev server with debugbar | `bun run dev:debug` (debug-shaped build in `packages/app/dist-dev/`; production `dev`/`build` eliminate the debugbar) |
| Smoke gates | `bun run smoke` (native) + `bun run smoke:fallback` (`IGNEX_NATIVE=off`) |
| SDK generation | `bun run sdk` / `sdk:push` / `sdk:publish` / `sdk:release` |
| Benchmarks | `bun run bench`, `bench:native`, `bench:ffi`, `bench:jwt*`, `bench:server*`, `bench:compare` |
| Native parity checks | `bun run verify:native:route` / `verify:native:ffi` / `verify:aot:rbac` / `verify:cli:resource` / `check:native:surface` (vendor/castrum.d.ts ↔ real addon drift) |
| Secret scan | `bun run scan:secrets` |
| New package | `bun scripts/new-package.ts` |

## First day

```sh
bun install          # workspace deps (the castrum addon arrives via optionalDependencies)
bun run verify:quick # typecheck + typecheck:cli + lint + jsdoc + check:debug-ui + maintainability
bun run dev          # start the reference app in packages/app
```

`verify:quick` is the fastest full sanity check. `bun run verify` adds tests,
the dead-code scan and the parity gates; `bun run verify:full` adds coverage,
the native smoke lanes and cache-version checks.

**The three-layer mental model** — debugging and feature work both use it:

1. **Mechanical** — `scripts/check-maintainability.ts` (+ `maintainability.json`):
   size cap (shrink-only `knownOver` allowlist), debt markers, orphan build
   dirs, duplicate files, `@fileoverview`, and the doc-rot guard (backticked
   repo paths in `docs/decisions` Verification lines, `.agents/skills/**/SKILL.md`
   and `docs/ai/*.md` must resolve).
2. **Why** — `docs/decisions/` (D-001 …): each accepted design choice with a
   Verification clause.
3. **Where from** — `docs/ai/maintaining.md`: symptom → origin module → pinning
   test. Start here when a bug report says "it returns a weird 429".

**Three exercises** that work as a first contribution:

- **Trace a bug.** Pick any row in `docs/ai/maintaining.md`, open the origin
  module, read its decisions entry, run the pinning test, then change one
  behavior and watch that test fail before reverting.
- **Add a route plugin.** Follow section A of `docs/adding-a-feature.md`
  (factory, no classes; export + JSDoc). Run `bun run verify:quick` before
  pushing.
- **Run the gates.** `bun run verify:quick`, `bun run test:parallel`, and
  `bun run smoke:fallback` (`IGNEX_NATIVE=off` — the no-native parity lane).

## Where things live (short map — full detail in docs/architecture.md)

```
packages/
  shared/       FP toolkit (compose, always) + compiler↔runtime AOT contract (ContextUsage)
  native/       ★ castrum wrapper: unified backend.* execution API + SELECTION table +
                byte-compatible pure-TS fallbacks; route-wire v3 (createNativeRoute)
  core/         runtime primitives by domain folder: security/ (auth, csrf, crypto,
                session), http/ (context, body, proxy, files, sse, ws, route DSL),
                data/ (cache, dataloader, lru, query, schema, validation),
                lifecycle/ (hooks, lifecycle, plugin), platform/ (env, config, jobs,
                errors), content/ (i18n, template), plugins/, debug/ (debugbar +
                observatory: logs, metrics/Prometheus, SQLite history, leak
                diagnostics; debug/ui/ is a SolidJS + Tailwind SPA compiled
                ahead of time by scripts/gen-debug-ui.ts), openapi.ts, jobs.ts —
                barrel exports; subpaths @ignex/core/http|debug|...
  compiler/     AOT: frontend/ (source manager), ir/, phases/ (discovery, analysis,
                optimization, codegen, linker, artifacts), sdk/, cache.ts
                (COMPILER_CACHE_VERSION), pipeline.ts, emitter.ts
  cli/          commands/, route.ts, templates/, completions/, config.ts, version.ts
  mcp/          Model Context Protocol server (debugger, tools, server)
  app/          reference app: builder.ts (compile → dist/__server.js), src/
                {routes, views, models, middleware, hooks, config, lib}
  create/       create-ignex scaffolder
  test-utils/   shared test helpers
scripts/        maintainer scripts (verify-*, bench-*, check-*, smoke, sdk,
                release, select-native, scan-secrets, new-package)
bench/          compare/ (framework comparison harness) + run-bench helpers
docs/           feature docs only — see the doc index below; docs/ai/ is
                agent scaffolding (maintaining.md + the ADR-lite decisions/)
```

## Doc index

The canonical map — every doc, its audience and maturity, plus reading paths
per persona — is **`docs/README.md`** (one owner per topic: extend a row, never
start a parallel doc; `check:maintainability` enforces it). Quick links:
`docs/architecture.md`, `docs/router.md`, `docs/getting-started.md`,
`docs/adding-a-feature.md`, `docs/release-process.md`, `docs/debugbar.md`,
`docs/stability.md`, `docs/ai/maintaining.md`.

Completed plans and dated measurement logs are **not** kept as docs — fold the
still-live conclusion into the owning doc (or `CHANGELOG.md`) and delete
the plan. `git log` is the archive.

## Local development with the core projects (`bun link`)

This repo **is** a core project: consumers link its packages. The sibling core
repos live one directory back in `/home/adeel/poc/` — `castrum`, `ninox`,
`nova`. Application developers consuming published versions never need this.

```sh
# Register the package (once per machine, from the package dir):
cd /home/adeel/poc/ignex/packages/core && bun link

# Link it into a consumer (--save records "link:@ignex/core" in package.json):
cd /home/adeel/poc/my-app && bun link @ignex/core
```

Cross-repo edges (verify with `grep` in `package.json` before assuming):

- **`@ignex/native` → `castrum`** (`optionalDependencies: ^0.9.10`). Build the
  addon files the loader looks for, register it, then link (a bare
  `target/release/libcastrum.so` is not enough — the loader needs a
  package-shaped checkout):
  ```bash
  cd /home/adeel/poc/castrum
  cp target/release/libcastrum.so castrum.linux-x64-gnu.node   # baseline
  bash scripts/build-v3.sh                                     # x86-64-v3 SIMD variant
  bun link                                                     # register castrum

  cd /home/adeel/poc/ignex
  bun link castrum                       # root node_modules/castrum → checkout
  ln -s /home/adeel/poc/castrum packages/native/node_modules/castrum
  ```
  The symlink is created directly because `bun link castrum` *inside*
  `packages/native` fails (`@ignex/test-utils@workspace:*` does not resolve
  outside the workspace root); it is the same link state bun would produce.
- **`@ignex/core` → `@ignex/nova`** (optional peer): `cd /home/adeel/poc/nova
  && bun link`, then `cd packages/core && bun link @ignex/nova`.
- **Rust cdylibs go stale the moment the Rust source changes** — rebuild before
  linking (`castrum`: `bun run build`; nova: `bun run build:rust`), then re-run
  the native gates (`verify:native:ffi`, `verify:native:route`, `smoke`,
  `bench:server:check`). A stale `.node` silently serves old behavior.

Traps worth knowing:

- A forgotten `IGNEX_NATIVE_PATH` from an earlier session silently wins over the
  link (it is the loader's first resolution step) and reads exactly like "the
  link did not work": `echo "${IGNEX_NATIVE_PATH:-<unset>}"`.
- **Never publish from a linked tree** — that ships symlinks, not packages.
  CI and releases always resolve from the registry (`scripts/release.ts`); keep
  `bun link` strictly local.

## Rules (full text in RULES.md)

1. **Bun first, Rust core first** — `bun >=1.4` everywhere; perf comes from
   `@ignex/native` (castrum); measure with `bench:*`, never assume.
2. **Native is acceleration, never a hard dependency** — byte-compatible
   fallbacks, `SELECTION` is read-only, `IGNEX_NATIVE=off` parity is a gate.
3. **Functional composition** — factories over explicit state; no classes on
   public surfaces; small pure functions in small files, domain folders.
4. **Vitest, not bun test** — suites under `packages/*/test`; `test:parallel`.
5. **Docs discipline** — docs must match code; keep `AGENTS.md`/`RULES.md`/
   skills in sync; `jsdoc:check:strict`; CHANGELOG ↔ package.json
   (workspace version: 0.1.32 — everything is under the single `[Unreleased]`
   heading until `scripts/release.ts` finalizes it; keep entries flowing, don't
   let the versions drift silently).

## Do NOT

- Import `castrum` directly outside `packages/native` — always through
  `@ignex/native`.
- Add a Node compatibility layer or make native a hard dependency.
- Mutate the `SELECTION` table at runtime (read-only data).
- Hand-edit generated artifacts (compiler output, `packages/app/dist`,
  SDK clients) — regenerate via the compiler/SDK pipeline.
- Introduce classes into public surfaces where the codebase pattern is
  factories/composition.
