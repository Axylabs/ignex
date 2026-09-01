# AGENTS.md — ignex (ignus monorepo)

Guidance for AI coding agents working in this repository. Read this before
editing code. Human-facing docs: `README.md` (pitch + compiler + status) and
`docs/*.md` (architecture, router, native-acceleration, sdk, release-process,
getting-started, cookbook, …). Agent skills: `.agents/skills/*/SKILL.md`.
Cross-repo local development: `docs/ai/LOCAL_DEV.md`.

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
                (COMPILER_CACHE_VERSION), pipeline.ts, emitter.ts, fp.ts
  cli/          commands/, route.ts, templates/, completions/, config.ts, version.ts
  mcp/          Model Context Protocol server (debugger, tools, server)
  app/          reference app: builder.ts (compile → dist/__server.js), src/
                {routes, views, models, middleware, hooks, config, lib}
  create/       create-ignex scaffolder
  test-utils/   shared test helpers
scripts/        ~32 maintainer scripts (verify-*, bench-*, check-*, smoke, sdk,
                publish, select-native, scan-secrets, new-package, gen-ai-map)
bench/          compare/ (framework comparison harness) + run-bench helpers
docs/           feature docs (see index above) + ai/ (this scaffolding)
```

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
   (released: 0.1.7; workspace packages are ahead in `[Unreleased]` — keep
   CHANGELOG entries flowing, don't let the versions drift silently).

## Do NOT

- Import `castrum` directly outside `packages/native` — always through
  `@ignex/native`.
- Add a Node compatibility layer or make native a hard dependency.
- Mutate the `SELECTION` table at runtime (read-only data).
- Hand-edit generated artifacts (compiler output, `packages/app/dist`,
  SDK clients) — regenerate via the compiler/SDK pipeline.
- Introduce classes into public surfaces where the codebase pattern is
  factories/composition.
