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
   intentional "fail loudly", documented in `packages/native/src/ffi.ts`. Do not
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

- **Where:** `packages/native/src/ffi.ts` (all C-ABI surfaces — scalar ops,
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
    pre-push, publish.ts pre-flight `--no-cache-check` to bypass) fails a
    release if output-affecting files changed without a cache-version bump.
    `MODULES_CACHE_VERSION` bumped 1→2 for the persist changes.

### 🟠 Server perf gate was doubly-soft (baseline now committed)

- **Status:** ✅ 2026-08-17 — `bench/results/server/baseline.json` committed
  (`.gitignore` negation added); `check-server-bench.ts` native-vs-baseline
  check is live when run params match. Job still soft pending `/api/big`.

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
| `bun run verify:perf` | `bench:server:check` + `bench:compare:check` (perf regression gates). |
| `bun run verify:native:ffi` / `verify:native:route` | C-ABI scalar / per-route parity under plain Bun (needs real addon via `IGNEX_NATIVE_PATH`). |
| `bun run check:cache-versions` | Fails if output-affecting files changed since the last tag without a cache-version bump. |

### CI gate matrix (see `.github/workflows/ci.yml`)

- **`quality`** (hard): typecheck ×2, lint, JSDoc, `test:coverage`, `bench:native`
  sanity, build, smoke, smoke:fallback, `verify:aot:rbac`, `verify:cli:resource`,
  `check:cache-versions`. Coverage artifact uploaded.
- **`native-parity`** (hard): builds castrum; `test:native:real` + `native-bench`,
  `verify:native:ffi` + `verify:native:route` (plain Bun), C-ABI forced + NAPI
  forced suites, batch stability probe.
- **`server-bench`** (soft — see `/api/big` risk): server bench + regression gate
  vs committed baseline.
- **`nightly.yml`** (scheduled 02:00 UTC): native parity + C-ABI, perf regression,
  compare-bench soak. Failures are signals, not PR blockers.

Bun is pinned via `env.BUN_VERSION` (was `latest`) — bump deliberately.

### Release (`scripts/publish.ts`)

- `bun run release:dry` / `bun run release:bump` / `bun run release`.
- Pre-flights: `check-cache-versions` (skip `--no-cache-check`), npm auth/scope
  (`checkPublishAccess`, skip `--no-check`), `verify` gate, lockfile-version
  verification (`verifyLockfileVersions` — bun.lock caches workspace versions;
  publish.ts deletes it before install). See `docs/release-process.md`.

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
2. Default server `idleTimeout` (currently only applied when the app config sets
   it).
3. ~~Nightly malformed-FFI fuzz job~~ — JS-side malformed-input fuzz landed
   (`scripts/fuzz-malformed-input.ts`, wired into `nightly.yml` 2026-08-19); the
   Rust-side catch_unwind/fuzz remains cross-repo with castrum.
4. ~~`/api/big` native-mode overhead investigation~~ ✅ 2026-08-19 (~2% gap;
   server-bench is a hard gate again).
5. `noUncheckedIndexedAccess` at the root tsconfig (very invasive — staged last).
6. Vitest alias consolidation across the 7 per-package configs (core/cli/compiler
   subpath aliases fixed 2026-08-19; remaining packages may still need it).
