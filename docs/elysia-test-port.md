# Elysia Test-Suite Port to IgnEx

Status: **in progress** (started 2026-08-13)

This document is the source of truth for adapting test scenarios from the
Elysia test suite (`/home/adeel/poc/elysia/test/**`) to IgnEx. It records:

- **Port** — Elysia scenario → IgnEx landing spot (adapted to IgnEx's API:
  route DSL `get(ctx)`, interpreted `createApp().handler()`, AOT-compiled
  `Bun.serve`).
- **Skip** — scenarios that are Elysia-architecture-specific and have no
  IgnEx equivalent (with rationale).

Elysia tests are written for `bun:test` against `new Elysia().get(p, h)`;
IgnEx uses **vitest** and a different API. Every ported test is a **faithful
rewrite of the scenario**, not a copy-paste. Common rewrites:

| Elysia pattern | IgnEx pattern |
| --- | --- |
| `new Elysia().get('/x', handler)` (compiled) | `createApp({ handler })` + `inject(app, { url: '/x' })` for the interpreted path; route file + `bootServer()` for the compiled path |
| `await app.handle(req)` | `await app.handler(req)` / `inject(app, …)` |
| `req()` / `post()` / `upload()` helpers | `@ignex/test-utils` + `inject` + `bootServer` client |
| `({ set, redirect }) => …` | `ctx.set` / `ctx.redirect(...)` |
| `({ status }) => status(201)` | `ctx.status(201)` (no body) |
| `beforeHandle` / `afterHandle` / `.error()` | `createApp({ lifecycle: { beforeHandle: [{ fn }], ... } })` |

> Convention: every test file starts with a `/** @fileoverview … */` block
> and lives in `<pkg>/test/*.test.ts`.

---

## Phase 1 — Core runtime behavior (`packages/core/test`)

Ports of Elysia `test/core/`, `test/lifecycle/`, `test/response/`,
`test/regression/`, `test/units/`, `test/utils/` — the framework-agnostic
web-standard request/response surface, adapted to the interpreted
`createApp().handler()` path via `inject`.

