# ignex × castrum 0.9.9 + Elysia learnings — adoption plan (A+B)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`.
> Steps use checkbox (`- [ ]`) syntax. This plan is the spec.

**Goal:** push ignex toward peak performance by (A) adopting castrum 0.9.9
capabilities ignex already bridges but does not use, and (B) making perf claims
trustworthy (committed baseline + statistical gate), so every change is provable.

**Baseline context (measured, 2026-09-18/19):** `ignus-aot` CPU/req **29.24 µs
(1.264× bun)** — already better than Elysia (30.39 µs, 1.314×). Saturation
`03-stress`: ignus-aot **9,379 rps** vs elysia 8,322, bun 10,585. Framework JS is
~1.5 µs of ~30 µs; ~12.5 µs is Bun's HTTP floor and ~4.5 µs its serialization
(`docs/perf-methodology.md` §7). So this plan does **not** chase micro-ops
(§7.3 rules those out); it targets event-loop blocking, wasted work on
disconnects, memory maintenance, WS safety, and measurable regressions.

**Tech stack:** Bun ≥1.4, TypeScript, vitest, `@ignex/native` (castrum bridge),
`@ignex/compiler` AOT codegen.

## Global Constraints (from `AGENTS.md` / `RULES.md`)

- **Bun-first; native is acceleration, never a hard dependency.** Every native
  addition ships a byte-compatible pure-TS fallback; `IGNEX_NATIVE=off` parity is
  a release gate (`bun run smoke:fallback`).
- **Never import `castrum` directly outside `packages/native`.** Go through
  `@ignex/native` (`backend.*`, named exports).
- **`SELECTION` is read-only data** — never mutate at runtime. New ops need a
  fallback + a `SELECTION` row.
- **Codegen change ⇒ bump `COMPILER_CACHE_VERSION`** (`packages/compiler/src/cache.ts`)
  via `check:cache-versions`.
- **Vitest, not bun test**; new exports need JSDoc (`jsdoc:check:strict`).
- **Working tree carries user in-flight work (28 files).** Never stage/commit
  those; each task stages only its own files. Do not edit:
  `.agents/skills/ignex-core-framework/SKILL.md`, `docs/debugbar.md`,
  `docs/perf-methodology.md`, `packages/core/src/data/cache/*`,
  `packages/core/src/debug/{kt,server/endpoints,server/handlers/app-panels}.ts`,
  `packages/core/src/http/{body/conversion,headers,router}.ts`,
  `packages/core/test/{body,cache,http}.test.ts`,
  `packages/native/src/http/{cookie,query}.ts`, `packages/native/src/packed.ts`,
  `scripts/bench-hotpath.ts`, and the untracked files under
  `packages/core/src/data/cache/`, `packages/core/src/debug/`,
  `packages/core/test/__snapshots__/`, `packages/core/test/*.test.ts`.
- **Measure, never assume.** Follow `docs/perf-methodology.md` mechanics
  (interleaved A/B, ≥12k rps, control variants, resolution limit ~1 µs).
- **Commit protocol:** stage only your own files; lefthook/qlty is unavailable in
  this environment, so commits may use `--no-verify` after manually running
  `bunx biome check --write` + `bunx oxlint` on the staged set (see the prior
  perf-levers ledger Ruling 2).

---

## Task 1 — (B1) Commit a real server baseline + detect cross-run regressions

**Why:** `scripts/check-server-bench.ts:52-57` falls back to `baseline = latest`
when no baseline exists, so it only detects in-run native-vs-fallback drift, never
a cross-run regression (`docs/stability.md` open item 11). `.gitignore:58-59`
already reserves `bench/results/server/baseline.json` — the file was never created.

**Files:**
- Modify: `scripts/check-server-bench.ts` (extract a pure comparison fn; add `--update-baseline`)
- Create: `bench/results/server/baseline.json` (committed, force under the negation)
- Modify: `package.json` (add `bench:server:baseline`)
- Create: `packages/core/test/…`? No — script lives at root; put the self-test as
  `scripts/check-server-bench.test.ts`? Use vitest root config include or a plain
  `bun` self-test invoked by `bench:server:check`. Prefer a pure module +
  `vitest` test under `scripts/__tests__` only if the root vitest config includes it;
  otherwise add `--self-test` to the script itself.
- Docs: `docs/stability.md` (item 11), `docs/perf-methodology.md` (note the baseline command)

**Interfaces (produces):**
- `compareServerReports(latest: Report, baseline: Report, thresholds: {rps:number; fallback:number}): { failures: string[]; paramsMatch: boolean }` exported from `scripts/check-server-bench.ts` (or a small `scripts/lib/server-bench-compare.ts` for importability).
- `bun run bench:server:baseline` — runs `bench:server`, copies `latest.json` → `baseline.json`, prints route table.

