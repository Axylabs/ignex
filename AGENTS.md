# AGENTS.md — ignex (ignus framework monorepo)

Guidance for AI coding agents working in this repository. Read this before
editing code. Human-facing docs: `README.md` (pitch + compiler + status) and
`docs/*.md` (architecture, router, native-acceleration, sdk, release-process,
getting-started, cookbook, …). Agent skills: `.agents/skills/*/SKILL.md`.
Cross-repo local development: `docs/ai/LOCAL_DEV.md`.

**New here?** Start with `docs/ai/first-day.md` — run it, the three-layer mental
model, three exercises, and where each package lives.

**AI scaffolding index** (this repo):
- `RULES.md` — the non-negotiable coding rules (bun-first, rust-core-first via
  `@ignex/native`, functional composition, vitest discipline, docs discipline).
- `.agents/skills/` — task-specific runbooks (codebase map, core framework,
  native/castrum bridge, cli & compiler, sdk & openapi, contributing).
- `docs/ai/TREE.md` — auto-generated scaffold (`bun run gen:ai-map`).
- `docs/ai/LOCAL_DEV.md` — `bun link` workflow (this repo is a CORE project).

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
| Smoke gates | `bun run smoke` (native) + `bun run smoke:fallback` (`IGNEX_NATIVE=off`) |
| SDK generation | `bun run sdk` / `sdk:push` / `sdk:publish` / `sdk:release` |
| Benchmarks | `bun run bench`, `bench:native`, `bench:ffi`, `bench:jwt*`, `bench:server*`, `bench:compare` |
| Native parity checks | `bun run verify:native:route` / `verify:native:ffi` / `verify:aot:rbac` / `verify:cli:resource` / `check:native:surface` (vendor/castrum.d.ts ↔ real addon drift) |
| Secret scan | `bun run scan:secrets` |
| New package | `bun scripts/new-package.ts` |
| Regenerate AI scaffold | `bun run gen:ai-map` |

## Where things live (short map — full detail in docs/architecture.md + docs/ai/TREE.md)

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
                release, select-native, scan-secrets, new-package, gen-ai-map)
bench/          compare/ (framework comparison harness) + run-bench helpers
docs/           feature docs only — see the doc index below; docs/ai/ is
                agent scaffolding (LOCAL_DEV.md + generated TREE.md)
```

## Doc index (one owner per topic — extend this table, don't add a new doc)

| Topic | Doc |
| --- | --- |
| Architecture / monorepo layout / external packages | `docs/architecture.md` |
| Router: interpreted `createRouter` + the AOT file-routing model | `docs/router.md` |
| Native acceleration: castrum bridge, SELECTION, fallbacks | `docs/native-acceleration.md` |
| Measuring perf: methodology, cost budget, ruled-out hypotheses | `docs/perf-methodology.md` |
| Cross-framework comparison bench (participants, ports, gates) | `docs/comparison-bench.md` |
| Bun runtime internals we rely on (and measured alternatives) | `docs/bun-internals.md` |
| Compatibility matrix with nova / ninox / castrum | `docs/compatibility.md` |
| SDK generation and distribution | `docs/sdk.md` |
| Debugbar + observatory (dashboard, driver protocol) | `docs/debugbar.md` |
| DB drivers (sqlite / mongo / drizzle) | `docs/drivers.md` |
| Deployment (Bun binary, Docker, proxies) | `docs/deployment.md` |
| First-run tutorial | `docs/getting-started.md` |
| Task recipes | `docs/cookbook.md` |
| Adding a feature (workflow + gates) | `docs/adding-a-feature.md` |
| Release checklist + version files | `docs/release-process.md` |
| Known risks, gate matrix, further work | `docs/stability.md` |
| Cross-repo `bun link` development | `docs/ai/LOCAL_DEV.md` |
| Auto-generated structural snapshot | `docs/ai/TREE.md` (`bun run gen:ai-map`) |

Completed plans and dated measurement logs are **not** kept as docs — fold the
still-live conclusion into one of the docs above (or `CHANGELOG.md`) and delete
the plan. `git log` is the archive.

## Rules (full text in RULES.md)

1. **Bun first, Rust core first** — `bun >=1.4` everywhere; perf comes from
   `@ignex/native` (castrum); measure with `bench:*`, never assume.
2. **Native is acceleration, never a hard dependency** — byte-compatible
   fallbacks, `SELECTION` is read-only, `IGNEX_NATIVE=off` parity is a gate.
3. **Functional composition** — factories over explicit state; no classes on
   public surfaces; small pure functions in small files, domain folders.
4. **Vitest, not bun test** — suites under `packages/*/test`; `test:parallel`.
5. **Docs discipline** — docs must match code; keep `AGENTS.md`/`RULES.md`/
   skills/TREE in sync; `jsdoc:check:strict`; CHANGELOG ↔ package.json
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
