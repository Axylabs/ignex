# Ignex stability & long-term health

This is the living risk register and stability contract for the Ignex monorepo.
It is the single place to record known failure modes, the guarantees the system
makes, and the operational runbook for running/verifying it. When you fix a
risk, move its row to "Resolved" (keep the note) rather than deleting it.

Status legend: 🔴 open (crash/data-corruption risk) · 🟠 open (wrong-behavior /
fragility) · 🟡 open (hygiene/debt) · ✅ resolved.

---

## 1. Stability contract (what the system guarantees)

1. **`@ignex/native` never throws on import.** Missing/corrupt `.node` addon,
   wrong `IGNEX_NATIVE_PATH`, `IGNEX_NATIVE=off`, or failed bind-time self-test
   all degrade to `null` and pure-TS fallbacks. The ONLY deliberate exception:
   `IGNEX_FFI_MODE=ffi` (forced) throws on bind/self-test failure — that is
   intentional "fail loudly", documented in `packages/native/src/ffi/`. Do not
   add other import-time throws.
2. **The compiler cache self-heals.** Corrupt, truncated, version-mismatched or
   tampered cache files are detected and treated as a cache miss (full rebuild)
   — never served. Cache writes are atomic (temp+rename).
3. **Malformed input never crashes a server.** Every request-path decoder is
   guarded (`decodeURIComponent`, cookies, `%XX` segments, JSON body). Body size
   limits are enforced at the wire level and after parse.
4. **A throwing lifecycle hook never demotes 404/405 to 500.** Compiled
   `__fallback`/`__optionsHandler` and interpreted `finalizeFallback` guard the
   hook runs (status preserved, plugin headers lost).
5. **Graceful shutdown terminates.** `app.stop()` runs all stop hooks via
   `allSettled` and job-queue `stop()` has a force deadline — a stuck task can
   never hang shutdown forever.
6. **Unhandled rejections don't kill the process.** `installProcessGuards()`
   (installed by `createApp().serve()` and the AOT server) logs rejections and
   keeps serving; uncaught exceptions log + `exit(1)` for a clean supervisor
   restart.

---

## 2. Risk register

### 🔴 Native FFI: Rust panic across the `bun:ffi` C-ABI boundary = process abort

- **Where:** `packages/native/src/ffi/` (all C-ABI surfaces — scalar ops,
  `getFfiRoute`/`getFfiInstances`/`getFfiIngress`).
- **Why:** A Rust panic unwinding across a raw C boundary is undefined behavior
  → SIGABRT host crash. JS `try/catch` cannot see it. The NAPI path is protected
  by napi-rs `catch_unwind`; the C-ABI path is not.
- **Status:** 🔴 open. Mitigations in place: bind-time parity self-test, JS
  fallbacks, v3-SIGILL guard in `loader.ts`.
- **Required (cross-repo, coordinated with `Axylabs/flux-rs`):**
  1. Castrum: wrap EVERY `extern "C"` export in `catch_unwind` returning the
     `0`/`null` error sentinel (already done for napi exports; must extend to the
     C-ABI symbols — `castrum_route_*`, `castrum_ingress_*`, packed parsers,
     scalar ops, JWT/Ed25519).
  2. Castrum: add a malformed/oversized-input fuzz pass over packed parsers,
     route frame, and ingress handle (adversarial `%XX`, truncated wires,
     over-long lengths) — see Phase 1A-2 below.
  3. Ignex JS side (DONE 2026-08-17): `safeJsonParse` for `jwtVerify`/
     `jwtVerifyEddsa`, configurable `MAX_VAR_OUTPUT` cap (default 128 MiB,
     `IGNEX_MAX_VAR_OUTPUT`), bind-time symbol-presence checks on the three
     additive surfaces, `IGNEX_SCRATCH_POISON=1` debug pool poisoning.
- **Fuzz harness:** not yet built (nightly TODO). When landed, wire into
  `.github/workflows/nightly.yml`.

### 🔴 No global unhandled-rejection backstop (fixed)