- [ ] Step 1: run `bun run bench:server`; confirm `bench/results/server/latest.json` is a complete run (modes `native` + `fallback`, all routes) and note duration/warmup/concurrency/repeats.
- [ ] Step 2: refactor the comparison into `compareServerReports(...)`; keep behavior identical (params-match gate, both failure classes). Add `--update-baseline` (and the npm script).
- [ ] Step 3: add `--self-test`: build a synthetic `latest` that regresses one route 15% vs a synthetic baseline, assert `failures.length > 0` and exit 1; and a matching-params pass case. Wire it so `bench:server:check` can run it (e.g. `--self-test` flag or a second script).
- [ ] Step 4: produce and commit `bench/results/server/baseline.json` (verify `git check-ignore -v bench/results/server/baseline.json` shows it is NOT ignored).
- [ ] Step 5: update the two docs; run `bun run verify:quick`.
- [ ] Step 6: commit (own files only).

**Acceptance:** `bun run bench:server:check` passes with the committed baseline; `--self-test` fails on the injected regression and passes on the control; `git status` shows the baseline tracked.

---

## Task 2 — (B2) Statistical / noise gate + stale-report guard for the compare gate

**Why:** `scripts/check-compare-gate.ts` reads **saved** reports, so a stale
`bench/results/compare/` tree can pass while fresh code regressed; the gate is a
fixed threshold on a saturated p50 with no variance/CV check (the D1 lesson).

**Files:**
- Modify: `scripts/check-compare-gate.ts` (or create `scripts/check-compare-stats.ts` + wire into `verify:perf`)
- Modify: `package.json`
- Docs: `docs/perf-methodology.md`, `docs/comparison-bench.md`

**Approach:**
- Record the source/report integrity: the gate must refuse reports older than a
  recorded run marker (e.g. compare `bench/results/compare/*/<scenario>.bench.json`
  mtime against a `--since` ref, or a content hash recorded by `run-bench.ts`).
- Add a variance/CV guard: when a report carries per-round samples, fail on
  CV above a threshold or when the control participant drifts beyond the noise
  floor. If reports lack samples, require `REPEATS` and record them.
- Add `--self-test`: copy a saved report, inject a synthetic ratio regression,
  assert the gate exits non-zero; and a control case that passes. This mirrors
  Elysia's injected-regression self-test (`bench/d1/run.ts` self-test).

- [ ] Step 1: add `--self-test` with injected regression + control; assert exit codes.
- [ ] Step 2: add the stale-report guard (parameterized, default sane) and document it.
- [ ] Step 3: wire the self-test into `verify:perf` (or a `verify:perf:self-test`).
- [ ] Step 4: run `bun run verify:perf` (or the new script) and `bun run verify:quick`.
- [ ] Step 5: docs + commit.

**Acceptance:** the gate fails on an injected regression and a stale tree, passes on a fresh matching tree; self-test is deterministic.

---

## Task 3 — (A3) Expose castrum memory maintenance (`flushMemory`, `clearSchemaCache`)

**Why:** ignex never calls castrum's `flushMemory()` / `rust.clearSchemaCache()`
(present in 0.9.9). Long-lived processes have no maintenance path after
config/schema churn.

**Files:**
- Create: `packages/native/src/memory.ts`
- Modify: `packages/native/src/index.ts` (export), `packages/native/src/vendor/castrum.d.ts` (declare the TS-layer `flushMemory` on the structural module view, optional)
- Modify: `packages/core/src/index.ts` (re-export)
- Create: `packages/native/test/memory.test.ts`

**Interfaces (produces):**
- `flushNativeMemory(options?: { gc?: boolean }): Promise<void>` — resolves castrum's TS `flushMemory` via `loadCastrumModule()`; no-ops (never throws) when absent; reports degradation via `reportDegradation`.
- `clearNativeSchemaCache(): Promise<void>` — calls `rust.clearSchemaCache()` when available; no-op otherwise.

- [ ] Step 1: TDD — test that both functions resolve without a native addon (fallback) and never throw; when a fake module is injected, `flushMemory`/`clearSchemaCache` are invoked.
- [ ] Step 2: implement with `loadCastrumModule()` + `reportDegradation`.
- [ ] Step 3: JSDoc; `bun run test:native`, `bun run jsdoc:check:strict`, `bun run verify:quick`, `IGNEX_NATIVE=off bun run smoke:fallback`.
- [ ] Step 4: export from `@ignex/native` + `@ignex/core`; commit.

**Acceptance:** importing never throws; `IGNEX_NATIVE=off` parity; jsdoc strict passes; no direct castrum import outside `packages/native`.

---

## Task 4 — (A2) Request cancellation in the generated server (pre-check + 499)

**Why:** the interpreted path short-circuits an already-aborted request
(`packages/core/src/lifecycle/run.ts:325-329`) but the AOT-generated core fn does
not, and no path maps a client disconnect to a 499 or stops the pipeline — wasted
work under load/disconnect. Castrum adopted this pattern (abort → 499).