| IgnEx file | Elysia source(s) | Notes |
| --- | --- | --- |
| `status-port.test.ts` | `core/status.test.ts` | Body-suppression statuses (101/204/205/304/307/308). IgnEx `ctx.status(code)` takes no body → "explicit body" variants N/A (Response ctor rejects null-body status + body); assert empty body instead. |
| `redirect-port.test.ts` | `core/redirect.test.ts`, `response/redirect.test.ts` | `ctx.redirect(url, status?)`, `ctx.set.redirect`. |
| `abort-port.test.ts` | `core/abort.test.ts`, `core/abort-race.test.ts` | AbortSignal short-circuit in interpreted path. **Probe: does ignex short-circuit pre-aborted requests?** (documented divergence or bug). |
| `error-port.test.ts` | `core/handle-error.test.ts`, `core/error-tail-mask.test.ts`, `lifecycle/http-error.test.ts`, `lifecycle/error.test.ts`, `core/problem.test.ts` | `HTTPError` family → status/code envelope; error-stage hooks; exposeErrors detail masking. RFC 7807: IgnEx uses `{ error, status, code }` envelope (documented divergence from Elysia's `problem()`). |
| `auto-head-mime-port.test.ts` | `core/auto-head.test.ts`, `core/mime.test.ts` | Auto-HEAD (compiled path only — interpreted path has no router); content-type inference. Mostly lands in app E2E. |
| `sanitize-port.test.ts` | `core/sanitize.test.ts`, `regression/security.test.ts` (CRLF part) | Reflected CRLF header must not create injected headers; input sanitization. |
| `formdata-port.test.ts` | `core/formdata.test.ts` | Multipart FormData parse, file types, failed-validation input preservation. |
| `lifecycle-port.test.ts` | `lifecycle/before-handle.test.ts`, `after-handle.test.ts`, `transform.test.ts`, `derive.test.ts`, `map-response.test.ts`, `after-response.test.ts`, `after-response-errors.test.ts`, `parser.test.ts`, `request.test.ts`, `not-found-sentinel.test.ts`, `graceful.test.ts`, `promise-return-value.test.ts` | Hook semantics via `createApp({ lifecycle })`: short-circuit, ordering, transform/derive via `{ ctx }`, afterResponse observe-only, error stage. |
| `response-port.test.ts` | `response/stream.test.ts`, `response/range.test.ts`, `response/sse-double-wrap.test.ts`, `response/sse-field-frame.test.ts`, `response/custom-response.test.ts`, `response/headers.test.ts`, `response/default-headers.test.ts`, `response/ownership.test.ts`, `response/static.test.ts` | Generator streaming, cancel, HTTP Range, SSE framing, custom Response, header handling, ownership/consumption. |
| `regression-port.test.ts` | `regression/runtime-errors.test.ts`, `regression/security.test.ts` (ReDoS gate), `regression/query-parsing.test.ts`, `regression/input-coercion.test.ts`, `regression/handler-results.test.ts`, `regression/response-lifecycle.test.ts`, `regression/custom-methods.test.ts`, `regression/routing.test.ts`, `regression/hook-composition.test.ts`, `regression/guard-scoping.test.ts`, `regression/state-registration.test.ts`, `regression/schemaless-body-presence.test.ts`, `regression/dynamic-route-cache.test.ts` | ReDoS linear-regex gate <250 ms; runtime error class mapping; query parsing; handler return coercion; hook composition ordering. |

## Phase 2 — Cookies (`packages/core/test`)

Ports of Elysia `test/cookie/` + `test/validator/cookie*.test.ts`.

| IgnEx file | Elysia source(s) | Notes |
| --- | --- | --- |
| `cookie-port.test.ts` | `cookie/response.test.ts`, `cookie/signature.test.ts`, `cookie/signing-key.test.ts`, `cookie/signing-config.test.ts`, `cookie/key-cache.test.ts`, `cookie/hmac-parity.test.ts`, `cookie/crypto-provider.test.ts`, `cookie/dirty-tracking.test.ts`, `cookie/unchanged.test.ts`, `cookie/headers-instance.test.ts`, `cookie/header-source.test.ts`, `cookie/lazy-jar.test.ts`, `cookie/lazy-verify.test.ts`, `cookie/pollution.test.ts`, `cookie/name-binding.test.ts`, `cookie/defaults.test.ts` | Set-Cookie multi-cookie, signing + rotation, HMAC/WebCrypto, dirty-tracking, jar from headers, lazy verify, pollution guard. Reuse `createCookieJar`/`Cookie`/`signCookie`/`verifyCookie`/`createCookieSigner`. |

## Phase 3 — Validator / schema (`packages/core/test` + compiler)

Ports of Elysia `test/validator/` + `test/schema/` + `test/standard-schema/`.

| IgnEx file | Elysia source(s) | Notes |
| --- | --- | --- |
| `validator-port.test.ts` | `validator/prototype-pollution.test.ts`, `validator/default-values.test.ts`, `validator/default-merging-allocation.test.ts`, `validator/coerce.test.ts`, `validator/cache-normalization.test.ts`, `validator/response-validation-nested.test.ts`, `validator/refine.test.ts`, `validator/custom-error.test.ts`, `validator/encode.test.ts` | Map to `compileValidator`/`validateAsync`/`validateOrThrow` + native fast-gate. |
| extend `compiler/test/standard-schema.test.ts` | `standard-schema/multi-validator-parity.test.ts`, `standard-schema/validate.test.ts`, `standard-schema/merge.test.ts` | zod/valibot/typebox parity at build time. |

## Phase 4 — WebSocket (core unit + app E2E)

Ports of Elysia `test/ws/`.

| IgnEx file | Elysia source(s) | Notes |
| --- | --- | --- |
| extend `core/test/ws.test.ts` (fake-socket) | `ws/parser.test.ts`, `ws/codec.test.ts`, `ws/message.test.ts`, `ws/message-body.test.ts`, `ws/message-arguments.test.ts`, `ws/generator.test.ts`, `ws/http-method-gate.test.ts`, `ws/error-handling.test.ts`, `ws/security.test.ts`, `ws/upgrade.test.ts` | Unit-level: `createWSHandler`/`IgnexWS` wiring. |
| extend `app/test/streaming.test.ts` (real socket) | `ws/concurrency.test.ts`, `ws/backpressure.test.ts`, `ws/connection-id.test.ts`, `ws/dispatch-invariants.test.ts`, `ws/derive.test.ts` | Real-socket via compiled server; port `ws/utils.ts` (`newWebsocket`/`wsOpen`/`wsMessage`). |

## Phase 5 — Compiler-facing (`packages/compiler/test`)

Ports of Elysia `test/aot/`-behavior scenarios adapted to IgnEx fixtures.

| IgnEx file | Elysia source(s) | Notes |
| --- | --- | --- |
| extend `compile.test.ts` / `edge.test.ts` | `aot/handler.test.ts`, `aot/response.test.ts`, `aot/error.test.ts` (`custom-error`, `compact-error-summary`), `aot/lazy.test.ts`, `aot/plugin-transform.test.ts`, `aot/strip-modes.test.ts`, `aot/treeshake.test.ts` | Emission, error envelopes, lazy routes, plugin transform, dead-code strip. Uses `materializeFixture`. |

## Phase 6 — Parity harness (NEW)

| File | Purpose |
| --- | --- |
| `app/test/parity.test.ts` (+ hostile-input corpus) | Corpus-driven: interpreted `createApp().handler()` == compiled `Bun.serve` (status/headers/body) for identical requests, incl. hostile inputs (oversized line, malformed `%`-encoding, null bytes, `__proto__` pollution, deep nesting, giant multipart boundary). **The data-corruption scanner.** |

## Phase 7 — Perf & memory

| IgnEx file | Elysia source(s) | Notes |
| --- | --- | --- |
| `regression-port.test.ts` (ReDoS gate) | `regression/security.test.ts` | Timing gate <250 ms. |
| (optional) `allocation.test.ts` | `memory/instance-footprint.test.ts` | Only if `Bun.gc`/`heapStats` verified under vitest; otherwise perf stays in `bench/`. |

## Phase 8 — New tests beyond Elysia

| File | Purpose |
| --- | --- |
| `data-integrity-port.test.ts` | Cookie parse edge cases, header-injection via set-cookie, query/body prototype-pollution guards, deep-nesting DoS guard, multipart boundary edge cases, session-store concurrency integrity. |

---

## Skipped (Elysia-architecture-specific)

| Elysia dir | Why skipped |
| --- | --- |
| `test/aot/` (most), `test/compile/`, `test/sucrose/`, `test/generation.ts` | Elysia's AOT/JIT/static-parser internals. Only *behavior* scenarios ported (Phase 5). |
| `test/differential/` | Elysia's multi-instance differential harness; IgnEx replaces with the Phase 6 parity corpus. |
| `test/types/`, `test/type-system/` (tsc-level) | Compile-time type tests tied to Elysia's `t`/TypeBox surface. IgnEx type-level tests live in `core/http-types.test.ts`, `compiler/client-types.test.ts`. |
| `test/tracer/` | Elysia's trace plugin internals. |
| `test/memory/` | JSC instance-footprint specifics; perf stays in `bench/` (Phase 7). |
| `test/cloudflare/`, `test/node/` | Adapter/interop for other runtimes; IgnEx targets Bun. |
| `test/bundle-size.ts` | Elysia's bundle gate; IgnEx has its own `scripts/bench*`. |
| `test/2/extends/`, `test/extends/`, `test/macro/`, `test/hoc/`, `test/path/group|guard` | Elysia's `extends`/macro/group API — no IgnEx equivalent. |
| `test/adapter/` (mostly) | Bun/web-standard adapter internals. Stream/SSE behavior ported where it maps to `http/sse` + `http/files`. |
| `test/plugin/`, `test/plugins/` | Elysia plugin internals (`trace`/`websocket` capabilities); IgnEx plugins have their own suites. |
| `test/units/`, `test/utils/` | Internal helpers; port only where IgnEx lacks coverage (`merge-deep`, `constant-time-equal` map to `@ignex/shared`/`security/crypto`). |
| `test/ws/` (some) | Real-socket tests need compiled server (Phase 4). |

---

## Divergences (intentional — do NOT force-adapt tests to match Elysia)

- **Error envelope**: IgnEx uses `{ error, status, code, details? }` (RFC 7807 is available but not the default). Elysia defaults to RFC 7807 `problem()` for validation. Assert IgnEx's shape.
- **`status(code)` body**: Elysia's `status(201)` yields body `"Created"`; IgnEx `ctx.status(code)` yields an empty body (spec-compliant Response). Assert empty.
- **Auto-HEAD**: compiled path only.
- **Abort short-circuit**: IgnEx interpreted path behavior TBD (probed in `abort-port.test.ts`).
- **`ctx.set.status` vs `status()`**: both supported; `status()` wins at Response construction.

---

## Verification

1. `bun run verify` — typecheck ×2, lint, test, jsdoc:check:strict
2. `bun run test:coverage` — thresholds (lines ≥60 / branches ≥40) hold; targeted gaps improve
3. `bun run smoke` + `bun run smoke:fallback`
4. Parity harness: interpreted == compiled across the full corpus incl. hostile inputs
5. ReDoS gate <250 ms; CRLF-injection passes
6. Per-package: `test:core`, `test:compiler`, `test:app`

---

## Per-phase checklist

- [x] Phase 0 — mapping doc + baseline conventions
- [x] Phase 1 — core runtime behavior (`packages/core/test`)
- [x] Phase 2 — cookies
- [x] Phase 3 — validator/schema
- [x] Phase 4 — WebSocket (unit + real-socket E2E)
- [x] Phase 5 — compiler-facing (redirect emission)
- [x] Phase 6 — parity harness (`app/test/parity.test.ts`)
- [x] Phase 8 — new data-integrity tests
- [x] Phase 9 — fix bugs + full verify (verify / coverage / smoke / smoke:fallback green)

## Bugs found & fixed during the port

| # | Bug | Fix | Validated by |
| --- | --- | --- | --- |
| 1 | `applySet`/compiled `redirectReply` used `Response.redirect()`, which throws on relative `Location` values → `ctx.set.redirect = "/login"` and compiled `ctx.redirect("/login")` crashed (500) | Build the redirect manually (`new Response(null, { status, headers: { location } })`) in `core/http/headers.ts` AND `compiler/phases/codegen/helpers.ts` | `redirect-port.test.ts`, `compiler/test/redirect-port.test.ts` |
| 2 | `MethodNotAllowedError.allow` was never surfaced as an `Allow` header on 405 responses | Override `toResponse` in `MethodNotAllowedError` to emit `Allow` | `error-port.test.ts` |
| 3 | Reflected CRLF header values crashed the whole request (500) instead of being sanitized → injection vectors / fragility | `applySet` now strips CR/LF/NUL from header values (`sanitizeHeaderValue`) | `sanitize-port.test.ts` |
| 4 | `IgnexWS.publish` JSON-stringified `Uint8Array` into `{"0":1}` (binary corruption) while `send` handled it correctly | Route binary through `publishBinary` | `ws-port.test.ts` |
| 5 | `createWSHandler` let a throwing message/open/close/drain hook propagate synchronously (crash socket dispatch); close bookkeeping could be skipped | Add `invoke()` error containment around all hooks | `ws-port.test.ts` |

**Test-infra fix:** `bootServer` now accepts `{ rebuild: true }` so parity suites compile against CURRENT source (a stale `dist/__server.js` produced a false `accept-language` divergence). The parity harness also documents that undici's `fetch` adds a default `accept-language: *` that `new Request` does not — the corpus sends it explicitly.

**Verified divergences (intentional — not bugs):** abort short-circuit (Elysia skips the handler on a pre-aborted request; IgnEx runs it — pinned in `abort-port.test.ts`); `ctx.status(201)` yields an empty body (no "Created"); undici rejects status <200 (Bun-only 101); explicit `.form()` on a bodyless GET is a 400.