- **Status:** ✅ resolved 2026-08-17 — `installProcessGuards()` in
  `packages/core/src/platform/process-guards.ts`, exported from `@ignex/core`,
  auto-installed by `createApp().serve()` and the AOT server bootstrap.
- **Follow-up:** wire SIGTERM/SIGINT → `__server.stop(true)` drain in the
  generated server (see "Further work" §6).

### 🟠 Generated server: no graceful-shutdown signal wiring (fixed)

- **Status:** ✅ resolved 2026-08-19 — `compiler/src/phases/codegen/server.ts` emits
  SIGTERM/SIGINT → `__server.stop(true)` + `__pluginContext.closeAll()` + `process.exit(0)`
  with a 10s hard deadline when an app config is present (plain `exit(0)` otherwise).
  Verified live: `[ignex] received SIGTERM — draining connections`.

### 🟠 Native-mode compiled server ~15-16% slower than fallback on `/api/big` (fixed)

- **Status:** ✅ resolved 2026-08-19 — re-measured on the current build: native 5172 vs
  fallback 5299 rps = **0.98 (~2% gap)**, well within the committed-baseline band.
  `server-bench` CI is now a HARD gate (removed `continue-on-error`).

### 🟠 Compiled 404/405 hook-throw demotion (fixed)

- **Status:** ✅ resolved 2026-08-17 — `__fallback`/`__optionsHandler` in
  `packages/compiler/src/phases/codegen/helpers.ts` now guard hook runs
  (status preserved). Interpreted `finalizeFallback` already did.

### 🟠 Job-queue `stop()` could hang forever (fixed)

- **Status:** ✅ resolved 2026-08-17 — `stop()` in `platform/jobs.ts` +
  `platform/jobs-durable.ts` now respects `stopDeadlineMs` (default 5000).
  Covered by `jobs.test.ts`/`jobs-durable.test.ts` deadline tests.

### 🟠 dev.ts / MCP spawn `error` events (fixed)

- **Status:** ✅ resolved 2026-08-17 — `startChild` in `cli/commands/dev.ts`
  routes spawn failures through the existing backoff; `mcp/tools.ts`
  `runDevTool` logs instead of crashing the MCP server.

### 🟠 Plugin `init` fail-open (mitigated)

- **Status:** ✅ 2026-08-17 — default stays best-effort (log + serve); new
  `strictInit: true` option on `createApp()` stops the listener on init failure
  so the app never serves half-initialized.

### 🟠 Compiler cache could serve stale output (fixed)

