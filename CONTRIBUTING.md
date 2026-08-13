# Contributing to ignus

Thanks for contributing! This document covers the development workflow, quality
gates, and how to add features without breaking the AOT contract.

## Development setup

Prerequisites: [Bun](https://bun.sh) >= 1.4.

```sh
bun install        # install workspace dependencies
bun run typecheck  # typecheck all packages (root tsconfig)
bun run typecheck:cli  # typecheck the CLI (its own tsconfig — excluded from root)
bun run lint       # oxlint + biome
bun run test       # run the full vitest suite
bun run build      # AOT-compile the example app to packages/app/dist
bun run smoke      # boot the generated server and assert on routes
bun run verify     # typecheck + lint + test in one gate (what CI runs)
bun run jsdoc:check  # every public export must carry JSDoc (see docs/adding-a-feature.md §G)
```

> **Note:** `bun run test:coverage` runs the suite with coverage thresholds
> enforced. CI enforces them, so keep new code covered.

## Monorepo layout

| Package        | Responsibility                                            |
| -------------- | --------------------------------------------------------- |
| `@ignus/compiler` | AOT compiler: discovery → analysis → codegen → artifacts |
| `@ignus/core`     | Runtime primitives: context, lifecycle, auth, plugins…   |
| `@ignus/shared`   | Shared FP toolkit + the compiler↔runtime AOT contract     |
| `@ignus/native`   | Rust-accelerated primitives with pure-TS fallbacks        |
| `@ignus/cli`      | Developer CLI (scaffold, dev, build)                      |
| `packages/app`   | Example application used for testing and benchmarking     |

All packages ship **source-only** (`exports` point at `src/*.ts`); Bun runs TS
natively. The CLI is no exception — `bin/ignus.js` imports `../src/index.ts`.

## Quality gates (CI)

The `.github/workflows/ci.yml` pipeline runs on every push/PR:

1. `typecheck` + `typecheck:cli`
2. `lint` (oxlint + biome) — keep it warning-clean
3. `jsdoc:check:strict` — every public export must carry JSDoc (see
   [docs/adding-a-feature.md §G](docs/adding-a-feature.md)); fails CI on any
   undocumented public symbol
4. `test:coverage` — all tests + coverage thresholds
5. `build` then `smoke` — the generated server must boot and pass route assertions

Keep these green locally with `bun run verify` before pushing.

## Adding a feature

See [docs/adding-a-feature.md](docs/adding-a-feature.md) for the step-by-step
guide covering plugins, hooks, routes, macros, and native functions.

**Every public export must carry JSDoc** — the docs in `src/` are the shipped
API documentation (packages are source-only). `scripts/check-jsdoc.ts` enforces
this in CI; run `bun run jsdoc:check` locally to list anything missing. See
[docs/adding-a-feature.md §G](docs/adding-a-feature.md) for the style guide.

The single most important rule: **the compiler↔runtime contract is one-way**.
`@ignus/core` owns the runtime truth (`runHooks`, `createContext`, error types,
validators). The compiler imports those — never the other way around. If a
runtime behavior changes, bump `COMPILER_CACHE_VERSION` in
`packages/compiler/src/cache.ts` so cached builds are invalidated.

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add cache-burst helper
fix(compiler): handle named-export handlers in constant detection
docs: add core package README
test(shared): cover fp combinators
chore: bump compiler cache version
```

A pre-commit hook (`lefthook`) runs biome + oxlint on staged files and
typechecks the touched packages. Install it once with `bunx lefthook install`.

## Reporting bugs / security issues

Open an issue for bugs. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md) — do **not** open a public issue.
