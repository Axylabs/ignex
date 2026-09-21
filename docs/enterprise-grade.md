# Enterprise hardening — gap analysis & control map (R2)

Status: implemented and gated (2026-09-21). This doc records the verified
gaps, the fixes in each hardening track, what was deliberately deferred, and
where each guard maps to a recognized control class. The regression suites
listed in the [suite index](#suite-index) pin every behavior here.

## Track A — request-in/request-out security

| Gap (evidence) | Severity | Fix |
| --- | --- | --- |
| `ctx.redirect` passed an attacker-controlled `Location` verbatim (`http/context/impl.ts` previously assigned any url string) | High — open-redirect phishing / OAuth token theft via production apps | `assertSafeRedirectTarget` in `http/redirect-guard.ts`: raw-string URL/scheme analysis (**never** `new URL` on hostile input), `SAFE_SCHEMES = {http, https}`, rejects `javascript:`/`data:`/`vbscript:`, protocol-relative `//host`, backslash forms, `http:evil.com`, and CR/LF injection; `allowExternal: true` still blocks non-http(s) schemes |
| `Host` header trusted implicitly | Medium — Host-header poisoning / DNS-rebinding style attacks behind proxies | `trustedHost()` validation helper (`security/trusted-host.ts`): case-insensitive, port-normalized compare, rejects control characters |
| CL+TE both present, duplicate `content-length`, non-`chunked` TE go undetected | Medium — request-smuggling primitive behind naive proxies (native Bun path parses headers in Rust, so this is the framework-level defense + interpreted-path guard) | `detectFramingConflict` (`http/framing-guard.ts`): CL parsed by splitting and requiring all values equal; TE must be exactly `chunked`. Wired to a 400 `framing-conflict` response |
| No bound on total request-header size | Medium — memory exhaustion / DoS via oversized headers | `maxHeaderBytes` option: byte tally (names + values + CRLF) at request entry, 431 + `x-ignex-reason: header-too-large` |

## Track B — module-state purification (test isolation)

All four `@ignex/core` debug/platform modules held **module-level mutable
state** that (1) made tests order-dependent and (2) let one request/worker see
another's sequence state. Each is now instance-scoped with a documented
fallback, all behavior-preserving (breaking API changes flagged in the
`CHANGELOG.md` `[Unreleased]` entries):

- `debug/tracer.ts` — `tracingEnabled` / `nextSpanId` module state → injectable
  `SpanIdSource` (`createSpanIdSource`); `setTracingEnabled` warns when
  switching.
- `debug/nats-tracker.ts` — shared `eventSeq` + `Math.random` → instance counter
  + `crypto.getRandomValues` suffix.
- `platform/scheduler.ts` — module `jobIdCounter` + `Math.random` →
  factory-own counter + crypto suffix (`sched-<ts>-<seq>-<suffix>` preserved).
- `debug/logs.ts` — `globalStore` swap is now loud (warn) while keeping install
  semantics.

## Track C — regression suites + the genuine failures they caught

Four full suites were added and run RED/GREEN against the current code. Two
real bugs surfaced:

1. **Job double-claim (HIGH).** On a fresh-read backend (file/sqlite/redis —
   every read rehydrates new objects), 100 concurrent `claim(1)` calls all read
   the same pre-commit snapshot: `new Set(claimedIds).size === 1` — every worker
   got the SAME job and would have run it. The in-memory driver masked this by
   aliasing shared job references across reads (`jobsFromRaw`). **Fix:** all
   seven mutations (`enqueue`/`claim`/`claimOne`/`complete`/`fail`/`heartbeat`/
   `releaseExpired`) now run through a per-instance serialization chain, so each
   read-modify-write observes the previous one's committed state. Cross-process
   isolation still rests on the driver's own atomicity + lease ownership.
2. **Session lost-update (MEDIUM-HIGH).** Two concurrent `get`→`modify`→`set`
   on one session id read the same snapshot and silently dropped one writer.
   **Fix:** new atomic `SessionStore.update(id, updater)` primitive — the
   read-modify-write happens ON the backing store behind the same serialization
   chain; concurrent `update`s to one id merge, never lose.
3. **Compiler failure hygiene (MEDIUM).** A build throwing on a malformed route
   still emitted precompiled `validators/`+`serializers/`, `routes.d.ts`,
   `client`×2, `openapi.json`, `manifest.json`, and the bundled server into
   `outDir` before throwing — a corrupt dist for watchers/SDK tooling. **Fix:**
   `precompileStage`/`artifactsStage`/`linkStage` short-circuit on
   `ctx.diagnostics.hasErrors`.
4. **SELECTION not frozen (LOW, invariant).** `SELECTION` was compile-time
   `readonly` only; a runtime write silently skewed every native/JS dispatch.
   **Fix:** deep-freeze table + each `OpDecision` (`deepFreeze` at module end);
   `test:native`, `verify:native:route`, `verify:native:ffi`,
   `check:native:surface` all pass unchanged.

The suites also pin already-correct behavior: deterministic byte-identical
rebuilds (no registry bleed, no timestamps), interleaved builds never sharing
routes, rate-limit memory boundedness under 50k distinct keys, atomic
rate-limit counting under a 300-request hammer (exactly `maxRequests` admitted),
file-store crash artifacts (stray `.tmp`, torn final line), coalesced-write
flush, scheduler/file-store/SSE teardown, and DataLoader batch isolation.

## Deferred (deliberate)

- **Full debug class→factory migration** — `debug/` classes keep their shapes;
  Track B made the id/state surfaces instance-scoped where races matter.
- **Parse-level incremental compilation** — the cache today fingerprints whole
  builds; per-module parse reuse is tracked separately.
- **Distributed CAS for rate limiting / job claiming** — the plugin's atomic
  path requires a store exposing `incr` (redis) and job-store claims rely on
  driver atomicity + owner-token leases in multi-process deployments; a
  pluggable CAS contract for non-atomic shared stores is future work.
- **Header guards on the native parse path** — Bun parses headers in Rust; the
  framing/header-cap guards are framework-level on the interpreted path.

## Control map

| Guard | Control class |
| --- | --- |
| `assertSafeRedirectTarget` | OWASP open redirect / URL injection (WSTG-CLNT-04) |
| `detectFramingConflict` | HTTP request smuggling (CL/TE ambiguity) |
| `maxHeaderBytes` | DoS — request size limits |
| `trustedHost()` | Host-header validation (poisoning / DNS rebinding) |
| Tracer/nats/scheduler/logs instance-scoping | Test isolation, order-independent suites |
| Job-store mutation serialization | Lost-update / double-claim integrity |
| `SessionStore.update` | Concurrent-writer integrity on a session id |
| Compiler `hasErrors` gates | Build failure hygiene (no corrupt dist) |
| `SELECTION` deep-freeze | Immutable golden data (read-only invariant) |

## Suite index

| Suite | Pins |
| --- | --- |
| `packages/core/test/redirect-guard.test.ts` | Open-redirect rules incl. trick payloads |
| `packages/core/test/redirect-port.test.ts` | `ctx.redirect` behavior (guarded + `allowExternal`) |
| `packages/core/test/trusted-host.test.ts` | Host allowlist, port normalization, CRLF |
| `packages/core/test/framing-guard.test.ts` | CL/TE conflict matrix |
| `packages/core/test/header-cap.test.ts` | `maxHeaderBytes` 431 path |
| `packages/core/test/{tracer,nats-tracker,scheduler,logs}-purity.test.ts` | Instance state, id isolation, warn-on-swap |
| `packages/core/test/enterprise-stability.test.ts` | Teardown/rejection containment |
| `packages/core/test/enterprise-scalability.test.ts` | Claim race, batch coalescing, bounded rate limit, coalesced writes |
| `packages/core/test/enterprise-integrity.test.ts` | Crash artifacts, concurrent sessions, atomic counting, entry hygiene |
| `packages/compiler/test/enterprise-isolation.test.ts` | Determinism, empty-outDir-on-fail, build isolation, spec byte-identity |
| `packages/native/test/selection.test.ts` | `SELECTION` well-formed AND frozen |

Every item above is green under `bun run verify`, `bun run verify:full`,
`bun run test:parallel`, and `bun run check:maintainability`.