- **Status:** ✅ resolved 2026-08-17:
  - `stableOptions` now fingerprints function-valued options (`fn.toString()`)
    — two builds with different callbacks can no longer collide.
  - Cache writes atomic (temp+rename) in `cache.ts` + `frontend/persist.ts`.
  - `loadPersistedModules` verifies `hash === hashString(content)` — tampered
    records are dropped.
  - `hashFile` distinguishes deleted ("missing") from unreadable files.
  - New `scripts/check-cache-versions.ts` (+ `check:cache-versions`, lefthook
    pre-push, and the canonical release's `checks` step) fails a
    release if output-affecting files changed without a cache-version bump.
    `MODULES_CACHE_VERSION` bumped 1→2 for the persist changes.

### 🟠 Server perf gate was doubly-soft (baseline not actually committed)

- **Status:** ✅ 2026-08-17 — the `.gitignore` negation for
  `bench/results/server/baseline.json` was added; job stayed soft pending
  `/api/big`. **✅ 2026-08-19** — `/api/big` closed (~2% native-mode gap), so
  the job is a **hard** gate again.
- **⚠️ Corrected 2026-09-17:** the baseline was **not** in the repo —
  `git ls-files bench/results/` listed only the four selection JSONs. The
  negation was also **dead**: `bench/results/server` excluded the directory
  itself, and git cannot re-include a file under an excluded directory. The
  pattern is now `bench/results/server/*` + `!…/baseline.json`, so a baseline
  can be committed. Until one is, `check-server-bench.ts` falls back to
  `latest.json` (`baseline = latest`) and therefore only detects
  native-vs-fallback drift **within** a run, not regressions across runs. See
  §6 item 11.
- **✅ Resolved 2026-09-19:** `bench/results/server/baseline.json` is now
  committed (from a real `bun run bench:server` run) and
  `scripts/check-server-bench.ts` compares `latest.json` against it, so a
  native-vs-baseline regression **across runs** fails the gate (the
  baseline-relative check only applies when run params match; the in-run
  native-vs-fallback check is always applied). A missing/unreadable
  `baseline.json` now **fails the gate loudly** (exit 1) instead of silently
  comparing against `latest`. Refresh it with `bun run bench:server:baseline`
  — re-runs `bench:server`, then promotes `latest.json` → `baseline.json`
  (fails if the latest run lacks `native`/`fallback` modes) and prints the
  route table. The comparison is a pure module
  (`scripts/lib/server-bench-compare.ts`) with a deterministic `--self-test`
  (`bun run bench:server:check:self`).
  > **Runner-class caveat (read before trusting a failure):** the committed
  > baseline was measured on a **dev-class host** (2026-09-18, bun 1.4.2), not
  > the CI runner. A CI runner >10% slower will false-fail the
  > baseline-relative check. Refresh `baseline.json` on the CI runner class
  > (`bun run bench:server:baseline`) before treating failures as
  > authoritative.

### 🟠 Compare gate could pass on stale reports (fixed)

- **Status:** ✅ 2026-09-19 — `scripts/check-compare-gate.ts` reads **saved**
  reports, so a stale `bench/results/compare/` tree could pass while fresh code
  regressed. The gate now:
  - has a stale-evidence guard — every compared report's `generatedAt`
    (falling back to file mtime) must be newer than the producer reference
    (`--since`, default = the newest `bench/compare/**/*.ts` mtime; missing
    timestamps count as stale);
  - exposes `--allow-stale` (deliberate old-tree re-check) and `--since`;
  - proves it can fail via a deterministic `--self-test`
    (`bun run bench:compare:gate:self`, wired into `verify:perf` as its first
    step): injected ×10 p50 regression must violate, control must pass, stale /
    timestamp-less reports must be rejected.
  The p50 decision lives in the pure `scripts/lib/compare-gate.ts`, so the CLI
  and self-test share it and it is unit-reasonable without a bench run.
  `KNOWN_SLOWER` / `GATE_TOLERANCE` semantics are unchanged.

### 🟡 `@ignex/native` memory-exhaustion cap (fixed)

- **Status:** ✅ 2026-08-17 — `MAX_VAR_OUTPUT` lowered 1 GiB → 128 MiB,
  overridable via `IGNEX_MAX_VAR_OUTPUT` (a lying addon can no longer force a
  1 GiB allocation per call).

### 🟡 `.npmrc` contained a hardcoded npm auth token

- **Where:** `.npmrc` (gitignored/untracked — verified `git ls-files` empty,
  but the token was live in the tree).
- **Status:** ✅ 2026-08-22 — token replaced with `${NPM_TOKEN}` interpolation
  (npm reads the env var at publish time), so even a force-add of `.npmrc`
  would not leak the credential. **Rotation is still recommended** (the token
  value has been used locally and may exist in logs/shell history): rotate at
  https://www.npmjs.com/settings/<user>/tokens and set `NPM_TOKEN` in the
  publish environment (CI or shell). CI has no npm publish job by design
  (`docs/release-process.md`); a secret-scan gate now runs on every PR
  (`.github/workflows/ci.yml` → `secret-scan` job, `scripts/scan-secrets.ts`).

### 🟡 Session-store sweep interval (verified wired)

- **Status:** ✅ 2026-08-17 — `createMemorySessionStore().close()` clears the
  sweep interval; the `session()` plugin wires `manager.close()` → store
  `close()` through plugin shutdown. Covered by a `session-store.test.ts`
  test.

---

## 3. Operational runbook

### Running the gates

| Command | What it gates |
|---|---|
| `bun run verify` | Fast local gate: typecheck (root+cli) + lint (oxlint+biome) + tests + JSDoc strict. |
| `bun run verify:full` | Local equivalent of the CI `quality` job: adds coverage thresholds, build, smoke (native+fallback), cache-version check. |
| `bun run verify:perf` | `bench:compare:gate:self` + `bench:compare:verify` + `bench:server:check` + `bench:compare:check` + `bench:compare:gate` (perf regression gates; the compare gate now refuses stale reports). |
| `bun run bench:server:baseline` | Re-runs `bench:server` and promotes `latest.json` → the committed server-bench baseline (run on the CI runner class). |
| `bun run bench:server:check:self` | Deterministic self-test of the server-bench comparator (no benchmark run). |
| `bun run bench:compare:gate:self` | Deterministic self-test of the compare gate — injected p50 regression must fail, control must pass, stale/timestamp-less reports must be rejected (no benchmark run). |
| `bun run verify:native:ffi` / `verify:native:route` | C-ABI scalar / per-route parity under plain Bun (needs real addon via `IGNEX_NATIVE_PATH`). |
| `bun run check:cache-versions` | Fails if output-affecting files changed since the last tag without a cache-version bump. |
| `bun run scan:secrets` | Fail if any tracked file contains a likely credential (npm/GitHub/AWS token, PEM key). Runs as a CI job before install. |
| `bun run bench:compare:gate` | Elysia-relative perf gate: ignus-aot per-route median p50 ≤ elysia × tolerance (default 1.10; KNOWN_SLOWER scenarios looser) **and** every compared report newer than the producer reference (default = newest `bench/compare/**/*.ts` mtime; `--since` / `--allow-stale` override). Nightly job. |

### CI gate matrix (see `.github/workflows/ci.yml`)

- **`quality`** (hard): typecheck ×2, lint, JSDoc, `test:coverage`, `bench:native`
  sanity, build, smoke, smoke:fallback, `verify:aot:rbac`, `verify:cli:resource`,
  `check:cache-versions`. Coverage artifact uploaded.
- **`native-parity`** (hard): builds castrum; `test:native:real` + `native-bench`,
  `verify:native:ffi` + `verify:native:route` (plain Bun), C-ABI forced + NAPI
  forced suites, batch stability probe.
- **`server-bench`** (hard): server bench + native-vs-fallback check, plus the
  regression check against the committed `bench/results/server/baseline.json`
  (refreshed via `bun run bench:server:baseline`; see the baseline risk row in
  §2).
  It was soft until the `/api/big` investigation closed the ~2% native-mode gap
  (2026-08-19); the `/api/big` risk rows below are the history of that.
- **`nightly.yml`** (scheduled 02:00 UTC): native parity + C-ABI, perf regression,
  compare-bench soak. Failures are signals, not PR blockers.

Bun is pinned via `env.BUN_VERSION` (was `latest`) — bump deliberately.

### Release (canonical `scripts/release.ts` + `.release.json`)

- `bun run release:dry` / `bun run release:bump` (`--no-publish`) / `bun run release`.
- Changed-package selection: with `"selectChanged": true` in `.release.json`
  (this repo), a release bumps + publishes only packages changed since the last
  `v*` tag plus their dependents; `--all` forces a full release and `--packages`
  picks a manual subset. `release:dry` shows the planned set.
- Pre-flights: `check-cache-versions` (a `.release.json` `checks` step; skip with
  `--no-pack`), npm auth, the `verify` gate, and bun.lock workspace-version
  verification (the release script regenerates bun.lock after a bump — bun
  caches workspace versions in bun.lock, so a stale lockfile would rewrite
  `workspace:*` deps to the old version). See `docs/release-process.md`.

---

## 4. Testing & verification expectations

- No `.only` in tests. Conditional skips (e.g. native under vitest) must be
  deliberate and documented (`it.skipIf`).
- New code paths that touch robustness land with a regression test: e.g. FFI
  JSON.parse guard, scratch pool poisoning, job stop deadline, cache
  fingerprint/tamper guard, process-guards registration, session-close.
- Lint baseline: `oxlint . && biome check .` should reach zero warnings before
  Phase 5 (hygiene) closes. Current accepted warning debt is being cleared.

---

## 5. Cross-repo coordination (castrum, `Axylabs/flux-rs`)

Open requirements owned by the Rust addon repo (tracked here for continuity):

1. `catch_unwind` on every C-ABI `extern "C"` export (see risk #1).
2. Malformed-input fuzz pass over packed parsers / route frame / ingress.
3. Publish the route/instance/ingress C-ABI symbols in a registry release so
   `getFfiRoute`/`getFfiInstances`/`getFfiIngress` are non-null on stock installs.

---

## 6. Further work (tracked, not yet scheduled)

1. ~~Generated-server SIGTERM/SIGINT → `__server.stop(true)` drain.~~ ✅ 2026-08-19
2. ~~Default server `idleTimeout` (currently only applied when the app config sets
   it).~~ ✅ 2026-08-22 — `DEFAULT_SERVER_IDLE_TIMEOUT` (10s, Bun's documented HTTP
   default) is applied by both the AOT codegen (`__serverCfg.idleTimeout ??
   DEFAULT_SERVER_IDLE_TIMEOUT`) and the interpreted `createApp().serve()` path
   unless the app sets `server.idleTimeout`; WebSockets are unaffected (their own
   handler `idleTimeout`). Covered by compiler + core tests.
3. ~~Nightly malformed-FFI fuzz job~~ — JS-side malformed-input fuzz landed
   (`scripts/fuzz-malformed-input.ts`, wired into `nightly.yml` 2026-08-19); the
   Rust-side catch_unwind/fuzz remains cross-repo with castrum.
4. ~~`/api/big` native-mode overhead investigation~~ ✅ 2026-08-19 (~2% gap;
   server-bench is a hard gate again).
5. ~~`noUncheckedIndexedAccess` at the root tsconfig (very invasive — staged
   last).~~ ✅ 2026-08-22 — enabled at the root tsconfig; 70 errors across 17
   files (core runtime + compiler + app tests + scripts) fixed with minimal
   non-null/guard edits. The CLI tsconfig already had it.
6. Vitest alias consolidation across the 7 per-package configs (core/cli/compiler
   subpath aliases fixed 2026-08-19; remaining packages may still need it).
7. **Publish readiness** — `@ignex/mcp` tarball was missing its `bin/` entry
   (`files: ['src']` excluded the declared `bin/ignex-mcp.js`); fixed
   2026-08-22 (`files: ['bin', 'src']`, verified via `npm pack --dry-run`).
   `castrum@0.9.10` is already published on npm and resolves via
   `@ignex/native` `optionalDependencies` (lockfile-verified). Remaining: run
   `bun scripts/release.ts` with a real `NPM_TOKEN` to release the monorepo.
8. **DX dogfood gate** — a `scripts/dx-journey.ts` under `verify:*`: scaffold a
   temp app, run the realtime event → frontend journey (create → `ignex event
   bus` → build → SDK → receive), and fail if **any** manual fix is needed
   (assert `tsc --noEmit` is clean and the E2E delivery works with zero edits).
   The journey is at 5 steps / 0 undocumented fixes (from ~13 / ~6); the gate is
   what keeps it there. Pair it with the error-message pass: every runtime error
   a user can hit must name the API they called and the exact fix.
9. **Realtime hardening** — (a) verify `SCHEMA_FINGERPRINT` in the
   welcome/handshake and reject loudly instead of decoding a stale registry
   silently wrong (the fix lives in `@ignex/nova`, sibling repo); (b) default the
   nova port from env (`NOVA_PORT`) or derive it from the server port, and
   support `port: 0` with the real port exposed on the plugin, so
   dev/test/tools never clash; (c) `ignex doctor` should flag realtime
   misconfiguration (`realtime.json` / bindings / events wiring) before runtime.
10. **Compiler-native `config.guards`** — `withGuards()` is the shipped path;
    hoisting guards into the route config lets the compiler keep constant-folding
    those routes. Includes the EdDSA-vs-HS256 FFI sign/verify bench that decides
    whether EdDSA belongs in `FFI_WINS`.
11. ~~**Commit a `bench/results/server/baseline.json`** (the ignore pattern is
    now correct, so it can be).~~ ✅ 2026-09-19 — committed from a real
    `bun run bench:server` run; refresh with `bun run bench:server:baseline`.
    `check-server-bench.ts` now compares `latest.json` against it whenever the
    run parameters match (otherwise it degrades to the in-run
    native-vs-fallback check) and **fails loudly** if `baseline.json` is
    missing. **The committed baseline was measured on a dev-class host** — a CI
    runner >10% slower will false-fail the baseline-relative check; refresh it
    on the CI runner class (`bun run bench:server:baseline`) before treating
    failures as authoritative.
12. **Remaining large-file splits** — the 2026-09-20 core break-up covered the
    three largest `@ignex/core` files — `lifecycle.ts` (→ barrel + `app-factory.ts`
    / `serve.ts`), `http/context.ts` (→ `http/context/{api,helpers,impl,types}.ts`),
    `lifecycle/plugin.ts` (→ `lifecycle/plugin/{composition,lifecycle-bridge,
    registry,types}.ts`) — as move-only changes with barrel re-exports. The two
    largest `@ignex/native` files followed the same treatment: `native/src/ffi.ts`
    (1268 → `ffi/{types,helpers,self-test,bind,routes,instances,metrics,ingress,
    index}.ts`) and `native/src/ingress.ts` (1074 → `ingress/{layout,constants,
    errors,headers,verdict,terminal,factory,router,index}.ts`), each move-only,
    gated by `check:native:surface` + `smoke:fallback`.

    **Maintainability system live (`check:maintainability` wired into
    `verify:quick`).** A mechanical gate in `maintainability.json` +
    `scripts/check-maintainability.ts` now enforces a 400-line cap (shrink-only
    `knownOver` allowlist), zero `TODO`/`FIXME`/`HACK`/`XXX` debt markers, no
    orphan `.gen-debug-ui-*` dirs, no exact-duplicate src files, `@fileoverview`
    on cap-size files, and no dangling doc path refs (rule 6 → `doc-ref:dangling`:
    backticked repo-path tokens in `docs/decisions/*.md` Verification lines,
    `.agents/skills/**/SKILL.md`, and `docs/ai/*.md` except generated `TREE.md`;
    whitespace-normalized, intentional globs like `packages/*` skipped) —
    (`bun run check:maintainability`; `--report` reconciles counts, `--self-test`
    runs the fixture suite). Phase 1 closed out the three Tier-0 files:
    `core/src/debug/types.ts` (778 → `debug/types/{trace,api,knowledge,
    observability,index}.ts`), `native/src/metrics.ts` (825 → `metrics/{types,
    decode,shared,registry-native,registry-fallback,index}.ts`), and
    `native/src/crypto.ts` (752 → `crypto/{hmac,cookie,csrf,jwt,token,password,
    aead,session,index}.ts`) — each move-only, gated by package suite +
    `check:native:surface` + `smoke:fallback` + `check:dead` + `check:maintainability`.
    `docs/decisions/` (ADR-lite registry, 12 seed entries) and
    `docs/ai/maintaining.md` (issue→origin playbook, now 19 rows incl. router,
    session, JWT/cookie port, compiler emission, SDK, CLI scaffolding) pin the
    decisions the splits rely on. **Phase 2 (same day) retired the Tier-A
    allowlist entirely**: `native/src/ffi/bind.ts` (→ `ffi/bind/{types,dlopen,
    surface,access,index}.ts`), `native/src/loader.ts` (→ `loader/{types,paths,
    require,native,init,index}.ts`), `native/src/route-wire.ts` (→ `route-wire/
    {constants,stages,plan,frame,result,index}.ts`), and the `core/src/index.ts`
    barrel (→ `src/publ/*`, 13 domain sub-barrels + a slim `export *` entry) —
    each move-only, gated the same way. The allowlist now holds the remaining
    **29** >400-line files (5 Tier B · 6 Tier C · 11 Tier D · 7 Tier E);
    highest-value next: `core/src/http/router.ts`, `compiler/src/sdk/*` and the
    debug Tier-C files. `docs/ai/first-day.md` onboards a first-day contributor
    (run → mental model → three exercises → package map). Each split stays
    move-only: identical behaviour, barrel re-exports, package suite +
    `verify:quick` + `check:dead`.
