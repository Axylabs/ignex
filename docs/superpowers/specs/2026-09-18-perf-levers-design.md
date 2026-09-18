# Design — ignex performance program: measured levers (2026-09-18)

Status: approved design (2026-09-18). Lifecycle: this spec is a working
design doc; when the program completes, its conclusions fold into
`docs/perf-methodology.md` §7 and `CHANGELOG.md`, and this file is deleted
(per AGENTS.md: completed plans are not kept as docs; `git log` is the
archive).

## 1. Goal and success criteria

Reduce the framework-attributable per-request cost so a compiled ignex server
approaches raw `Bun.serve`, and reduce per-request resource usage (allocations,
GC pressure, RSS stability).

Success metrics (all measured with the repo's own benches, `docs/perf-methodology.md`
rules):

- `bench:compare:cpu` `ignus-aot/bun` ratio: from **1.428x** (2026-09-14) toward
  **≤1.15x** by removing dispatch machinery — never by micro-ops (§7.3: each
  micro-op lands ~0.2µs against a multi-µs gap).
- Allocation count per request: measured before/after with the fused artifact;
  report, and reduce where the profile says GC pressure is real.
- **Land only what survives measurement.** Ruled-out hypotheses are appended
  to §7.3, not relitigated per commit.
- No behavior change: existing parity/contract gates hold (`verify:perf`,
  `verify:aot:rbac`, `smoke` + `smoke:fallback`, `lifecycle.test.ts`).

Non-goals (already measured, §7.3): object pooling / boot-time hoisting /
Bun-specific APIs as a latency lever; moving object-shaped work to Rust FFI
(marshalling costs more than the JS path); re-attempting any listed ruled-out
hypothesis without a fresh measurement spike.

## 2. Current state (code facts this program builds on)

- **Runtime hook engine** (`packages/core/src/lifecycle/run.ts`): already
  flattened+memoized (`flattenHooks` WeakMap), inline result interpretation,
  zero intermediate objects on the all-sync path, no microtask unless a hook is
  actually async. The engine is not the problem; the indirection it must
  support for the *interpreted* path is.
- **Compiled server dispatch** (`phases/codegen/header.ts`,
  `phases/codegen/helpers.ts`): emits `__preStages`
  (`start→request→parse→transform→beforeHandle`) / `__postStages`
  (`afterHandle→mapResponse`) arrays composed at boot, dispatched per request
  via `runHooks(__preStages, ctx)` / `runHooks(__postStages, ctx, response)`,
  plus the same in `__optionsHandler` and `__fallback` (cold paths).
- **Specialized context tier** (`phases/codegen/routes/context.ts`): complete —
  `EMITTED_USAGE_FLAGS`, `buildContextProps`, `buildSpecializedContext`
  (emits only referenced members), the hook ladder running on the specialized
  ctx behind `__hasPreParse` const-fold, `mayMutateSet` / `__EMPTY_SET`
  handling, compact no-set tier.
- **Declared plugin usage** (`phases/analysis/internal-plugins.ts`):
  `INTERNAL_PLUGIN_USAGE` keyed by **export name** (`security`, `cors`),
  `null` = opaque; `resolveGlobalPluginUsage` yields a merged requirement only
  when every plugin comes from `@ignex/core` AND is declared — a single user
  plugin forces `usage: null` → full context for every route.
- **Plugin call attribution** (commit `678c77d`): the analyzer resolves
  app-config plugin calls to `(local name, import source)`.
- **Measured 2026-09-14** (predates the landed specialized-tier work, so §7
  baseline numbers are stale — Workstream 0 re-baselines): plugin dispatch
  +5.28µs, one guard hook +5.55µs, full-context assumption 2.24µs,
  ~406 functions/request vs Bun's ~50.

## 3. Workstream 0 — Re-baseline (gate for everything)

1. `bench:compare:cpu` (median, current artifact; ratio + control entries),
   `bench:server`, `scripts/bench-hotpath.ts`.
2. Function count and allocation count per request: `--cpu-prof` under mixed
   load + heap snapshot, to re-verify the "~406 functions" claim on today's
   artifact.
3. Layer attribution re-run (bare → +cors+security → +guard) to see how much
   of the 5.28µs/5.55µs the landed specialized tier already reclaimed.
4. Ship: updated `docs/perf-methodology.md` §4/§7 with today's numbers. Every
   later change reads against this fresh control (per §7.4: same-session
   baseline, ≥3 identical control variants, clear `dist/` before each build).

## 4. Workstream 1 — Compiler-side lifecycle fusion (largest lever)

### 4.1 What changes

