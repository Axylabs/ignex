---
name: ignex-cli-compiler
description: Work inside the ignex CLI (@ignex/cli) and the AOT compiler (@ignex/compiler) — route discovery, IR, phases, codegen, and the generated server artifacts. Use when changing how routes become a server.
---

# ignex: CLI & AOT compiler

`@ignex/cli` (ignex dev/build/route/scaffold) drives `@ignex/compiler`, which
turns route files into an optimized `Bun.serve` server with generated types,
an OpenAPI spec, and a typed client. `docs/getting-started.md` and
`docs/architecture.md` are the human references.

## Compiler pipeline (`packages/compiler/src/`)

```
frontend/    source-file.ts, source-manager.ts, persist.ts (MODULES_CACHE_VERSION),
             index.ts — route discovery + parse cache
ir/          route.ts, lower.ts, index.ts — compiler IR
phases/      discovery.ts → analysis/ → optimization.ts → codegen/ → linker.ts →
             artifacts/ — the phase chain (see pipeline.ts)
cache.ts     COMPILER_CACHE_VERSION — bump when generated-code paths change
pipeline.ts  orchestration; emitter.ts + diagnostics.ts + logger.ts + options.ts
sdk/         SDK generation support
```

- `@ignex/compiler` is `bun run --cwd packages/compiler test`-testable; its
  generated code imports `@ignex/core` at runtime (never duplicated).
- **AOT contract**: `@ignex/shared` carries the compiler↔runtime contract
  (`ContextUsage` in `packages/shared/src/context-usage.ts`) — changing it
  touches both sides.
- The `routes` table the compiler emits is Bun-native (Rust path/method
  matching); `docs/router.md` documents the interpreted `createRouter`
  counterpart and its fallback parity.

## CLI (`packages/cli/src/`)

- Dispatch is a **citty root app**: `index.ts` (entry + unknown-command typo
  recovery), `app.ts` (root `defineCommand` with lazy subcommands),
  `usage.ts` (root + per-command help), `commands/registry.ts` (the command
  table — names/aliases/descriptions/examples, the single source of truth),
  `commands/loaders.ts` (dynamic imports so `ignex` boots fast).
- **Every command** is a `defineCommand` with a typed `argsDef` (one source
  of truth for parsing, help, and completions), exported as the default +
  a legacy `runX(argv)` entry tests call. `utils/run-def.ts` bridges the two.
- `ignex route` inspects the route table (verify with
  `bun run verify:cli:resource`); `ignex dev` runs the watch loop
  (`--no-spawn` to build-only, `--open` to launch the browser).
- Completions: `utils/completion.ts` derives flags/values from the typed
  args; the hidden `_complete` command + `completions/` scripts ship it to
  bash/zsh/fish/powershell/cmd.
- CLI tests: `bun run test:cli` (`--cwd packages/cli`).

## Generated artifacts (do not hand-edit)

- `packages/app/dist/__server.js` — compiled server (regenerate with
  `bun run build` / `ignex build`).
- `manifest.json` + `openapi.json` — compiler outputs that feed `ignex sdk`.
- SDK clients (`ignex sdk`) — regenerated, never hand-edited.

## Conventions

- Compiler phases are small pure-ish functions over an options/state object —
  follow the existing phase structure; add a phase via `phases/` + `pipeline.ts`.
- FP utilities come from `compiler/fp.ts` and `@ignex/shared` — no ad-hoc
  monad implementations.
- Cache versions must bump when the generated-code shape changes
  (`COMPILER_CACHE_VERSION`, `MODULES_CACHE_VERSION`) — see
  `docs/release-process.md`.

## Verify

- `bun run test:compiler` and `bun run test:cli`.
- `bun run typecheck:cli` for the CLI's own tsconfig.
- After compiler changes: `bun run build` + `bun run smoke` +
  `bun run smoke:fallback`; after native-route changes:
  `bun run verify:native:route` + `verify:aot:rbac`.