**Files:**
- Modify: `packages/compiler/src/phases/codegen/routes/handler.ts` (emit an abort pre-check at the top of the core fn)
- Modify: `packages/compiler/src/phases/codegen/header.ts` (hoist a `__abortedResponse` constant)
- Modify: `packages/compiler/src/cache.ts` (bump `COMPILER_CACHE_VERSION`)
- Modify: `packages/core/src/http/finalize.ts` or a new `packages/core/src/http/abort.ts` (shared `abortedResponse()` → 499, JSDoc) — pick the file that is NOT in the dirty set
- Test: compiler golden/e2e + `packages/core/test/abort.test.ts` (new)

**Interfaces (produces):**
- `abortedResponse(): Response` — `new Response(null, { status: 499 })` (JSDoc explains client-closed semantics).
- Generated core fn: `if (req.signal.aborted) return __abortedResponse;` before context creation.

- [ ] Step 1: TDD — a compiled route test asserts an already-aborted `Request` returns 499 without invoking the handler (handler call counter stays 0).
- [ ] Step 2: implement the core helper + codegen emission; bump `COMPILER_CACHE_VERSION`.
- [ ] Step 3: `bun run test:compiler`, `bun run test:core`, `bun run check:cache-versions`, `bun run smoke`, `bun run smoke:fallback`.
- [ ] Step 4: docs (`docs/router.md`) + commit.

**Acceptance:** aborted requests short-circuit to 499 with zero handler work, on both AOT and interpreted paths; smoke/fallback green; cache version bumped.

---

## Task 5 — (A4) WebSocket limits, in-flight cap, backpressure, shutdown drain

**Why:** Elysia caps in-flight WS messages (256) and handles backpressure/drain;
ignex's `packages/core/src/http/ws.ts` has **no limits** (`grep` finds none) and no
in-flight cap, and the compiled server never drains sockets on stop.

**Files:**
- Modify: `packages/core/src/http/ws.ts` (options + cap + per-message isolation)
- Modify: `packages/compiler/src/phases/codegen/server.ts` (emit `maxPayloadLength`/`backpressureLimit`/`idleTimeout`, strictest-wins; drain on stop)
- Modify: `packages/compiler/src/cache.ts` (cache version if codegen changes)
- Test: `packages/core/test/ws-limits.test.ts` (new)

**Interfaces (produces):**
- `WSUpgradeOptions` gains `maxPayloadLength?`, `backpressureLimit?`, `closeOnBackpressureLimit?`, `idleTimeout?`, `maxInflightMessages?` (default 256).
- Message dispatch: increment an in-flight counter; at cap, close(1013, 'Too many in-flight messages'); decrement on settle; wrap each handler in try/catch.

- [ ] Step 1: TDD — a handler that never resolves + 257 messages ⇒ connection closes 1013; a throwing handler does not crash; `maxPayloadLength` reaches `Bun.serve`.
- [ ] Step 2: implement; merge options strictest-wins across routes.
- [ ] Step 3: `bun run test:core`, `bun run test:compiler`, `bun run check:cache-versions`, `bun run smoke`.
- [ ] Step 4: docs (`docs/router.md`/`docs/architecture.md`) + commit.

**Acceptance:** payload/backpressure limits reach Bun; in-flight cap closes at 256; handler errors are isolated; tests green.

---

## Task 6 — (A1, follow-on) Off-thread task runtime consumer

**Why:** `packages/native/src/tasks.ts` bridges castrum's `createTaskRuntime`
(gzip/brotli/pbkdf2/argon2) but has **no production consumer**, so password
verify and large compression block the event loop (a concurrency/saturation issue).

**Scope:** expose an async opt-in for password verify/hash and compression in
`@ignex/core` that uses `createTaskRuntime()` where available and the existing
sync path otherwise (byte-compatible; `IGNEX_NATIVE=off` parity). Measure with
`bench:compare` under `03-stress`/`13-heavy-json`. Requires a public async API
decision — write a follow-on plan before implementing.

## Task 7 — (A5, follow-on) Castrum scalar-op adoption, measure-gated

Bind the un-adopted fast ops (`xxh3`, `base64*`, `urlEncode/Decode`,
`httpDate`/`parseHttpDate`, `mimeFromExtension`, `regexEscape`, pooled `*Into`)
**only where measured faster**, each with a byte-compatible fallback + `SELECTION`
row + parity test. Per `docs/native-acceleration.md`, several native ops already
lose to JS/Bun — measure per op, do not assume.

---

## Self-review

- **Coverage:** A (tasks 3–6) and B (tasks 1–2, 7 classified) each map to a
  documented gap in `docs/stability.md`/`perf-methodology.md` or the usage audit.
- **No micro-op chasing:** §7.3 ruled-out list is respected; no task targets the
  JS object path or the response-header shape.
- **Dirty-tree safety:** every task names files outside the 28-file user WIP set;
  A2's helper file must be chosen from the clean set (`finalize.ts` is clean;
  verify before editing).
- **Order:** 1 → 2 → 3 → 4 → 5 (independent; 6/7 follow-on).