For app-config-resolved, **fully-attributed** plugin layers, the compiler
stops emitting `runHooks(__preStages, …)` and instead emits direct calls to
each plugin's hook, in onion order, as straight-line code in the route core
fn. Unresolved/opaque layers (user plugin without declaration, unattributed
callee, non-declared internal plugin) keep today's `runHooks` emission with a
const-folded `__hasPreStages` guard — two emission modes, same semantics.

Per-request machinery deleted on the fused path: `__preStages`/`__postStages`
array walks, `flattenHooks` memoization lookup, `interpretHook`, per-chain
`{ ctx }`/`{ response }` result objects, several frame layers of the
~406-function stack.

### 4.2 Emission shape (semantics-preserving)

- **Pre stages** (`start→request→parse→transform→beforeHandle`):
  - Unscoped plugin (no `pattern`): `const __r1 = __hookA(ctx);` followed by
    inline interpretation — branch `instanceof Response` (halt), else the
    `{ ctx }` / `{ ok:false, response }` shapes `runHooks` accepts; a thenable
    jumps to the existing async resume machinery (`resumeName(ctx, …)`) so the
    async path stays exactly one mechanism.
  - Scoped plugin (string/RegExp/predicate `pattern`): emit the compiled
    matcher inline, guarded on `ctx.path` — a non-match emits nothing (no
    `{ ctx }` synth, exactly like `runHooks`'s static `hasPattern` skip).
  - ctx replacement (`result.ctx`) and halt (`result.response`) are expressed
    as explicit assignments/returns — never a shared accumulator.
- **Post stages** (`afterHandle→mapResponse`): the runtime composes all
  `onResponse` plugins into one hook via `runOnResponseChain` (reverse order,
  response threading, pattern skip). The fused emission expands the same logic
  as explicit sequential statements, preserving: reverse registration order,
  `undefined` pass-through, pattern scoping on `ctx.path`, sync-fast with
  single thenable seed (only the FIRST async plugin creates the promise chain;
  later plugins defer off it).
- **Halt + `__applySet`**: identical to today — a halt returns
  `__applySet(response, ctx.set, traceId)` so guard cookies/headers still land.
- **`__optionsHandler` / `__fallback`**: keep `runHooks` (cold paths; the
  fusion win is the per-request route path). Their guards stay const-folded.

### 4.3 Invariants

- The fused path must be behaviorally identical to the `runHooks` path for the
  same plugin set — protected by `lifecycle.test.ts` plus the existing parity
  suites (`verify:aot:rbac`, `smoke:fallback`, `verify:perf` contract gate).
- Ordering is derived from the SAME stage arrays (`PRE_HANDLER_STAGES`,
  `POST_HANDLER_STAGES`) so the two modes cannot drift.
- Any emission where analysis is incomplete (unresolved callee, import that
  failed to attribute, hook not provably from a declared plugin) falls back to
  the `runHooks` mode **for that whole layer** — never a partial mix that could
  reorder.
- Generated-code output changes ⇒ bump `COMPILER_CACHE_VERSION` (and
  `MODULES_CACHE_VERSION` if module resolution changes) per
  `docs/release-process.md`.

### 4.4 Measurement

Head-to-head interleaved A/B per §6 resolution-limit rules (cross-run deltas
here are not trustworthy below ~1µs). Sub-1µs claims are argued structurally,
not from the number.

## 5. Workstream 2 — Public declarative plugin context API (completes the 2.24µs lever)

### 5.1 API shape

Add to `IgnexPlugin` (in `packages/core/src/lifecycle/plugin.ts`), sibling to
the existing `responseDefaults` / `contextOptions` declarations:

```ts
/**
 * The `ctx` members this plugin's hooks read/write. Declaring them lets the
 * compiled server run the plugin layer on the usage-specialized context
 * instead of forcing every route to the full context. A member omitted here
 * but actually read hands the hook `undefined` — see the compiler's
 * `isUsageEmittable` guard. Optional and opt-in: an undeclared plugin keeps
 * today's opaque behavior (full context).
 */
readonly contextUsage?: Readonly<Partial<ContextUsage>>;
```

Types: `ContextUsage` is already exported from `@ignex/shared`.
`Readonly<Partial<ContextUsage>>` with only `true` values is the documented
contract (name it in the JSDoc); a `false`/`undefined` value reads as
"not used".

Relationship to §5.2: the plugin-object **field** is the runtime-visible,
typed API surface (what a plugin author writes; homogeneous with
`responseDefaults`/`contextOptions`); the module **named export** in §5.2 is
what the *compiler* actually reads, because it cannot execute the plugin
factory. The two describe the SAME declaration — the export is the audited,
machine-readable form and wins when both exist.

### 5.2 How the compiler learns it (named-export convention)

The compiler cannot execute user code; the app-config analyzer resolves plugin
calls to `(local name, import source)` already. Resolution for user plugins:

1. A plugin module MAY additionally export a const
   `contextUsage: Readonly<Partial<ContextUsage>>` (mirroring
   `INTERNAL_PLUGIN_USAGE` structurally), resolved statically from the module
   the call attributes to.
2. `resolveGlobalPluginUsage` extends its merge: an attributed call whose
   module exports `contextUsage` contributes that usage; `@ignex/core`
   internal plugins keep `INTERNAL_PLUGIN_USAGE` as today.
3. Any plugin that is unattributed, undeclared, or whose exported declaration
   references a member outside `EMITTED_USAGE_FLAGS` (or with an unparsable
   export) keeps the `usage: null` → full-context behavior. Fail-safe: the
   specialized tier is never entered on a member the emission cannot provide
   (the exact `undefined`-handing failure `isUsageEmittable` prevents).

Alternative rejected: reading `contextUsage` from the plugin *factory body*
(executable/user-computed; not statically sound). The named-export convention
is predictable, testable, and reuses the existing module graph.

### 5.3 Compatibility story

- Optional, opt-in; undeclared plugins behave exactly as today (opaque → full
  context). No breaking change to any existing plugin.
- A plugin declaring a wrong/unknown member is *safe by construction* (falls
  back to full context), not a silent `undefined` on the lean tier.
- Interpreted `createApp` is unaffected (no per-route usage analysis exists
  there; `createContext` remains the full context — declaration is a compiled
  build concern).
- Docs: `docs/router.md` / plugin docs get the declaration story;
  `packages/core/src/lifecycle/plugin.ts` JSDoc is the API authority.

### 5.4 Explicitly out of scope

User lifecycle hooks (`appConfigUserLifecycle` stays opaque → full context):
a per-hook declaration story is a separate change, tracked out of this program.

## 6. Workstream 3 — Resource-efficiency pass

1. **Allocation-count instrumentation**: count allocations per request on the
   fused artifact vs today (`--expose-gc` heap capture or a counter in the
   fused emission), report alongside CPU numbers in §7.
2. **FFI-handle lifecycle audit**: every `*Create` → `*Destroy` pairing across
   `packages/native` surfaces (the doc's own flag: "leak = RSS growth under
   load"; instances/routes/metrics hold handles alive from JS). Fix unmatched
   pairs only — this is a memory leak class, not a latency lever.
3. **RSS-stability probe**: `scripts/check-rss-stability.ts`-style script —
   drive the compiled server under load for N minutes, assert bounded RSS
   drift; wire into `verify:full` if the audit finds real leaks.
4. **Task runtime**: verify the `cores−1` task threads spawn lazily (no idle
   thread/memory when unused); fix only if measured otherwise.
5. Function-count reduction rides along with Workstream 1 (report new count vs
   the re-baselined 406).

## 7. Sequencing, gates, and rules

Sequence: **0 → 1 → 2 → 3**; a milestone's measurement gate must pass (or be
documented as a ruled-out hypothesis in §7.3) before the next starts. Each
milestone ends with:

- `verify:quick` (typecheck + typecheck:cli + lint + jsdoc:check:strict)
- `test:parallel` (all packages)
- `verify:perf` (cross-participant contract gate)
- `bench:compare:cpu` before/after (+ hotpath bench where relevant)
- `smoke` + `smoke:fallback` (`IGNEX_NATIVE=off` parity is a gate)
- `check:dead` (knip)

Non-negotiable (RULES.md): measure with `bench:*`, never assume; native stays
an acceleration layer, never a hard dependency; no classes on public surfaces
(the `contextUsage` field is a plain property); docs must match code.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Fused path diverges from interpreted path (ordering/replacement) | Emission derives from the same `PRE_*`/`POST_*` stage arrays; parity suites + `lifecycle.test.ts` guard; incomplete analysis falls back whole-layer |
| Cache invalidation drift (stale `dist/` silently re-measuring old code) | Bump `COMPILER_CACHE_VERSION`/`MODULES_CACHE_VERSION` on codegen change; clear `dist/` before every A/B (§7.4) |
| Public API change churn | Optional field, safe-by-construction fallback, JSDoc authority, docs updated in the same milestone |
| Sub-µs claims misread | §6 head-to-head A/B; structural argument for codegen changes; control variants next to every number |
| In-flight uncommitted tree work | Perf branch only; never stage/commit the user's dirty files |
| "No measurable change" on a real effect | Below-resolution effects documented as ruled-out with the residual explanation, not silently dropped |

## 9. Docs discipline (this program)

- `docs/perf-methodology.md` §4/§7: fresh numbers at WS0; results, new
  ruled-out lines, and the residual explanation appended per milestone.
- `CHANGELOG.md` `[Unreleased]` (workspace 0.1.32): entries flow per milestone.
- Skills/TREE regenerate: `bun run gen:ai-map` after any doc-adjacent change.
- On completion: fold conclusions into the docs above, delete this spec.