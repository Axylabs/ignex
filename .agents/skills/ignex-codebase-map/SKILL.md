---
name: ignex-codebase-map
description: Orient inside the ignex monorepo (/home/adeel/poc/ignus) — where each package and script lives, how the AOT pipeline fits together, and which doc is authoritative for what. Use first when starting any task here.
---

# ignex: Codebase map

Orientation guide for the `ignex` monorepo. `docs/architecture.md` is the
human deep-dive; `AGENTS.md` is the agent how-to; `docs/ai/TREE.md` is the
auto-generated scaffold (`bun run gen:ai-map`). Read the relevant `ignex-*`
skill for the task you're doing.

## Monorepo layout

```
packages/
  shared/       FP toolkit (compose, always, …) + compiler↔runtime AOT contract (ContextUsage)
  native/       ★ castrum wrapper — unified backend.* execution API, SELECTION table,
                byte-compatible pure-TS fallbacks, route-wire v3 (createNativeRoute)
  core/         runtime primitives by domain folder (security/, http/, data/, lifecycle/,
                platform/, content/, plugins/, debug/, types/) + client.ts, openapi.ts
  compiler/     AOT compiler — frontend/ (source manager), ir/, phases/ (discovery,
                analysis, optimization, codegen, linker, artifacts), sdk/, cache.ts
  cli/          ignex CLI — commands/, route.ts, templates/, completions/, config.ts
  mcp/          Model Context Protocol server (debugger, tools, server)
  app/          reference app — builder.ts (compile → dist/__server.js), src/{routes,
                views, models, middleware, hooks, config, lib}
  create/       create-ignex scaffolder
  test-utils/   shared test helpers
scripts/        32+ maintainer scripts (verify-*, bench-*, check-*, smoke, sdk, publish,
                select-native, scan-secrets, new-package, gen-ai-map)
bench/          compare/ framework-comparison harness + run-bench helpers
docs/           feature docs (architecture, router, native-acceleration, sdk,
                release-process, getting-started, cookbook, …) + ai/ scaffolding
```

## The AOT pipeline (how routes become a server)

```
route files (packages/app/src/routes/**) ── ignex build ──► @ignex/compiler
  frontend/ (source discovery + persist cache) → phases/discovery → analysis →
  optimization → codegen (emits the server + types) → linker → artifacts
    └─► packages/app/dist/__server.js  (Bun.serve with native routes table)
    └─► manifest.json + openapi.json    (inputs for `ignex sdk`)
```

- `COMPILER_CACHE_VERSION` lives in `packages/compiler/src/cache.ts`;
  `MODULES_CACHE_VERSION` in `frontend/persist.ts` — bump on generated-code
  path changes (`docs/release-process.md`).
- Runtime never duplicates the compiler: `@ignex/core` is the single source of
  truth for runtime behavior; generated code imports it.

## Doc authority map

| Need | Read |
|---|---|
| Agent how-to / commands | `AGENTS.md` |
| Coding rules | `RULES.md` |
| Architecture / monorepo layout | `docs/architecture.md` |
| Router (interpreted `createRouter` + AOT) | `docs/router.md` |
| Native acceleration (castrum bridge) | `docs/native-acceleration.md` |
| SDK generation & distribution | `docs/sdk.md` |
| Release checklist | `docs/release-process.md` |
| Adding a feature | `docs/adding-a-feature.md` + `.agents/skills/ignex-contributing/` |
| Local dev across core repos (`bun link`) | `docs/ai/LOCAL_DEV.md` |
| Fresh structural snapshot | `docs/ai/TREE.md` (regenerate: `bun run gen:ai-map`) |

## Verification gates (run before pushing)

`bun run verify:quick` (typecheck + typecheck:cli + lint + jsdoc:check:strict);
`bun run test:parallel` for cross-package tests; `bun run verify:native:route`
/ `verify:native:ffi` after native changes; `bun run smoke` + `smoke:fallback`
after app/compiler changes.
