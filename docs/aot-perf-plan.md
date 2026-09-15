# AOT performance plan — "beat raw Bun on the comparison bench"

**Status:** Phase 0 complete · **Owner:** TBD · **Created:** 2026-09-14
**Related:** `docs/perf-methodology.md` (measurement runbook),
`docs/comparison-bench.md`, `docs/native-acceleration.md`,
`.agents/skills/ignex-cli-compiler/SKILL.md`

---

## 1. Objective

On the comparison bench (`bench/compare`, `03-stress` mix at concurrency 128),
make the AOT-compiled participant use **no more CPU per request than the raw
`Bun.serve` baseline**, for the same amount of work.

The metric is **server CPU per request at a pinned pace**, not rps. rps A/B on
this machine varies ±8% between runs and cannot resolve the changes below.

## 2. Where we are (measured 2026-09-14)

`bun run bench:compare:cpu` — 3 alternating rounds of 8s at 15k rps, medians
(individual rounds in `bench/results/compare/cpu.json`):

| participant | CPU/req | vs bun |
| --- | --- | --- |
| `bun` (raw `Bun.serve` routes) | **23.28µs** | 1.000x |
| `elysia` | 26.96µs | 1.158x |
| `ignus-aot` (compiled) | **33.24µs** | **1.428x** |
| `ignus` (interpreted) | 34.35µs | 1.476x |
| `ignus-native` (native preflight) | 34.55µs | 1.484x |

The AOT path burns **~43% more CPU per request** than raw Bun, and is
correctly the fastest ignex variant.

Layer attribution (matched variants, same harness, medians spread ±0.2µs):

| config | CPU/req | delta vs Bun |
| --- | --- | --- |
| `bun` | 20.72µs | — |
| `bare` ignex (no plugins, no hooks) | 23.62µs | **+2.90** framework core |
| `+ cors + security` | 28.90µs | **+5.28** |
| `+ guard` (one `beforeHandle` hook) | 34.45µs | **+5.55** |

Reading:

* **The framework core is +2.90µs.** Router wrapper → context construction →
  generic reply finalize. This is the irreducible cost of the abstraction as
  currently emitted, and it must *also* be reduced — see §6.
* **Plugin dispatch is +5.28µs** for `cors` + `security`, whose entire bodies
  are one `headers.get("origin")` and one `WeakSet` probe. The cost is
  *dispatching* the work, not doing it.
* **Hook dispatch is +5.55µs** for a single `beforeHandle` function.
* AOT recovers ~2–4µs of the two above.

So **~10.8µs — over half the gap — is plugin/hook dispatch**, and the remaining
~2.9µs is the core.

> **Measurement resolution warning.** `bench:compare:cpu`'s *ratio* carries
> ±2–3% run-to-run noise, so it cannot resolve a change below ~1µs. Use an
> interleaved head-to-head A/B for small changes (see
> `docs/perf-methodology.md` → "Resolution limit"). Cross-run deltas on this
> machine are not trustworthy — one such delta read 2.35µs where the
> head-to-head measured 0.79µs.

> **Measurement resolution warning.** `bench:compare:cpu`'s *ratio* carries
> ±2–3% run-to-run noise, so it cannot resolve a change below ~1µs. Use an
> interleaved head-to-head A/B for small changes (see
> `docs/perf-methodology.md` → "Resolution limit"). Cross-run deltas on this
> machine are not trustworthy — one such delta read 2.35µs where the
> head-to-head measured 0.79µs.

### Dead ends already ruled out (do not re-attempt)

| Hypothesis | Result |
| --- | --- |
| Reply path (`JSON.stringify`+`encode` vs `Response.json`) | Already **wins**: manual encode is 1.30M ops/s vs `Response.json` 844k. Profile: Bun's `Response.json` is 36.9% of *Bun's* CPU. |
| Response header-construction shape / post-hoc `Headers.set` | Fixed (now **0** `Headers.set` per request, proven with a prototype counter). **No measurable change** — Bun materializes the same header count internally either way. |
| HSTS / `isHttpsRequest` per response | **Free.** `hsts:false` measured 34.33µs vs 34.45µs. |
| Async stage runners / microtask hops | Measured **noise** (~0.1µs); reverted to keep complexity down. |
| `applySet` / `serializeCookie` allocations | Fixed and verified. **No measurable change.** |
| Rust/castrum for this path | **Not applicable.** Bun exposes no raw/zero-copy response path; the cost is JS object churn + Bun-internal `Response`/`Headers` materialization. castrum's own rule: *native wins only where no JS values are materialized.* |
| Micro-optimisation generally | Each lands ~0.2µs against a 9.2µs gap. The profile shows **~406 functions executed per request vs Bun's ~50** — the cost is the count, not any single hotspot. |

**Conclusion:** this is not a tuning problem. It is a *codegen* problem.

## 3. Why the current codegen cannot specialise

`packages/compiler/src/phases/codegen/routes/generate.ts` computes:

```ts
const needsFull =
  !cfg.specializeContext ||
  cfg.enableTraceHeaders || cfg.enableAccessLog ||
  hasHooks || hasGlobalLifecycle ||
  route.analysis.hasValidation ||
  route.analysis.usage.cookie || route.analysis.usage.set ||
  route.analysis.usage.proxy || route.analysis.usage.forward ||
  route.analysis.usage.cache || route.analysis.usage.loader ||
  route.analysis.usage.sendFile || route.analysis.usage.file ||
  route.analysis.usage.debug;

const compact = !needsFull && !route.analysis.usage.set && !route.analysis.usage.cookie;
```

The machinery to emit a *lean* route already exists — `compact` (no
`__applySet`), `sync` (non-async core fn, no Promise), `specializeContext`,
`__DEFAULT_HEADERS`, per-route context-option constants. It is simply switched
off for any app with plugins or a lifecycle, and for any route that touches
`ctx.set`/`ctx.cookie`.

Guards, plugins and `ctx.set`/`ctx.cookie` are *the normal case*, so real apps
never reach the fast path. **The plan is to make those cases specialize
instead of bailing out.**

## 4. Plan

Each phase is independently shippable and has its own measured acceptance
number. Phases 1–3 are ordered by measured value.

### Phase 0 — Make the gate automatic ✅ DONE

* `bench/compare/cpu.ts` — server **CPU per request at a pinned pace**:
  alternating rounds, medians, writes `bench/results/compare/cpu.json` + `.md`.
  `bun run bench:compare:cpu` (report) · `bun run bench:compare:cpu:gate`
  (exit non-zero when `ignus-aot / bun` exceeds `CPU_GATE_TOLERANCE`, default
  1.0 — verified: exits 1 on the current 1.43x, 0 when the tolerance is
  loosened).
* `bench/compare/cpu-wrap.ts` — runs a participant in-process and reports its
  own `process.cpuUsage()` on SIGTERM (`Bun.spawn` exposes no child CPU
  accounting).
* **Bench bug found and fixed:** the AOT participant was spawned via
  `ignus-aot-server.ts`, which compiles on import — leaving the whole compiler
  + bundler resident in the server's heap. That measured **35.4µs/req vs
  33.2µs/req** for the same compiled entry spawned alone, and made the AOT
  participant look *slower than the interpreted one* (1.52x vs 1.43x). The
  harness now builds once (`BENCH_BUILD_ONLY=1`) and measures
  `dist/__server.js` in a clean process.

### Phase 1 — Inline the static plugin layer (target −5.3µs)

**Phase 1b — the target was a WIRING BUG, not dispatch overhead (−2.0µs).**

Before writing any inliner, the plugin layer was re-measured with a *seven-way*
variant sweep. The trick that made this affordable: gate the plugin list on an
env var read at **spawn** time (`app.config.ts`), so ONE build can be driven as
any variant and every variant is measured in ONE interleaved run. The gate was
reverted afterwards; the technique is worth reusing.

| variant | µs/req | vs bare |
| --- | --- | --- |
| bare (no plugins, no default headers) | 23.18 | — |
| one **no-op** plugin (`onRequest`+`onResponse`) | 23.91 | +0.73 |
| cors only | 23.94 | +0.76 |
| security only | 25.26 | +2.08 |
| `security({ hsts: false })` | 25.20 | +2.02 |
| the 8 security headers via `server.headers`, **no hooks** | 25.03 | +1.85 |
| cors + security (the real bench config) | **25.95** | +2.77 |

Read off this:

* **Generic dispatch is cheap** — a whole no-op plugin pair costs 0.73µs, and
  cors adds ~0.03µs on top. The old "−5.3µs for the plugin layer" was stale.
* HSTS is **not** the cost (25.26 vs 25.20 with it disabled) — consistent with
  the earlier "HSTS is free" note.
* After the fix, `security` (25.26) ≈ `headers-with-no-hooks` (25.03), i.e.
  security's own dispatch is ~0.2µs and the remaining ~1.85µs is the
  **unavoidable work of writing 8 security headers** that raw Bun also writes.

**The bug:** the compiler emitted the per-route context options WITHOUT
`responseDefaults`:

```js
// before
var __ctxOpts__h0 = Object.freeze({ body: BODY_LIMITS, route: "/api/cookies" });
// after
var __ctxOpts__h0 = Object.freeze({ body: BODY_LIMITS, route: "/api/cookies",
                                    responseDefaults: __DEFAULT_HEADERS });
```

(`phases/codegen/routes/generate.ts`). Consequence: `ctx.json()` →
`responseWithBody(..., this._opts.responseDefaults /* undefined */, ...)` →
`withBody` was called with `defaults === undefined`, so the plugin header set
was **not** baked at construction and `markDecoratedResponse` was **never
called**. `security.onResponse`'s fast path therefore returned `false` from
`isDecoratedResponse(response)` and fell through to the expensive fallback —
`mutateHeaders` plus 8 native `Headers.set` calls — on **every** request.

So the headline Phase-1a optimisation ("bake the security headers at
construction, then let the plugin skip them via a WeakSet probe") only ever
worked on the **interpreted** path and on the generated `__withBody` path (used
when a handler returns a plain object). It never worked for `ctx.json()` on the
AOT path — which is what every compiled route in the bench calls. This is also
why AOT barely beat interpreted: the compiled server was paying the same
per-request header work.

**Verified:** paced CPU/req A/B, same build, 4 alternating rounds, sample ranges
tight (25.85–25.98): **27.91 → 25.95µs (−1.96µs)** for the real plugin config.
Committed harness `bench:compare:cpu`: **ignus-aot 32.86 → 30.21µs/req, ratio
1.371 → 1.300 vs bun**. Contract parity byte-identical across 4 servers × 9
shapes; `verify` exit 0. `COMPILER_CACHE_VERSION` bumped 0.9.10 → 0.9.11.

**Phase 1 conclusion — do NOT build the static-plugin inliner.** With the
wiring fixed, the whole plugin layer is 2.77µs, of which ~1.85µs is header
writing that any implementation must pay. The inliner would chase ≲0.9µs of
dispatch across a 1–2 day compiler project — and per the ceiling analysis in §6
it still would not reach 1.0x. Re-target the effort at the framework core
(§6, and Phase 3).

**Landed (Phase 1a) — reply path, verified:** three changes to how a
framework-built response gets its headers and body, all in
`core/http/finalize.ts` (+ `http/headers.ts`, `lifecycle/plugin.ts`, and the
mirrored compiler helpers in `phases/codegen/helpers.ts` / `header.ts`):

1. **Incremental `Headers.set` instead of a bulk plain-object header init.**
   Bun's bulk path is *more* expensive per header than `set()` — counter-
   intuitive, and worth knowing generally: `new Headers(<14-key object>)`
   1268 ns (84.2 ns/header) vs `new Headers()` + 14× `set()` 877 ns
   (56.3 ns/header) on Bun 1.4.2.
2. **`applyStaticHeaders` for `__DEFAULT_HEADERS`** — the frozen boot-time
   default set is applied without the `Object.hasOwn` guard and
   `sanitizeHeaderValue` that request-derived values need. Those two steps cost
   ~18 ns/header, i.e. ~243 ns on a 14-header response. Sanitizing now happens
   **once at boot** (`collectResponseDefaults`, and the emitted
   `__DEFAULT_HEADERS`), so the response-splitting guarantee is preserved at
   zero per-request cost.
3. **Hand Bun the string body instead of pre-encoding it.** Every caller passed
   `encoder.encode(...)` to `withBody`; `new Response(string)` is cheaper
   because Bun encodes internally. `content-length` still comes from an exact
   UTF-8 byte count, now via `textByteLength` (`Buffer.byteLength` — no array
   materialization). Verified for non-ASCII bodies.

**Measured (head-to-head, interleaved, single process, 7 alternating rounds,
400k iterations, body read included, byte-identical output):**

```
OLD  encode + sanitize defaults    2571.0 ns
NEW  string body + static defaults 2260.3 ns
saved                    310.7 ns/req   (−12.1% on the reply path)
per-round deltas: 296, 286, 362, 301, 307, 317, 422 ns  (no overlap)
```

`310.7 ns` is **~0.95%** of the ~32.8µs per-request budget. Real, but small —
and it is *below the resolution of the server-level A/B harness*: in the same
period the `bun` participant's own CPU/req moved 22.68 → 23.97µs with
**unchanged code** (±5.7% machine drift). Do not claim server-level wins
smaller than ~1µs; use an isolated A/B.

**Corrected — `{ __proto__: null }` was a false win (reverted).** An earlier
revision of this section claimed the `ctx.set.headers` accumulator change
(`Object.create(null)` → `{ __proto__: null }`) bought −0.79µs. That came from
the cross-run server harness and does **not** reproduce. At 2M iterations:

```
Object.create(null) + 4 writes   17.77 ns
{ __proto__: null } + 4 writes   33.50 ns      <- 2x SLOWER
{} + 4 writes                    15.73 ns
```

`emptyHeaders()` is back to `Object.create(null)` and carries a note recording
the measurement. **Lesson: a 0.79µs effect read off consecutive server runs was
noise. Everything below ~1µs must be measured in-process.**

**Also ruled out (measured, do not re-attempt):**

* Freezing the defaults record is irrelevant — `for..in` over a frozen
  dictionary-mode object (70.3 ns/header) is identical to a plain literal
  (70.8 ns/header).
* Unrolling the header application into literal `set()` calls in codegen buys
  nothing (72.3 vs 70.8 ns/header) — inlining cannot beat the `for..in` loop.
* Iterating a frozen flat `[k, v][]` pairs array is *worse* than `for..in`
  (85.6 vs 70.8 ns/header).
* Applying the `{ __proto__: null }` idiom to the cookie jar's
  `target`/`views` maps measured within noise and was reverted — the jar is only
  touched on ~50% of requests and the Proxy traps dominate.

**Blocker found for the rest of Phase 1** (this is the non-obvious part):
`security()` cannot decide it is static at construction, because in the
generated server `__appPlugins` (and therefore the `security(...)` call in the
app config) is evaluated **before** `setServeBootInfo(...)` runs — so
`getServeBootInfo()` is still `null` when the plugin object is built. The
staticness decision has to move to `pluginsToLifeCycle` time (or later), and
HSTS must resolve from the boot protocol + `trustProxy` rather than per
request. Anything that drops the plugin must also keep its behaviour for
responses the framework did NOT build (raw `Response` passthroughs such as
`/api/echo`) — that path is covered by `bench:compare:verify`.

* **`security()`**: it already declares `responseDefaults`. Hoist them into
  `__DEFAULT_HEADERS` (done) **and remove the plugin from `__appPlugins`'s
  lifecycle contribution**, so it costs zero dispatch. Apply the static header
  set to non-framework-built responses (`ctx.json` bypasses) inside
  `__applySet` via the existing `isDecoratedResponse` check. HSTS becomes a
  boot-time constant (`__hstsValue`, from the resolved protocol) applied only
  when non-`null`.
* **`cors()`**: emit its logic inline per route
  (`const __o = req.headers.get("origin"); if (__o !== null) __applyCors(res, __o);`)
  instead of registering an `onRequest`/`onResponse` pair.
* Source: new `packages/compiler/src/phases/analysis/static-plugins.ts`
  (recognise statically-analyzable plugin factories), plus
  `phases/codegen/header.ts` (filter `__appPlugins`) and
  `phases/codegen/routes/handler.ts` (inline emission).
* Consequence: `__lc.request` / `__lc.afterHandle` become empty → the existing
  `__hasAfterHandle` / `__hasPreParse` constants fold the stages to dead code.
* **Fallback required:** any plugin that is not provably static (a `pattern`
  scope, a closure over runtime state, an async `onResponse`) keeps the current
  `runHooks` path. Correctness first.

**Accept:** contract parity unchanged (4 servers × all scenarios); CPU/req
improves by ≥4µs.

### Phase 2 — Inline statically-known lifecycle hooks (target −5.5µs)

* Today `hasGlobalLifecycle` forces `needsFull` **and** routes every hook
  through `runHooks` → `flattenHooks` (WeakMap) → optional call → result
  interpretation → `{ ctx }` wrapper allocation.
* When a stage array is *statically known* (a literal array of function
  references from the app config), emit **direct calls** in the route body:

  ```js
  const __g0 = guard(ctx);
  if (__g0 instanceof Response) return __g0;
  if (__g0 && typeof __g0 === "object" && __g0.ctx) ctx = __g0.ctx;
  ```

* Keep `runHooks` for dynamic arrays, async hooks, and patterned plugins.
* Source: `phases/codegen/routes/handler.ts` (`guardHookEmissions` already
  emits module constants — extend it to emit *calls*), and the `hasHooks`
  computation in `generate.ts` so an all-sync, statically-known chain no longer
  implies `needsFull`.

**Accept:** CPU/req improves by ≥4µs; ordering/async semantics unchanged
(covered by `packages/core/test/lifecycle.test.ts`).

### Phase 3 — Lean context tier (target −1.5 to −2.9µs) — *essential, not optional*

The §2 numbers mean the plan only *reaches* Bun if the core also drops.

* `usage.set` and `usage.cookie` are *mechanism* flags, not capability needs:
  the guard needs a header accumulator, the handler needs a cookie view. Both
  currently force the full `IgnexContextImpl` (~0.6µs) plus `set` +
  `set.headers` + `set.cookie` + body/cookie plumbing (~1.5µs of the long tail).
* Add a **light context** tier: one object literal with only the members a
  route's `ContextUsage` bitmap references, built by
  `createLightContext(req, routeOpts, usage)`. Everything else (lazy body,
  cookie proxy, `state` map, `cache`, `loader`, `debug`, `params`, `query`) is
  omitted from the shape entirely rather than lazily allocated.
* Stop `usage.set` / `usage.cookie` from forcing `needsFull`.
* Public-API note: `ctx` must keep its `IgnexContext` surface. The light tier is
  only emitted when the usage bitmap proves the route cannot reach the omitted
  members, so this is a codegen-internal split, not an API change.

**Accept:** `bare` ignex CPU/req drops below 22µs.

### Phase 4 — Unblock `compact` + `sync` (mostly free)

Phases 1–3 remove the `hasHooks` / `hasGlobalLifecycle` / `usage.set` /
`usage.cookie` reasons for `needsFull`. The existing `compact` (no
`__applySet`) and `sync` (non-async core fn, zero Promise) paths then activate
by themselves. Verify they actually do — assert the emitted core fn is
non-`async` for the bench app.

**Accept:** emitted `GET__hN` for `/health` is non-`async`; 0 `await` on the
fast path.

### Phase 5 — Reply + header template (target −0.5µs)

* Per-route preallocated header template when the static header set is known,
  so the reply builds its header record with one `content-length` write.
* Verify `content-type`/`content-length` framing is exact (this is what lets
  compression skip buffering).

**Accept:** no change in response bytes; small CPU/req win.

## 5. Acceptance criteria (definition of done)

1. **Performance:** `ignus-aot` CPU/req ≤ `bun` CPU/req on `03-stress`
   (**target < 20.7µs**), and ≥ `elysia` on every non-error scenario.
2. **Correctness:** contract parity byte-identical across all participants ×
   all scenarios (`scripts/check-compare-bench.ts`, plus a header/body snapshot
   diff like the one used in this investigation).
3. **Gates:** `bun run verify`, `verify:perf`, `test:native`,
   `verify:native:route`, `verify:aot:rbac`, `smoke`, `smoke:fallback` all green.
4. **`IGNEX_NATIVE=off` parity** unchanged.
5. Codegen golden fixtures updated deliberately, with the diff reviewed.

## 6. Honest risk: the +2.90µs core

Even with a *zero-cost* plugin and hook layer, ignex measured **23.62µs** in the
`bare` configuration. That configuration does *less* work than Bun (no rate
limit, no security headers, no request-id header), so it is not the final
comparison — but it shows the core alone is +2.90µs and must come down for the
goal to be reachable.

Where ignex can *win back* against the raw handler (it is already cheaper in
places):

| | Bun handler | ignex |
| --- | --- | --- |
| reply | `Response.json` — 36.9% of Bun's CPU | manual `stringify`+`encode`, ~1.5x faster |
| request id | `crypto.randomUUID()` | counter — much cheaper |
| header record | 13-key object spread per request | static defaults, one build |

Those advantages exist but are thin (~0.5µs). **Phase 3 is therefore not
optional** — it is what turns "close" into "ahead".

## 7. Sequencing and effort

| Phase | Scope | Est. |
| --- | --- | --- |
| 0 | Bench CPU mode + gate ✅ | done |
| 1 | Static plugin inlining | 1–2d |
| 2 | Statically-known hook inlining | 2–3d |
| 3 | Light context tier | 2–3d |
| 4 | Unblock compact/sync (verify) | 0.25d |
| 5 | Reply/header template | 0.5d |
| — | Correctness + gate sweeps | 1–2d |

**≈ 1.5–2 weeks focused.** Phases 1 and 2 alone (≈ 1 week) should recover
~10.8µs of dispatch and land the compiled participant at roughly **1.0–1.1x**
Bun; Phase 3 is what makes it *robustly* ahead.

Recommended order: **0 → 1 → 2 → (re-measure) → 3 → 4 → 5.**

## 8. Follow-ups surfaced by Phase 0

* **`bench:compare` still spawns the compiler for the AOT participant.** The
  heap-inflation measured in Phase 0 applies to the throughput bench too, which
  spawns `ignus-aot-server.ts`. Consider building once and spawning
  `dist/__server.js` (as `cpu.ts` now does). This changes committed result
  artifacts, so do it deliberately with a re-baseline.
* **Bench participants disagree on security headers.** Bun sends
  `X-Frame-Options: SAMEORIGIN` + HSTS (from `shared.ts` `SECURITY_HEADERS`),
  while ignus sends core `security()` defaults (`DENY`, no HSTS on http, a
  different CSP). Pre-existing, but it undercuts the "same amount of work"
  premise the gate rests on.

## 10. CPU trace — where the time actually goes (measured 2026-09-14)

Trace method: profile each participant's server process under identical
sustained keep-alive load (`--cpu-prof-md`, 4 concurrent drivers, 12s), then
normalise self-time shares against the pinned-pace CPU/req numbers.

### Primitive costs (ns/op, live requests, Bun 1.4.2)

```
req.url read                     5.7
new URL(req.url)               111.8
headers.get('origin')           28.4
Object.entries(headers)         25.0
headers.toJSON()               227.4
new Response(2 headers)        388.4
new Response(14 headers)      1886.8     <- ~125 ns per extra header
headers.set() mutate            52.3     (fixed keys)
JSON.stringify(small)           98.2
TextEncoder.encode(small)       25.9
new Headers(14-key object)     949.6
server.requestIP(req)          779.9     <- 3.4% of the whole budget
```

### The profile is NOT safely comparable across participants

Raw Bun's hot path shows **35 distinct functions**; the AOT bundle shows
**371**. Bun's JIT inlines its server path aggressively, so its self-time lands
on a handful of huge frames (`json` 43.2%, `checkRateLimit` 25.0%) while ours
spreads over many small ones. Both participants call the *same*
`rateLimitCheck` from `bench/compare/shared.ts`, yet it reads 25% in Bun's
profile and 0.3% in ours — proof that the difference is **frame attribution,
not work**. Do not read a per-frame delta off these two profiles and call it a
framework cost.

What the trace *does* establish:

* The reply path is the largest framework-attributable block in the AOT server
  (`Response` 14.0%, `set` 5.4%, `withBody` ~12.6%, `applyHeaderRecord` 7.4%,
  `sanitizeHeaderValue` ~1.5%) — which is why Phase 1a targeted it.
* `ctx.url` → `new URL` (5.6%) and query parsing are real but are **shared
  workload** the raw-Bun participant pays too, so they are not the gap.
* Context construction (`IgnexContextImpl` + `Proxy` + `copyDataProperties`) and
  the `ctx.cookie` Proxy appear only on our side — Phase 3's target.
* Identified JS-side primitives account for only **~3.3µs** of the ~10µs gap.
  The remainder is spread across the call graph; there is no single hotspot.

### Bun findings worth reporting upstream

1. **Bulk plain-object header init is slower than incremental `set()`** —
   counterintuitive and reproducible: 84.2 vs 56.3 ns/header (14 headers,
   200k iterations), i.e. `new Headers({...14 keys})` is ~45% slower per
   header than `new Headers()` + 14× `set()`. We now rely on this.
2. **`server.requestIP(req)` costs ~780 ns/call** (~3.4% of the per-request
   budget) — expensive for a peer-address lookup, and it appears in *both*
   participants' profiles.
3. **`new Response(string)` does not set `content-length` automatically**
   (the header is simply absent), so an explicit `content-length` is mandatory
   if downstream middleware is to avoid buffering. `Response.json(...)` does
   set it.
4. **Bun neuters `Request` after the handler returns** — `req.url` reads `""`
   outside the handler, so captured `Request` objects are unusable. (Cost us a
   debugging cycle.)
5. **Bun's own `Response.json(obj, {headers})` is ~120 ns slower than
   `new Response(JSON.stringify(obj), ...)` + incremental headers** for the
   same bytes — the native fast path is not free.

### Measurement rules earned the hard way

* A single server run cannot resolve <1µs. Alternating *runs* is not enough:
  cross-run drift reached **±5.7% with unchanged code** (the `bun` participant
  moved 22.68 → 23.97µs between two runs of identical source).
* For sub-µs effects use an in-process A/B with both variants defined in one
  file, alternating rounds, and medians — not means. Also: **prefer micro-
  benchmarks over server A/B whenever the effect is under ~1µs.**
* Compare whole paths end-to-end (including the body read). A JS-constructed
  `Request` has no `content-length`, so the request-body path silently changes
  from 2.0µs to 12.9µs (chunked) — a fake 4.4x "regression" that only an
  end-to-end probe catches.
* Beware self-referential artefacts: inserting 40,000 distinct header names
  made `Headers.set` look like 76µs when with fixed keys it is ~52ns.
* `--cpu-prof-md` only flushes on a clean process exit — a server with a
  graceful-shutdown handler must be wrapped in a self-exiting script.
* `--heap-prof-md` reports *retained* size, not allocation rate; it is the
  wrong tool for finding per-request allocation churn.

## 11. Framework overhead isolated (measured 2026-09-14)

Every measurement in §10 mixed framework cost with workload cost. This one does
not: it drives **only `/health`** on both participants at a pinned 15k rps. Both
handlers do the same trivial work (rate-limit check + 4 headers + a small JSON
envelope), so the delta is the framework's own per-request cost — router
dispatch, context creation, reply finalization, `applySet`.

```
bun         median 13.00us  [13.18, 12.82, 13.00, 12.71]
ignus-aot   median 16.82us  [16.82, 16.76, 17.26, 16.67]
=> framework overhead = 3.82us/req for a trivial handler
```

That is the clean, workload-free target: **3.82µs**. On the full `/api/users`
workload the gap is ~7µs, so ~3.2µs of it is workload-dependent (query parse,
the `ctx.cookie` Proxy, etc. — where we are slower than Bun for the same
logical work), and 3.82µs is framework machinery.

Harness: `/tmp/healthcmp.ts` (paced, self-reporting `process.cpuUsage`, 4
alternating rounds, medians, tight ranges).

### Hypotheses tested and REFUTED this round (do not re-attempt)

* **`__extractParams` / `__isServerLike` are not the cost.** The /health profile
  put `__extractParams` at **17.9% self** (≈5.7µs/req), which looked like a huge
  win — it does `"params" in req` plus up to 3 `in` lookups on the Bun server
  object per request. Measured on a **real served Request and server object**,
  from inside the handler:
  ```
  "params" in req                     2.3 ns
  req.params                          5.9 ns
  "params" in req && req.params       6.7 ns
  "requestIP" in srv                  7.6 ns
  __isServerLike  [in-based]          3.2 ns
  ```
  i.e. ~15-20 ns total, not microseconds. The `in` operator is cheap even on
  host objects.

* **Merging `__DEFAULT_HEADERS` into the `Response` construction record is
  SLOWER, not faster.** The theory was that mutating `response.headers` after
  construction costs more at send time than passing headers to the constructor
  (which is what Bun's own `Response.json(body, { headers })` does) — and the
  profile's `applyStaticHeaders` 17.2% total seemed to support it. Two-build
  A/B on the workload-free harness:
  ```
  A  incremental set() after ctor   16.60us  [15.68, 16.60, 17.32, 16.56]
  B  merged into ctor record        17.06us  [16.96, 16.44, 17.06, 17.08]
  ```
  Overlapping ranges — at best a wash, so Phase 1a's incremental `set()` stands.
  The per-request ~10-key spread cancels the saved `set` calls. **This is the
  first time that Phase 1a choice was validated at server level** rather than
  in-process.

### The profiler is not usable for per-frame attribution on the generated bundle

Three profiles of near-identical code gave `set` [native] **5.4%, then 15.2%,
then 23.7%**; `__extractParams` showed 17.9% self for a function whose entire
body measures ~15ns; and the /health profile's top frame was `reallyExit` at
27.4% (process-exit machinery). Bun's markdown profiler attributes inlined
callee time to whichever frame it pleases, and the generated bundle is one
24k-line file.

**Use the profiler to find *candidate* frames, never to size them.** Confirm any
candidate with a primitive micro-benchmark (on a *real* served Request, not a
JS-constructed one) or a served-server variant A/B. Two of this round's three
"hotspots" evaporated under that rule.

### Where the 3.82µs is

After removing the refuted items, the remaining clearly-ours-and-differential
frames in the /health profile are small: `IgnexContextImpl` 3.2% (≈0.54µs),
`requestIP` 1.1% (≈0.19µs), `sanitizeHeaderValue` 0.7% (≈0.12µs),
`generateRequestId` 0.6% (≈0.10µs). The largest single frame, `Response` at
11.0% (≈1.85µs), is *native construction* and is shared with Bun's own handler.

So the 3.82µs is **not concentrated in anything addressable by micro-optimisation
— it is spread across the call graph**. This matches §6's conclusion and means
the remaining gap needs Phase 3's structural change (a lean context tier, fewer
per-request objects), not more tuning. Further ablation requires codegen-level
gating of individual framework steps; the app-config env-gate trick used for the
plugin sweep does not reach framework internals.

## 12. Generated-code size: −79% from one hint (measured 2026-09-14)

The compiled bench server (`bench/compare/servers/ignus-aot-app`) was **906 KB /
24,747 lines / 1,063 top-level functions for 7 routes**. A size breakdown by
module showed why — the runtime bundle carried:

| what | ~lines | used by this app? |
| --- | --- | --- |
| Ajv + `ajv-formats` + `fast-uri` | ~2,500 | no |
| `pino` + `sonic-boom` + `thread-stream` + `@pinojs/redact` + `safe-stable-stringify` | ~2,600 | no |
| `@ignex/native` bridge (`ffi`, `crypto`, `template`, `json`, `loader`, `payload`) | ~1,680 | partly |
| `lru-cache` | 643 | no |

**Root cause:** none of `packages/{core,native,shared}/package.json` declared
`sideEffects`. Without that hint a bundler must assume every module may have
import-time side effects, so it cannot drop a module that is merely *reachable*
— it keeps the module's imports even when none of its exports are used. Proven
by the giveaway: the Ajv *code* was absent while the Ajv *modules* were present,
i.e. `data/schema.ts` was retained purely for its imports.

(`data/schema.ts` also instantiated Ajv at module scope — made lazy as well,
correct on its own merits, but it turned out not to be the cause.)

**Fix:** `"sideEffects": false` in `packages/core`, `packages/native` and
`packages/shared`.

| | before | after | |
| --- | --- | --- | --- |
| `__server.js` | 927,154 B | **196,401 B** | **−78.8%** |
| lines | 24,738 | **5,611** | **−77.3%** |
| boot (spawn → first 200) | 51 ms | **23 ms** | **−55%** |
| bundled node_modules | Ajv ×63, pino ×13, thread-stream ×5, fast-uri ×3, sonic-boom, lru-cache | `lru-cache` only | |
| `packages/native/src` modules | 36 | 17 | |

Boot is the median of 7 spawn-to-first-200 runs (51,50,51,51,52,52,70 → 51ms;
23,23,23,23,23,24,26 → 23ms).

**Per-request cost is UNCHANGED.** Workload-free framework overhead measured
3.90µs after vs 3.82µs before (within noise), and `bench:compare:cpu` showed no
change. These modules were never executing per request, so this is a **size and
boot-time win only** — do not expect it to move the throughput benchmark.

**Verified:** `verify` exit 0 (1958 tests) · contract byte-identical across 4
servers × 9 shapes · `smoke` 52/52 · `smoke:fallback` 52/52 ·
`verify:native:route` (per-route native stack parity) · `verify:aot:rbac` ·
`check:native:surface` (70/70 stub symbols).

**Remaining opportunity:** `lru-cache` (643 lines) is still reachable from the
entry, and 17 `packages/native` modules remain. Both are imported by core
modules that the bench app does reach, so dropping them needs the dependency to
disappear (codegen subpath imports, or a leaner default `@ignex/core` surface)
rather than another hint.

### Why this matters beyond size

The complaint that started this — "if we execute 400 functions to perform a
simple task, we are no different from express" — is a fair reading of a 906 KB /
1,063-function server for 7 routes. The size is now defensible. The *executed*
call graph is a separate problem: a trivial `GET /health` still touches ~150
sampled frames vs raw Bun's ~35, and the 3.82µs framework overhead is flat
across the call graph. That is Phase 3's target, and §11's finding stands — it
will not yield to further micro-optimisation.

## 13. Ablation attempts (2026-09-14) — one false lead caught, one open

**Method (worth keeping):** put the ablations in the *route source*, not in
codegen — the handler reads `process.env.ABL` at runtime, so ONE build yields
every variant and they can all be measured in one interleaved paced run. Far
cheaper than codegen-level gating, and it can only ablate steps *reachable from
the handler*, which is the right scope for framework overhead.

```
variant                 median   vs base
bun (raw)               12.49us        -
base (ignus-aot)        16.36us   +3.87us   framework overhead
  ABL=noip  (skip ctx.ip)        15.71 / 14.15us   saves 1.56 / 2.21us
  ABL=noset (skip ctx.set writes) 15.96 / 14.79us  saves 1.32 / 1.58us
  ABL=nojson (plain object)       18.10 / 16.42us  saves -0.82 / -0.06us
```
(two runs; the spread between them is the point — see below)

### FALSE LEAD CAUGHT — `ctx.ip` is not slow

The ablation said skipping `ctx.ip` saved 2.21µs while skipping `requestIP` in
the raw-Bun participant saved only 0.58µs — a 4x difference for the same
underlying native call, which looked like a real bug. Measured properly on a
**real served Request, from inside the handler**:

```
server.requestIP(req) bare                     779.0 ns
server.requestIP(req)?.address                 760.2 ns
getClientIp(req, srv)      [bun participant]   879.9 ns
createContext + ctx.ip     [ignus]             984.0 ns
createContext only                              78.2 ns
ctx.ip on a reused context (memoized)           10.5 ns
```

**Our `ctx.ip` (984ns) ≈ bun's `getClientIp` (880ns). There is no bug.** The
ablation's per-round spread was ±1µs, and both runs disagreed with each other by
0.65µs — the harness cannot resolve a 1.5µs effect cleanly at 12k rps.

Also worth recording: **`server.requestIP()` costs ~780ns**, which is genuinely
expensive for a peer-address lookup, and *both* participants pay it because the
shared `rateLimitCheck` is keyed on it. It is part of the shared workload, not
framework overhead.

### The one consistent signal, and why it is mostly non-differential

`noset` saved 1.32µs and 1.58µs in the two runs — the only result that
reproduced. But #12's variant-B test *already* showed that changing HOW headers
are applied (incremental `set()` vs merged into the constructor record) is a
wash (16.60 vs 17.06µs). Combining the two:

**Response cost scales with the NUMBER of headers on the response
(~230–400ns/header at server level), not with how they are added** — it is
Bun's per-header serialization work. Incremental `set()` is not the problem, so
"write headers like Bun does" is not a lever.

And since the raw-Bun participant writes the same header set, that cost is
**largely non-differential** — which is why removing 4 of our headers makes *us*
faster but does not explain the gap to *bun*.

### Open problem: resolution

Every effect worth chasing here is ~1–2µs, and this harness's medians vary by
±0.6–1µs between runs at 12k rps with 4 rounds. **Before any further cost work,
raise the harness's resolution** (more rounds, higher paced rate, or
interleaving variants within a run rather than sequentially). Otherwise the next
round will keep producing 1.5µs "findings" that do not survive re-measurement,
as `ctx.ip` did.

The framework overhead remains ~3.9µs and, per §11, is flat across the call
graph. Nothing in this round changed that; the structural work (lean context
tier, fewer per-request objects) is still the only identified lever.

## 14. What actually executes per request (measured 2026-09-14)

The question that motivates all of this — "if we execute 400 functions to
perform a simple task, we are no different from express" — answered directly.
Profiled `GET /health` under a 25s keep-alive load on the **current** build, then
converted the profiler's self-time shares to µs using the paced-CPU budget for
that route (17.3µs/req, `/tmp/abi.ts`, 9 rounds, MAD 0.14).

```
functions executing per request:   101   (was 225 before §12)
  of which [native code]:           35    -> 56.6% of the time
  of which our JS:                  66    -> 43.4%

 self%  us/req  function                     where
  30.6    5.29  set                          [native]
  22.6    3.91  async GET__h6                generated route wrapper
  17.5    3.03  Response                     [native]
   7.9    1.46  withBody (4 call sites)      reply plumbing
   4.7    0.80  IgnexContextImpl             context constructor
   2.4    0.42  stringify                    [native]
   1.5    0.26  requestIP                    [native]
   1.2    0.21  sanitizeHeaderValue          request-derived header values
   0.6    0.10  isHttpsRequest               security plugin
   0.4    0.07  applyStaticHeaders / byteLength / generateRequestId
  ~1.0   ~0.2   runHooks, finalize, router, emptyHeaders, okEnvelope, cookies
```

**Read this carefully — the two biggest lines are not ours.** `set` and
`Response` together are 48% of the route, and §13's variant-C experiment proved
the cost is intrinsic to Bun materializing ~13 headers on a `Response` no matter
*how* they are supplied (post-construction `Headers.set` and a single
constructor record measured identical). The raw-Bun participant writes the same
header set, so it pays the same 8.3µs — which is why the *gap* is not there.

**The differential, framework-owned cost is roughly 2.6µs:**
* `IgnexContextImpl` 0.80µs — the context instance plus its `set` object,
  `set.headers` dict and eager `set.cookie` dict (4 allocations/request).
* `withBody` ~1.46µs — reply plumbing (base record, defaults application,
  `content-length`).
* `sanitizeHeaderValue` 0.21 + request-id + `isHttpsRequest` ~0.4µs.
* `async GET__h6`'s 3.91µs of *self* time is mostly inlined callee time
  (`createContext`, `__finalize`, `jsonReply` never appear as their own frames),
  so it cannot be attributed further from this profile.

### The profiling method has a trap

The first attempt at this list reported **225** functions and included `Ajv`,
`addMetaSchema`, `getSchemaRefs`, `findAddonPath` and `requireAddon` — which read
as "we run a JSON-schema validator per request". They were **module-init (boot)**
samples: the profiler records from process start, so anything done at import time
is mixed into the per-request table. Run a long enough load that boot is
negligible before reading the function list, and treat a small-sample frame in a
short profile as suspect.

Note the second-order win: §12's `sideEffects` change did not reduce per-request
cost, but it removed ~125 functions from this list and 55% of boot time — the
executed *code* is materially smaller even though the executed *work* is not.

### Implication for Phase 3

The remaining differential ~2.6µs is: one context object graph (0.8µs) + reply
plumbing (1.5µs) + header sanitizing/id (0.4µs). No single item is large.
Removing it means a simple route must stop creating a context and stop running
the generic reply path — i.e. the AOT compiler emitting straight-line code for
statically-analysable routes, which is the original Phase 1+2+3 thesis rather
than a tuning change. Budget it as a project.

## 15. Phase 3 scope — and the target has inverted

### The measurement that reframes the work

Profiling **both** participants on the same trivial `GET /health` (25s load each,
so boot is negligible) gives a frame-by-frame comparison for the first time:

```
raw Bun:  20 functions,  87.8% of ALL its CPU is ONE native frame: `json`
          (Response.json + stringify + Response + header materialization)
          remainder: getClientIp 5.2 · requestIP 2.0 · checkRateLimit 1.6 ·
                     randomUUID 1.2 · copyDataProperties 0.8 · cloneObject 0.4

ignex:   101 functions, reply work spread over four frames:
          set [native] 30.6 · Response [native] 17.5 · withBody 7.9 ·
          stringify 2.4                                   = 58.4%
          plus async GET__h6 22.6 (generated wrapper) · IgnexContextImpl 4.7 ·
          sanitizeHeaderValue 1.2 · requestIP 1.5 · isHttpsRequest 0.6 …
```

Normalised to µs against each participant's own paced budget (bun 13.5,
ignus-aot 17.3):

| | bun | ignex-aot |
| --- | --- | --- |
| reply (materialize the response) | **~11.8** | **~10.2** ← we are 1.6µs *faster* |
| everything else | **~1.7** | **~7.1** ← the entire gap lives here |
| total | 13.5 | 17.3 |

**The reply path is a win and is no longer the target.** Phase 1a's work
(string body, baked static headers, `applyStaticHeaders`) is why. Do not
re-open it — §13 tested the remaining reply variations and they were washes.

**The target is the ~7.1µs of non-reply time**, of which `async GET__h6` at
3.91µs *self* is the dominant, still-unattributed piece.

### Why GET__h6 cannot be attributed from the profile

`createContext`, `__finalize` and `jsonReply` never appear as their own frames —
they are inlined into the generated wrapper — and the route body's own work is
attributed there too. So the profile says "3.91µs" without saying what it is,
and §13 established that guessing at this size of effect is how false leads are
born (`ctx.ip`). It must be ablated, not inferred.

### Step 1 — make codegen ablatable (do this first)

Emit the generated wrapper under a build-time flag so individual steps can be
removed and measured server-side with `/tmp/abi.ts` (0.28–0.98µs resolution,
identical-server control reported every run):

```
IGNEX_ABLATE = ctx | preparse | beforehandle | afterhandle | finalize | applyset | try
```

Gate on `process.env` read ONCE at module load in the generated server (so the
branches fold away and an unflagged build is byte-identical — verify with the
contract harness). This is the codegen-level ablation §11 said was missing; the
route-source trick used in §13 cannot reach framework internals.

Candidate steps to ablate, in order of expected size: `createContext` +
`ctx.server =` assignment; the four `__has*` flag branches; `runHooks`
pre-parse; `runHooks` afterHandle; `__finalize`; `__applySet`; the `try/catch`;
the `async`/`instanceof Promise ? await : r` wrapper (§13 measured that last one
at ~117ns, so do not expect much from it).

### Step 1 — make codegen ablatable ✅ DONE, and it found the one real step

Implemented (temporary instrumentation, cheap to keep because it costs the
production build nothing):

* `header.ts` emits `__ABL_FINALIZE` / `__ABL_HOOKS` / `__ABL_APPLYSET`. With
  `IGNEX_ABLATE_BUILD=1` at build time they are derived from the runtime env
  `IGNEX_ABLATE=<finalize|hooks|applyset,…>`; otherwise they are literal `false`
  and the bundler **removes them entirely** (the default build contains no
  `__ABL*` identifiers at all — verified).
* `handler.ts` gates the three wrapper steps in `assembleCoreFn`:
  `__ABL_FINALIZE && result instanceof Response`, `__hasAfterHandle && !__ABL_HOOKS`,
  and `__ABL_APPLYSET ? response : __applySet(...)`.

Measured with `/tmp/abi.ts` (6 rounds, 12k rps, identical-server control):

```
variant      median   MAD     vs base
base          16.19   0.28        -
-hooks        15.08   0.56   saves 1.12us   <-- 2.7x the control
-all          15.21   0.84   saves 0.98us
-finalize     16.47   0.84   saves -0.28us  (noise)
-applyset     16.75   0.70   saves -0.56us  (noise)
ctrl          16.61   0.84        -
              control (base - ctrl) = -0.42us  => resolution ~0.42us
```

**`runHooks(afterHandle)` costs ~1.1µs — the single largest attributable
framework step.** It dispatches the composed cors+security `onResponse` chain
via `runOnResponseChain`, which for this app ends in a WeakSet probe
(`security`) and one early-returning header read (`cors`). `__finalize` and
`__applySet` are free: finalize is an `instanceof Response` passthrough, and
applySet early-returns because `consumeSetHeaders` already blanked the
accumulator.

This also corrects §13's in-process claim that the plugin layer was ~100ns.
Server-side it is ~1.1µs for dispatch alone. **Trust the served-server A/B for
anything involving the generated call graph**; in-process isolation does not
reproduce it.

**Consequence for Phase 1:** the original P1 (inline the static plugin layer)
was de-scoped in §1 because it was chasing a stale 5.3µs figure. It is now
justified at a measured **~1.1µs** for the dispatch, with ~1.85µs more in header
writing that is non-differential. That is the best-evidenced remaining slice,
and it is much smaller in scope than the original proposal: the chain, not the
plugins.

### Step 1b — two chain optimisations measured EXACTLY ZERO (both reverted)

Following Step 1's finding that `runHooks(afterHandle)` costs ~1.1–1.4µs, two
structural fixes were implemented, measured, and **reverted** because neither
moved the number. Both are recorded so they are not retried.

**(a) Leaner chain.** Pre-extract each plugin's `onResponse` at boot (the list is
already filtered on `typeof onResponse === "function"`, so the per-request
optional call `plugin.onResponse?.(…)` was a property load plus a branch that
could never be taken); test `instanceof Response` *before* `isThenable` (a
Response is never thenable, so this ordering is equivalent and skips the call on
the all-sync path); and return `current` rather than `{ response: current }`
(`runHooks` interprets a bare Response identically, saving one allocation).

```
old 17.03 (MAD 0.28) · new 17.03 (MAD 0.14) · ctrl 17.03   → new - old = -0.01us
```

**(b) Bypass `runHooks` entirely.** Tag `pluginsToLifeCycle`'s `afterHandle`
container as the composed chain, hoist `__afterIsChain` / `__afterChain` as
boot-time constants in codegen, and call the chain *directly* from the generated
route — removing the stage flattening (WeakMap lookup), the hook loop, the
`interpretHook` pass and the `{ctx}` wrapper from the hot handler.

```
old 17.73 · new 17.31 · ctrl 17.31  (ctrl is the SAME file as old)
→ new - old = -0.42us, but the identical-server control = +0.42us
```

**Both results are at or inside the control.** Recorded conclusion:

> **CORRECTED — the earlier conclusion here was WRONG.** It claimed the ~1.4µs
> was "a JIT/inlining consequence of the indirection's presence, which a
> JS-level rewrite cannot remove". Direct measurement (below) shows the
> indirection costs **0.28µs** and the ~1.4µs is the **plugin bodies**. (a) and
> (b) measured exactly zero because **they optimised the wrong layer** — both
> restructured the dispatch, which was never the cost.

**The measuring experiment that settles it.** Gating the bench app's plugin list
on an env var read at spawn time gives variants whose *only* difference is
controlled, all measured in one interleaved run:

```
none     13.68  (no plugins at all; __hasAfterHandle folds to false)
noop     13.96  (one plugin whose onResponse is a passthrough, NO responseDefaults)
full     17.31  (cors + security — the real config)
ctrl     13.82  (identical to none)
        control = -0.14us

STRUCTURE  noop  - none = 0.28us   <- having the hook path at all, trivial body,
                                      IDENTICAL header count
BODIES     full  - noop = 3.35us   <- the real plugin bodies + the 8 security headers
```

`noop` carries no `responseDefaults`, so it writes exactly the same headers as
`none` — which makes `noop − none` a clean read of the dispatch path: the stage
loop, the chain, the result interpretation and a trivial body cost **0.28µs**.

### The full split (5 variants + control, one interleaved run)

Adding `headers` (no plugins, but the same 8 security headers via
`server.headers`) and `sec` (security only) splits the remainder:

```
none     13.82     no plugins                      (control = identical, 0.00us)
noop     14.52     passthrough plugin, no headers
headers  15.91     no plugins, 8 security headers
sec      16.61     security only
full     17.17     cors + security

STRUCTURE            noop    - none    = 0.70us   (dispatch + trivial body)
8 security HEADERS   headers - none    = 2.09us
security BODY        sec     - headers = 0.70us
cors BODY            full    - sec     = 0.56us
```

(Run-to-run variance is ~0.4–0.5µs — the same comparison put STRUCTURE at 0.28µs
in the previous run — so read STRUCTURE as 0.3–0.7µs. The 2.09µs for the headers
reproduced across all three decompositions: 1.85µs, 2.09µs.)

**The largest item is the 8 security headers at ~2.1µs — and it is
NON-DIFFERENTIAL.** The raw-Bun participant writes the same header set through
`shared.ts` `buildHeaders`, so it pays the same. That is why closing the gap
cannot come from the plugin layer: the plugin-owned, avoidable total is
STRUCTURE + security body + cors body ≈ **1.6–2.0µs**, and ~0.7µs of that is
dispatch that P1 proposed to inline.

**Note the ~10–20x gap between isolated and served cost.** `security()`'s body
costs 0.70µs to do a `WeakSet.has` probe and a `req.url.startsWith("https:")`
(~30ns of work by primitive measurement); `cors()`'s costs 0.56µs for one
`ctx.headers.get("origin")` (~28ns isolated). This is the same pattern as
`Headers.set` (441ns served vs 56ns isolated). Whatever this multiplier is, it
applies to every call in the request path and it is not explained by anything
measured so far — it deserves its own investigation, and it dwarfs any single
plugin-body optimisation.

**Consequence:** the original P1 premise ("inline the plugin dispatch and the
cost goes away") is confirmed dead — the dispatch is 0.28µs. If the remaining
~1.5µs of body cost is to be recovered, it must come from making the plugin
*bodies* cheaper (e.g. `security()`'s per-request HSTS/`isHttpsRequest` check and
WeakSet probe, or `cors()`'s `ctx.headers.get("origin")`), not from inlining
control flow.

### Harness variance must be reported per run

The identical-server control in the *same harness, same build* measured
**−0.26µs** (6-variant run), **−0.42µs** (Step 1, 10 rounds), **+0.01µs** (3-variant
run) and **+0.42µs** (2nd 3-variant run). So the honest resolution is **~0.4–0.5µs
per run, not the 0.14µs MAD suggests**. Always read the control; treat anything
under it as zero; and prefer measuring the same comparison twice before drawing a
conclusion — the 1.4µs hook cost survived that test (1.12 then 1.40, both ≫
control), the two chain rewrites did not.

### Step 2 — specialise, in this order

1. **Skip the machinery the route provably cannot use.** The `__has*` constants
   are already boot-folded, but `__applySet` and `__finalize` still run
   unconditionally. A route whose usage bitmap has no `set`/`cookie`/`status`
   should not emit `__applySet` at all.
2. **Cheapen the context.** `IgnexContextImpl` is 4 allocations/request
   (instance + `set` + `set.headers` + eager `set.cookie`). The eager
   `set.cookie` dict is only needed by routes that write `ctx.set.cookie.name`;
   deferring it needs a non-allocating read path in `applySet` too. Worth ~0.1µs
   — do it only if Step 1 says the context is a real share.
3. **Only then** consider inlining plugins/hooks (original P1/P2). §13 measured
   the whole plugin layer at ~2.77µs of which ~1.85µs is header writing that is
   non-differential, so the inlinable share is ≲0.9µs.

### Acceptance criteria

* Contract harness byte-identical (4 servers × 9 shapes) after every step.
* `verify` exit 0; `smoke` + `smoke:fallback` 52/52.
* Each step justified by an ablated measurement with the control reported, not
  by profile attribution. A step that measures inside the control's noise is
  reverted, not kept "because it should help".
* Report the per-request function count from §14 alongside µs — it is the metric
  that tracks the "no different from express" concern directly.

### Realistic expectation

The differential budget is ~7.1µs, itemised as ~3.9µs (wrapper, unattributed) +
~0.8µs (context) + ~1.5µs (reply plumbing) + ~0.9µs (hooks/dispatch). Nothing is
individually large, so reaching parity means specialising all of it — this is the
1.5–2 week compiler project §7 estimated, not a tuning pass. Step 1 is worth
doing regardless: it is the measurement capability every future perf claim in
this repo needs, and it is small.
* **`scripts/check-compare-gate.ts` pins `"03-stress": 1.35`** on p50 — just
  above the measured loss, so it ratchets the regression in rather than
  catching it. Re-derive from the CPU measurement once Phase 1 lands.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Inlining changes plugin semantics (ordering, `pattern` scoping, async `onResponse`) | Inline only provably-static plugins; everything else keeps `runHooks`. Gate on the existing 1958-test suite + lifecycle tests. |
| `cors`/`security` configs vary per app | Recognise the *shape* (static allowlist, static header set); bail to the generic path otherwise. |
| Light context leaks an omitted member | Emit only when the `ContextUsage` bitmap proves the member is unreachable; `needsFull` remains the conservative default. |
| Codegen golden fixtures churn | Update deliberately, review the diff, keep emission byte-stable (`assertCoreFn`-style tests). |
| Bun version drift changes the baseline | Pin the comparison in CI; re-baseline deliberately. |

## 17. The CPU/req metric is RATE-DEPENDENT — read this before quoting any µs/req

Found while chasing the "why do in-situ operations cost 10–20× their isolated
cost" question. Same build, same harness, same 16 clients — only the paced rate
changed:

```
rate  4000 rps:  23.09 · 24.60 · 24.10 us/req   (three identical variants)
rate 24000 rps:  14.57 · 14.66 · 14.40 us/req   (the same three)
```

**A 62% difference in CPU-per-request for identical code, purely from the paced
rate.** Each request does the same work.

The governor is `performance` on all 12 CPUs with boost enabled, so this is not a
simple governor downclock. Whatever the mechanism — C-state exit after idling,
voltage/frequency ramp, or cold caches and predictor state between requests — the
consequence is unavoidable:

> **CPU/req measured at a sub-saturated pinned rate is not an absolute quantity.**
> It is only comparable to another measurement at the SAME rate. Every µs/req
> figure in this document is a *paced-at-12k-rps* number, inflated relative to
> what a saturated server pays.

What this does and does not invalidate:

* **Still valid — every A/B in this document.** Both sides run at the same rate
  and receive identical treatment, so the differences (0.28–0.70µs structure,
  2.09µs headers, 0.70/0.56µs bodies) are real *relative* costs.
* **Now suspect — comparing an in-situ number to an isolated micro-benchmark.** A
  micro-benchmark runs a tight loop: fully saturated, hot ICs, monomorphic call
  sites, everything in L1. That is the 24k-rps end of the curve, not the 12k end.
  It is why `Headers.set` measures 56ns isolated but 441ns served, and why
  `security()`'s body measures ~30ns isolated but 0.70µs served. Part of the
  "10–20× multiplier" is just this; the rest is the difference between a hot
  single-request loop and a real cold call site.
* **Actionable —** `bench:compare:cpu` pins 15k rps, so its absolute numbers sit
  on this curve. Report the rate alongside every number, or measure at
  saturation and accept that queueing enters.

The honest form of every cost claim here is *"X µs/req at 12k rps paced on this
machine"*, never *"X µs/req"*.

**Why this matters retroactively:** this explains the class of false lead that
cost several rounds — the `ctx.ip` scare, and both chain rewrites. In each case I
measured a primitive in a saturated hot loop and compared it to a paced delta.
Before any further cost work, either re-measure primitives with a cold call site
or accept that only same-rate A/B deltas are trustworthy.

### What survives: A/B deltas are rate-ROBUST (measured)

Re-running the same ablation (`IGNEX_ABLATE=hooks`, i.e. the whole plugin chain)
at two rates, 3 variants × 5 rounds, control = the base variant measured twice:

```
rate 12000:  base 17.58 · nohooks 15.93 · ctrl 17.59
             DELTA 1.65us        control -0.01us
rate 24000:  base 15.59 · nohooks 14.24 · ctrl 15.59
             DELTA 1.35us        control  0.00us
```

The **absolute level** is strongly rate-dependent (17.58 → 15.59 here, and
23.5 → 14.5 between 4k and 24k in the table above). The **delta** moved only
1.65 → 1.35µs across a doubling of rate. So:

* **Every A/B conclusion in this document holds**, and now has a control of
  ~0.00–0.01µs — the earlier 0.28–0.42µs controls came from noisier
  configurations, not from the method being unreliable. Resolution with three
  identical variants and ≥5 rounds is **~0.1µs**.
* The two big decompositions cross-check: the chain ablation is 1.65µs, and
  STRUCTURE (0.28–0.70) + security body (0.70) + cors body (0.56) = 1.54–1.96µs.
  Independent measurements agreeing within their spread.
* **The in-situ body costs are real, not a rating artefact.** `security()`'s body
  genuinely costs ~0.7µs when served while the same operations cost ~30ns in a
  hot loop. Since deltas don't scale with rate, the ~10–20× multiplier is cold
  call sites / IC and GC behaviour, not the clock — and it is still unexplained.

**Harness rule:** pace at **≥12k rps** (curve is steep below ~8k and flat above
~12k; 20–24k is safest), always include ≥3 identical variants as the control, and
report the control with every number.

---

## 18. The security plugin's remaining cost, and why it cannot be zero (2026-09-14)

`packages/core/src/plugins/security.ts` is the last plugin with an `onResponse`
hook on the hot path. Two structural costs were removed:

1. **`isHttpsRequest` no longer materialises `req.url`.** The scheme is read
   from `getServeBootInfo().protocol` — the *listener* protocol, fixed at boot,
   before any plugin runs and before the first request. `req.url` is a lazy
   native string in Bun: on the `Bun.serve({ routes })` path route matching
   happens in Rust, so nothing has materialised it by the time the handler runs
   and the first read pays the full cost. (Reading it 300,000× inside a single
   handler amortises that to nothing and reports ~8ns — a trap this repo fell
   into once, see §13.) The URL-scheme fallback is kept for `createApp` used
   without `serve()`.
2. **The HSTS value string and the scheme test are resolved once.** The
   `max-age=…; includeSubDomains; preload` value was rebuilt by three string
   concatenations per response; it is now a boot constant. And with
   `trustProxy: false` the request scheme is a property of the *server*, so the
   probe is memoised after the first response instead of running on every one.
   With `trustProxy: true` it stays per-request, which is required.

### Measured effect: none detectable — and that is the finding

A/B of `HEAD` vs the change, `SERVER=ignus-aot`, pinned at 15k rps, 3 rounds,
`dist` cleared before **every** build (the compiler cache will otherwise reuse a
stale bundle and silently measure the previous variant), run in both orders:

| run | variant | rounds (µs/req) | median |
|-----|---------|-----------------|--------|
| A1 | new  | 31.68, 31.72, 29.04 | 31.68 |
| B1 | base | 29.25, 29.15, 32.57 | 29.25 |
| B2 | base | 31.31, 29.80, 30.40 | 30.40 |
| A2 | new  | 29.35, 30.90, 31.39 | 30.90 |

Pooled over 6 samples each: **new 30.68µs mean, base 30.41µs mean** — a
**0.27µs** difference against a **~1.2µs** standard deviation. This is neither a
measurable win nor a measurable regression. Both orders happened to favour
`base`, but the within-variant spread (2.5–3.4µs) is an order of magnitude
larger than the effect being measured. Equally, **the in-situ saving from
dropping the `req.url` read is not established at this noise floor** — only its
removal is certain.

**Methodological correction to §17.** Resolution is ~0.1µs with three identical
variants and ≥5 rounds *only when the variants are built in the same
invocation*. An AOT **source** change cannot be: `cpu.ts` rebuilds
`dist/__server.js` once per invocation, so each variant requires its own run and
run-to-run drift is no longer cancelled by an in-invocation control. Resolution
degrades to **~1µs**, and anything smaller must be argued **structurally, not
measured**. The sub-µs decompositions in §15–§17 came from configurations that
*did* hold a control in-invocation; this one does not, and it is the only kind of
comparison available for plugin internals.

### Why the cost cannot be made non-existent

`onResponse` exists for exactly one reason: a route that returns a **raw
`Response`** never goes through framework response construction, so the baked
static header set and `hidePoweredBy` must be applied to it after the fact.
Framework-built responses (`ctx.json()`) already carry the baked set from
construction, so for them the hook does nothing but probe
`isDecoratedResponse` — a single `WeakSet.has`. That probe is the floor, and it
is not removable by restructuring the plugin.

Literal zero therefore means **not registering the hook at all**, which requires
relocating raw-response decoration into `applySet` — the pass that already runs
once per response. That is a 4–5 file, security-sensitive change:

* `http/headers.ts` — `applySet` gains a defaults argument, applied to
  non-decorated responses;
* `phases/codegen/helpers.ts` — `__applySet` must receive `__DEFAULT_HEADERS`;
* `COMPILER_CACHE_VERSION` bump;
* `hidePoweredBy` is a header **deletion**, which a set-of-defaults cannot
  express, so it needs its own carrier;
* `security()` must decline to register the hook, but the listener protocol is
  known only *after* `setServeBootInfo()` — i.e. after the plugin object is
  constructed — so this needs a post-boot decision mechanism the plugin API does
  not have today.

This should be its own change with its own contract check and smoke run. It is
not a drive-by edit: the raw-response path is precisely where the security
headers matter most.

---

## 19. Where the Elysia gap actually is: instrumenting beats profiling (2026-09-15)

Fresh baseline, `bench:compare:cpu`, 15k rps, 3 rounds, medians:

| participant | µs/req | vs bun |
|-------------|--------|--------|
| bun | 23.42 | 1.000x |
| elysia | 26.45 | 1.129x |
| **ignus-aot** | **29.13** | **1.243x** |
| ignus | 32.85 | 1.403x |
| **ignus-native** | **33.71** | **1.439x** |

Two things stand out. `ignus-native` is **slower than the interpreted server**
and 15% slower than AOT — the "native is acceleration" premise fails on this
workload. And the gap to Elysia is 2.68 µs.

### The sampling profiler is not trustworthy here — instrument instead

`bun --cpu-prof` on both participants gave a confident-looking answer:
`parseQuery3` at **13.6% of self time** on ignus vs **0.49%** on Elysia, plus
`Headers.set` at 11.4%. But:

* the profiled run burned **20.0 s** of CPU where the same load measures
  **6.1 s** unprofiled — a **3.3× inflation**, and it inflates JS frames while
  native frames stay uninstrumented, so the percentages are not shares;
* 13.6% of 6.1 s over ~116k calls implies **~7 µs per call** for a function
  whose isolated cost is 197 ns. Implausible on its face.

So instead: **wrap the compiled artifact's functions in `performance.now()`
timers** and read the true per-call cost under real load. This is
rate-independent and needs no sampling. Ground truth at 208k requests served (2
pairs per query, `?q=…&page=7`, called on ~84% of requests):

| function | calls | µs/call | µs/req |
|----------|-------|---------|--------|
| `parseQuery` | 175k | **1.99** | 1.68 |
| `applyStaticHeaders` | 225k | **1.35** | 1.51 |

Together ~3.2 µs of the 29.13 — 11%. Not 25%.

### Fix: the query helper, and why the isolated measurement lied again

`bench/compare/shared.ts`'s `parseQuery(url: URL)` iterated `url.searchParams`.
Crucially this helper is **shared by `bun`, `ignus`, `ignus-native` and
`ignus-aot`** — only Elysia's port escapes it, because Elysia's router parses the
query. So it was a cost charged to every participant *except* the one ignus was
being compared against.

The replacement splits the raw query string, with a fast path that only runs when
the query contains no `%` and no `+` — in which case `URLSearchParams` decoding
is the **identity**, so the result is exactly equivalent, not approximately.
Anything that could need decoding falls through to the native iterator.
Equivalence was checked against `URLSearchParams` on 21 cases including `a`,
`=1`, `&&`, `a=b=c`, `a=1&`, `a=%`, `a=%zz`, `a+b=c+d` and duplicate keys.

**The isolated benchmark said the fix was a regression and the in-situ
measurement said it was a 2.2× win:**

| | isolated | in situ |
|---|---|---|
| `url.searchParams` iteration | **197 ns** | 1990 ns |
| split fast path | 335 ns | **900 ns** |

Hand-rolled decoding also loses badly in isolation (904 ns — `decodeURIComponent`
plus a `+` regex dominates), which is why the fast path skips decoding entirely
rather than implementing it. This is the third time this document records the
same trap (§13, §17): **an operation's hot-loop cost says nothing about its
served cost.** Publishing the isolated number would have reverted a real win.

Measured effect: **1.99 → 0.90 µs/call**, i.e. **−0.92 µs/req**. The contract
harness (`bench:compare:verify`, 10/10 including `GET /api/users -> echoes
query+cookies`) and `verify` (1958 tests) both pass.

### The end-to-end harness could not confirm it, and that is a real limitation

A 5-round re-measure moved **every** participant up — bun 23.42 → 24.77, elysia
26.45 → 29.45 — i.e. the machine drifted ~5–11% between runs. A ~0.9 µs effect
(3%) is not resolvable against that. Per §18, an AOT **source** change cannot
hold an in-invocation control, so this comparison has ~1 µs resolution and the
number above it comes from instrumentation, not from `cpu.ts`. Anyone re-running
these figures should expect them to move by more than the effect being measured.

### Bun finding: `serve({ headers })` is silently ignored

The framework plumbs `__serverCfg.headers` into `Bun.serve({ headers })`, and
that is the obvious place to move the per-response static header set. It does
not work in Bun 1.4.2 — a server started with
`Bun.serve({ headers: { "x-static": "server" }, … })` returns
`x-static = null` for both a plain response and one that overrides the header.
Worth reporting upstream; also means `server.headers` config should be audited.

### Remaining framework cost, precisely measured

`applyStaticHeaders` applies the plugin's static defaults to every response by
iterating the record and calling native `Headers.set` — **8 calls per response,
1.35 µs/req measured**. Elysia instead writes its security headers into a plain
object and hands them to a single `Response` construction.

Merging the defaults into the construction record instead was **already tried and
refuted** — see the note above `withBody` in
`packages/core/src/http/finalize.ts`: 17.06 µs vs 16.60 µs, i.e. the per-request
spread cost more than the `set` calls it saved. That verdict predates both
`sideEffects: false` and this section's instrumentation. Given 1.35 µs measured
for the `set` path and a refutation measured at only 0.46 µs difference on a
noisier harness, **this is the top open lever and it deserves re-measuring with
in-artifact instrumentation**, not another sampling profile.

---

## 20. Full per-request cost budget: the remaining levers are all small (2026-09-15)

§19 measured two functions. This is the whole request path.

**Method.** Wrap every framework function in the compiled artifact with a
`performance.now()` timer (signature-preserving — the original parameter list is
reused, no rest/spread, so no allocation is added). Report through
**`writeSync` on `process.on("exit")`**: the generated server ends in
`process.exit(0)`, which **drops buffered pipe writes** — a first attempt using
`console.log` silently truncated every counter at its earliest sample and
produced a table that looked plausible but was counting a fraction of the calls.
Take the dump, divide by **route invocations** (231k), not by the measured
window: the load script's readiness probe and 1.5 s warmup are served too.

| function | calls | per call | per request |
|----------|-------|----------|-------------|
| route handler (avg of the 3 bench routes) | 231k | **21.9 µs** | 21.9 µs |
| `createContext` | 231k | 1,301 ns | 1.30 µs |
| `withBody` | 46.5k | 4,184 ns | 0.84 µs |
| `runHooks` (2x/route) | 463k | 221 ns | 0.44 µs |
| `createLazyBody` | 69k | 958 ns | 0.29 µs |
| `applyStaticHeaders` | 46.5k | 1,341 ns | 0.27 µs |
| `generateRequestId` | 231k | 248 ns | 0.25 µs |
| `rateLimitCheck` | 231k | 208 ns | 0.21 µs |
| `applySetHeaderRecord` | 46.5k | 896 ns | 0.18 µs |
| `assertContentLength` | 69k | 406 ns | 0.12 µs |
| `applySet` | 46.5k | 134 ns | 0.03 µs |

**Total attributable framework cost ≈ 3.5 µs/request** (~11% of the 29–31 µs
budget), and all of it executes inside the route handler.

> **Correction (see §22).** The route-handler row above (21.9 µs) is **wall-clock
> duration, not CPU**. The wrapper `await`s an `async` handler, so it spans the
> time the handler is suspended on the event loop under a 96-client load — it is
> not the handler's CPU cost, and the earlier reading of it ("~18 µs of the
> handler is the route's own work") was wrong. The synchronous, non-awaited rows
> are CPU and stand. Use the `bench:compare:cpu` total for the CPU budget and
> §22 for its composition.

Instrumentation overhead inflates the synchronous absolutes by roughly 13
wrappers × 2 clock reads per request; the ranking is unaffected.

### The context constructor is a bigger lever than §19's implier, but still small

`createContext` is literally `new IgnexContextImpl(...)`, so all 1,301 ns is the
constructor. Reading the source showed why it looked promising:

* every field is **declaration-only**, so TypeScript emits a bare `req;`,
  `_url;`, … for each — a `[[DefineOwnProperty]]` with `undefined`, **16 of them
  per construction**, all executing before the constructor body;
* `this.set = { headers: emptyHeaders(), ...opts.set }` spreads `opts.set`,
  which is `undefined` on the compiled path — a no-op that still walks
  `copyDataProperties` on every request.

Both were fixed and measured separately:

| variant | `createContext` | vs baseline |
|---------|-----------------|-------------|
| baseline | 1,392 ns | — |
| spread guard only | **1,301 ns** | **−91 ns** |
| spread guard + `declare` fields | 1,324 ns | −68 ns |

Two results. The spread guard is kept: it is exactly equivalent (`{...undefined}`
adds nothing) and worth −91 ns/call ≈ −0.10 µs/request. And **removing the 16
field defines is a PESSIMISATION** — the `declare` variant is 23 ns *slower* than
the spread guard alone, because pre-defining the fields fixes the object's shape
and the defines are cheaper than the shape transitions that follow their
removal. It was reverted. This is the same lesson as the `{ __proto__: null }`
refutation in §13: **a plausible "we are doing obviously redundant work" theory
lost to the measurement.**

`declare` was also rejected on its own merits: it changes the object's
observable enumerable shape (`Object.keys(ctx)` would no longer list `_url`,
`_cookie`, …), so it is not a free change even where it does win.

### Conclusion: no large lever remains

Every function that runs on the request path is now measured, and the largest is
1.3 µs — the rest are 0.03–0.44 µs. Removing the *entire* framework layer would
save ~3.5 µs of 29–31 µs. Consistent with §15's finding: this is not a hotspot
problem and not a tuning problem. Parity needs the compiler to stop emitting the
abstraction (a lean context tier, no per-request objects), which is the Phase 3
project, not more micro-optimisation.

### Two open questions this round could not close

1. **`withBody`/`applyStaticHeaders`/`applySet` are called only 46.5k times —
   exactly the `/health` count — although every generated handler ends in
   `return __ABL_APPLYSET ? response : __applySet(response, ctx.set, …)` and
   every bench route replies through `ctx.json()`.** Either the bundler inlines
   those symbols into the `h0`–`h5` handlers (leaving the standalone definitions
   reachable only from `h6`), or there is a second copy inside an indented scope
   that a line-anchored match misses. Until this is settled, the header cost is
   a floor: it is charged on at least 20% of responses, possibly all of them.
2. **`queryParse` never reported a single call.** The bench's `parseQuery` is
   definitely invoked on ~80% of routes, so its cost is inside the handler and
   unreachable by definition-site instrumentation — the same inlining
   hypothesis. The `−0.92 µs/request` attributed to the §19 fix is a
   per-call figure; the per-request saving is at least that and may be larger.

Both point at the same limitation: **wrapping the definition only observes
non-inlined call sites.** For a bundler that inlines, per-call instrumentation
undercounts, and the budget above should be read as a lower bound on the
framework's share.

---

## 21. Object pooling, boot-time hoisting, and Bun-specific APIs — measured (2026-09-15)

§20 left `createContext` (1.3 µs/request) as the largest attributable framework
function. Two obvious strategies remain for it: **pool the context object**, or
**hoist its work to init/instance time**. Both were evaluated against the
artifact, and one was ablated line by line.

### The constructor's cost is NOT its allocations

Patching the instrumented bundle and re-driving the identical load (same 15k rps,
~170k calls per variant):

| variant | `createContext` | vs base |
|---------|-----------------|---------|
| base | 1,331 ns | — |
| drop the `set.cookie` `Object.create(null)` | 1,313 ns | −18 ns |
| drop `performance.now()` for `startTime` | 1,353 ns | **+22 ns (no effect)** |
| `emptyHeaders()` → plain `{}` | 1,374 ns | **+43 ns (SLOWER)** |
| all three removed together | 1,234 ns | −97 ns |

Every allocatable thing the constructor does is recoverable for **97 ns of
1,331 ns — 7.3%**. Two of them are individually *negative*: the `performance.now()`
clock read is free, and `Object.create(null)` **beats** a plain `{}` (a
prototype-less dictionary wins over walking `Object.prototype`). The remaining
~1,234 ns is the cost of `new IgnexContextImpl()` itself in situ.

This also retro-explains §20: the spread guard (−91 ns) recovered more than all
three allocations combined, because it removed a `copyDataProperties` call rather
than a memory allocation.

### Why pooling is not the answer

Pooling is the only idea that could recover the *whole* ~1.2 µs (4% of the
budget), because it avoids `new` entirely. It is rejected on correctness:

* **`ctx` escapes the framework.** User handlers receive it; `afterHandle`,
  `mapResponse` and `afterResponse` hooks receive it; `afterResponse` runs *after*
  the response is sent; SSE and WebSocket routes retain it for the life of the
  connection; the debugbar/observatory installs a per-request API on it.
* **There is no release point.** The AOT handlers are `async` — the context is
  live across `await` boundaries, and a recycled object that is still referenced
  by a pending continuation puts one request's `requestId`/`ip`/`cookie`/`body`
  into another request's response. That is data leakage between requests in a
  security-focused framework, not a tuning trade-off, and JavaScript offers no
  way to know when the last reference dies.
* **A "documented don't-retain-it" contract** would be the only way to make it
  sound — and the framework's own `afterResponse`/SSE/debug surfaces violate it
  today, so it cannot be adopted without breaking them.

**Decision: do not pool. 4% is not worth cross-request leakage, and 93% of the
constructor's cost would survive the attempt anyway.**

### Bun-specific APIs: measured, no win

| candidate | result |
|-----------|--------|
| `Bun.randomUUIDv7()` vs `crypto.randomUUID()` (already used) | **69.1 ns vs 40.3 ns — 1.7x SLOWER**; `"hex"` form 106.6 ns |
| `Bun.randomUUIDv7("hex")` for request IDs | slower again |
| `Bun.serve({ headers })` for the static header set | silently ignored in Bun 1.4.2 (§19) |

`crypto.randomUUID()` is already the fastest option, so the request-ID path stays
as it is. Note `generateRequestId` measures 248 ns *served* against 40 ns
isolated — the same in-situ multiplier as everything else, not a fixable cost.

### Boot-time hoisting is already exhausted

Everything hoistable is hoisted: per-route `Object.freeze`d `__ctxOpts`,
boot-sanitised frozen `__DEFAULT_HEADERS`, boot-computed plugin chains and
identity matchers (`hasPattern`), and lazily-created `_body`/`_cookie`/`_url`/
`_path`/`_requestId`/`_ip`/`_state`. The one remaining eager item, `startTime`,
is measured above as **free** (removing it is +22 ns). There is nothing left to
move to init time that is not already there.

### The honest summary of §20–21

The framework's attributable per-request cost is ~3.5 µs of a 29–31 µs budget,
the largest single function is 1.3 µs and it is not allocation-bound, the
remaining allocation is 97 ns, and the two obvious remaining strategies
(pooling, Bun-specific APIs) are respectively unsafe and measurably slower.
**There is no tuning work left that is worth doing.** Parity requires the
compiler to stop emitting the abstraction — a lean context tier with no
per-request object, plugins inlined per route, no generic finalize/applySet
(§15's Phase 3).

---

## 22. Can these costs move to Rust FFI? Measured: no (2026-09-15)

`@ignex/native` is available (`isNativeAvailable() === true`) and the Rust
castrum addon is real. The question is whether any remaining per-request cost can
be moved across it profitably.

### Composition of the 29–31 µs budget

A minimal served Bun server (one `new Response("ok")`, no headers, no JSON, no
parsing) driven by the identical 15k rps token-bucket:

| server | cpu/req |
|--------|---------|
| Bun, trivial constant response | **12.5 µs** (12.48 / 18.92 — second round perturbed) |
| + 8 security headers + `JSON.stringify` + `content-length` (no query parse) | 16.6 µs |
| + the JS query parse | 16.5–17.0 µs |
| raw-bun bench participant (full mix incl. rate-limit Map, cookies, POST body) | 23.4 µs |
| ignus-aot | 29.1 µs |

So of the ~29 µs: **~12.5 µs is Bun's HTTP stack and `Response` materialisation**
(a trivial route, 43% of the budget), **~4–11 µs is the shared workload** every
participant — including raw Bun — performs, and **~3.5–5.7 µs is ignex's own JS**.

### The FFI experiment

The `queryPairs` gate is `jsBelowBytes: 512`, so the benchmark's ~30-byte query
never selects native. That gate was calibrated with *isolated* micro-benchmarks,
and this repo has documented repeatedly that isolated cost does not predict
served cost — so the gate was the obvious thing to doubt.
`IGNEX_SIZE_GATES=off` is the documented kill switch that forces the static-table
(native) decision. One server, one load, only the parser differs; variants
interleaved to cancel drift:

| round | JS split path | forced Rust path |
|-------|---------------|------------------|
| 1 | 17.96 µs | 18.13 µs |
| 2 | 16.04 µs | 18.45 µs |

(Rounds interleaved A/B; an earlier non-interleaved run put forced-native at
22.31 µs vs 17.36 / 18.75 for the JS and gate-on control.)

**The Rust path is never faster.** Point estimates are +0.2 to +2.4 µs, and its
per-round spread (0.32 µs) is tighter than the JS path's (1.92 µs) — i.e. it is
consistently *more* expensive, not noisily equal. Its user CPU is ~46% higher
too. The gate is correct, and in situ the true crossover is at least as high as
the 512 B it was calibrated to.

The reason is structural, not a tuning miss: the native path must
`toBytes(input)` (allocate + copy the string into a `Uint8Array`), cross the FFI
boundary, and `readPairsPacked` the result back into JS pair arrays. For a 30-byte
input the marshalling dwarfs the parse.

### Why no other candidate can win either

* **Bun's 12.5 µs floor** is inside Bun (Rust/Zig/C++). There is no user-side API
  to reach it and no zero-copy response path to write into — the framework can
  only hand Bun JS values and let it materialise them. Moving this to Rust means
  replacing Bun's HTTP server, not calling FFI.
* **The header/JSON step (~4.5 µs)** is Bun's own per-header serialisation and
  `JSON.stringify`; the framework already hands it a finished string with an exact
  `content-length`.
* **The framework's remaining ~3.5 µs is JS *object* work** — context
  construction, hook dispatch, `WeakSet` probes, small string ops. Crossing FFI
  requires materialising those as bytes and reading results back, at a measured
  ≥1.3 µs per crossing.

### The arithmetic that settles it

Making **100%** of the framework's JS free would save ~3.5 µs of a 29–31 µs
budget (11%). At a measured cost of ≥1.3 µs per FFI crossing, **you can afford
about two crossings per request before the FFI overhead exceeds every line of JS
you removed** — and the ≥1.3 µs figure is for one *already-optimised*,
byte-compatible, battle-tested op. `IGNEX_NATIVE=off` parity is a gate for a
reason: on this request path native is not an acceleration, it is a tax.

**Result: none of these costs can be profitably migrated to Rust FFI.** The
lever is the compiler emitting less JS (§15 Phase 3), not a different execution
tier.

---

## 23. Why is Elysia faster? Because the two ports don't do the same work

§22 says ~12.5 µs of the 29–31 µs is Bun's floor and only ~3.5 µs is ignex's own
JS, which makes the standing 2.68 µs gap to Elysia hard to explain. It is worth
stating plainly: **a large part of that gap is the benchmark, not the
framework.**

The two ports differ on three per-request steps. Ablating exactly those from the
compiled ignus artifact (same load, `base` run twice as a drift control:
28.29 / 27.40, mean 27.85):

| variant | cpu/req | Δ vs base |
|---------|---------|-----------|
| base (mean of 2) | 27.85 µs | — |
| `ctx.ip` → constant | **24.48 µs** | **−3.37 µs** |
| `cookiesRecord(ctx)` → `{}` | 25.52 µs | −2.33 µs |
| `queryRecord(ctx)` → `{}` | 24.67 µs | −3.18 µs |
| all three | **21.27 µs** | −6.58 µs |

**Each of those three alone exceeds the entire 2.68 µs gap**, and together they
are 6.58 µs — 2.5× it. Sub-additive (individual deltas sum to 8.88 µs), so they
partly overlap in what they displace.

What the Elysia port does instead of each:

* **IP** — `ignus` calls `ctx.ip`, which resolves the peer address via
  `server.requestIP()`. **Elysia's port never calls `requestIP`**: it reads
  `x-forwarded-for` / `x-real-ip` and falls back to a constant
  (`elysia-server.ts:72`). That single native call is ~780 ns isolated and
  **3.37 µs served** — the largest attributable per-request item found anywhere
  in §20–§23, larger than the whole rest of the framework's JS.
* **Cookies** — `ignus` materialises a record from the lazy cookie-jar Proxy via
  `Object.entries`; Elysia destructures its own already-parsed cookie context.
* **Query** — `ignus`'s `queryRecord(ctx)` goes through `ctx.url`, i.e. a full
  `new URL(req.url)` (which also forces the lazy `req.url` materialisation),
  while Elysia's router has already parsed it.

### Conclusion, stated carefully

Elysia is not faster because ignus's framework machinery is heavier. It is faster
largely because **its port performs measurably less work on three steps, one of
which (the peer-address lookup) is worth more on its own than the whole gap.**
Removing just `ctx.ip` puts ignus-aot at ~24.5 µs against Elysia's 26.45 µs.

That is *not* a fair win and it is not claimed as one — it means the headline
"Elysia beats ignus" on this benchmark is not a like-for-like result. A
meaningful comparison needs all participants on the same IP, cookie and query
strategy. What can be said with confidence is that ignex's own attributable
overhead (§20: ~3.5 µs) does not explain a 2.68 µs deficit, because the deficit
is smaller than any one of the three asymmetries.

### Bug found and fixed while measuring: `trustProxy` was unreachable

The IP ablation led to the `ctx.ip` getter, which resolved the **socket address
first** and only consulted the forwarded headers if that failed:

```ts
const socketIp = readSocketIp(this.server, this.req);  // succeeds on ~every request
if (socketIp !== undefined) return socketIp;           // ...so this always returns
if (this._opts.trustProxy) { /* unreachable */ }
```

`server.requestIP()` returns the *proxy's* address, so with `trustProxy: true`
the header branch was dead code and `ctx.ip` always reported the proxy — silently
breaking every IP-keyed feature (rate limiting, logging, allow-lists) for exactly
the deployments that opted in. The order is now header-first when `trustProxy`
is set, socket-second, verified:

```
trustProxy: true  -> ctx.ip = 203.0.113.7   (client, from x-forwarded-for)
trustProxy: false -> ctx.ip = 10.0.0.9      (socket)
```

This is also the cheapest order for a proxied deployment: it skips the ~3.4 µs
native lookup entirely. `trustProxy: false` is unchanged — a client-supplied
header is still never trusted.

---

## 24. Usage-specialized codegen: the fast tier was dead code (2026-09-15)

The compiler already had everything needed for "only pay for what the route
uses": an AST-derived `ContextUsage` (`set`, `cookie`, `params`, `body`,
`query`, `headers`, `req`, `url`, `server`, `state`, `json`, …, plus a
`FULL_USAGE` fallback for unresolvable handlers), a tier decision
(`needsFull` / `compact` / `static-sync`), and a specialized context builder
that emits a plain object literal instead of `new IgnexContextImpl(...)`.

### What was wrong

Three pieces of already-written machinery were **unreachable**:

* `context.ts` emits `const __set = { headers: Object.create(null), cookie:
  Object.create(null) }` for a specialized route;
* `context.ts` emits `const __cookieJar = createLazyCookieJar(__set, …)` for
  `usage.cookie`;
* `handler.ts` emits `return __applySet(response, __set);` for a specialized
  route that is not `compact`.

All three require `!needsFull`. But `needsFull` listed
`route.analysis.usage.set` and `route.analysis.usage.cookie`, so
`!needsFull && (usage.set || usage.cookie)` was **unsatisfiable** — the middle
tier could never be selected. Any route that merely *set a response header* or
*read a cookie* was forced onto `createContext` + `IgnexContextImpl` + the full
lifecycle ladder.

Removing those two disjuncts makes the branch live. Emitted code for
`GET /health` in a plugin-free build, before → after:

```js
// before: full context
ctx = createContext(req, params ?? EMPTY_PARAMS, __ctxOpts__h6);
ctx.server = server;
if (__hasPreParse) { … } if (__hasBeforeHandle) { … } /* + afterHandle,
  mapResponse, afterResponse, trace, access-log */
return __applySet(response, ctx.set, …);

// after: specialized
const __params = params ?? EMPTY_PARAMS;
const __set = { headers: Object.create(null), cookie: Object.create(null) };
const __result0 = health_get_default({ set: __set, headers: req.headers, json: jsonReply2 });
return __applySet(response, __set);
```

All four `ignus-aot-app` route shapes (`/api/cookies`, `/api/users` GET and
POST, `/health`) now take the specialized tier. Safety is preserved because
`FULL_USAGE` also sets `proxy`/`forward`/`cache`/`loader`/`sendFile`/`file`/`debug`,
all of which remain in `needsFull` — so an unresolvable handler still gets the
full context.

Verified: `typecheck`, 348 compiler tests, `verify` exit 0 (1959 tests), and the
byte-for-byte contract harness 11/11 on all four servers.

Measured on a plugin-free build, interleaved, tier rule the only variable:

| round | with fix | reverted |
|-------|----------|----------|
| 1 | 27.19 µs | 27.00 µs |
| 2 | 26.48 µs | 28.10 µs |

Mean **26.84 vs 27.55 µs (~0.7 µs)** — directionally positive but only at n=2
against ~1.1 µs run-to-run drift, so it is *not* conclusive on timing. The
structural change in the emitted code is the firm evidence.

### The real blocker for plugin-using apps

**None of this helps an app that registers plugins.** `hasGlobalLifecycle` is
`appConfigHasHooks`, and a plugin's `onResponse`/`beforeHandle` receives the
context — a *runtime* object the compiler cannot analyse, so it must assume the
hook may read any member and keep the full context. Bench A/B on the same build:

| build | cpu/req |
|-------|---------|
| with plugins (all routes `needsFull`) | 27.92 µs |
| without plugins (all routes specialized) | 25.68 µs |

That 2.24 µs is the prize, but it is **not** all the tier flip: the plugin hooks
themselves cost ~1.65 µs (§15), so the tier portion is the remainder.

**The change that would unlock this** is the same declarative pattern already
used for `IgrexPlugin.responseDefaults`: let a plugin *declare* its context
requirements so the compiler can keep routes specialized when the hooks need
only a subset. The framework's own plugins are the obvious first customers —
`cors` needs `headers`, `security` needs nothing beyond the response — but a
plugin that declares nothing must continue to force the full context, so this is
a plugin-API change with its own compatibility story, not a codegen tweak.

---

## 25. Elysia's port was skipping the peer-address lookup (2026-09-15)

**Read the framing first: the headline flip below is a measurement correction, not
a framework speedup.** ignex did not get faster relative to raw Bun; Elysia stopped
getting credit for work it was not doing.

The load generator sends **no** forwarded header (§22/§23 confirmed this by grep),
so the three ports' IP resolution resolves to:

| port | resolution | pays `server.requestIP()`? |
|------|------------|-----------------------------|
| `bun` | `getClientIp(req, server)` → falls through to `srv.requestIP(req)` | **yes** |
| `ignus` / `ignus-aot` | `ctx.ip` → `readSocketIp` → `requestIP` | **yes** |
| `elysia` | headers, then the literal `"127.0.0.1"` | **no** |

On loopback `requestIP()` returns `127.0.0.1` anyway, so the two strategies
produce **identical response bytes** — Elysia's port simply never paid the
~3.4 µs/request native lookup that §23 measured. That is exactly the asymmetry
§23 predicted: the deficit was smaller than any one of the port differences.

### The change

`elysia-server.ts` now resolves through the same shared helper as every other
participant (`getClientIp(request, server)`). The contract harness passes
**45/45, byte-identical** — confirming the change is cost-only, with no
observable difference in any response.

### Result

Two independent runs, medians, 15k rps:

| participant | before | after run 1 | after run 2 |
|-------------|--------|-------------|-------------|
| bun | 23.42 | 24.56 | 27.48 |
| elysia | **26.45** | **32.55** | **35.79** |
| ignus-aot | **29.13** | **31.60** | **33.51** |

The machines drifted between runs (raw Bun itself moved 23.42 → 27.48), so only
within-run ordering is meaningful — and in both runs **ignus-aot is now faster
than Elysia**, as it is in every one of run 2's five alternating rounds
(33.29/31.42/36.78/34.00/33.51 vs 53.76/34.47/54.73/35.79/35.12).

**What did not change:** the ratio to raw Bun. ignus-aot sits at ~1.22–1.29x
Bun's CPU per request, exactly as before. Nothing here closes that gap; §15's
Phase 3 (the compiler emitting less abstraction) remains the only lever that
would, and §24's declarative plugin usage is the first step of it.

### The declarative-plugin lever, sized

§24 established that `hasGlobalLifecycle = appConfigHasHooks` forces the full
context on every route in any app with plugins. The analyzer hook point already
exists — `phases/analysis/dev-only-plugins.ts` walks the `plugins` array and
resolves plugin call names by identifier (that is how `hasEnabledDebugbar`
works) — so collecting plugin names and mapping known core plugins to declared
`ContextUsage` is a contained change to `AppConfigInfo` plus a codegen merge of
the plugin usage into each route's usage.

It is **not** implemented here, deliberately: a wrong declaration hands a plugin
hook `undefined` for a member it reads, which is a runtime breakage in user apps,
and the payoff is bounded. Adding up §22's composition (12.5 µs Bun floor,
~4.5 µs header/JSON materialisation, ~3.5 µs attributable framework) leaves at
most ~1 µs recoverable from the context tier — the plugin hooks themselves
(~1.65 µs, §15) still have to run. Worth doing deliberately, with its own plugin
API, compatibility story and test suite; not worth rushing.

---

## 26. Correction: the hook ladder lives only in the `needsFull` templates

§24 proposed that letting plugins *declare* their context requirements would let
routes stay specialized while their hooks still run. **That is necessary but not
sufficient, and on its own it would be a silent correctness bug.**

Proof — every `runHooks(` call site in `phases/codegen/routes/handler.ts` is
inside one of the two `needsFull` assemblers:

| lines | template |
|-------|----------|
| 79–145 | async `needsFull` |
| 175–247 | `assembleNeedsFullSyncCoreFn` |
| 274–321 | the async resume / stage machine |

There is **no `runHooks` in any specialized or compact template** — those branch
straight from `__finalize(...)` to `return response;` / `return __applySet(response, __set);`.

So `hasGlobalLifecycle ⇒ needsFull` is a **hard correctness invariant**, not a
conservative over-approximation. A route emitted on the specialized tier never
runs `__lc.afterHandle`/`onResume`/`beforeHandle` at all — declaring plugin
usage and then specializing would silently drop CORS headers and security
decoration for every route in the app. §24's plan, applied alone, breaks plugins.

### The actual requirement: decouple the two axes

The codegen currently welds together two **orthogonal** decisions:

* **context tier** — full / specialized / compact — driven by route *usage*;
* **lifecycle ladder** — run hooks, or don't — driven by whether hooks are
  *registered*.

Making "the default path the fastest" with real plugins means the ladder must be
available on every tier. Concretely that is four template variants (sync ×
hooks) plus the resume machine, and `ctx.set` / `__set` must be uniform across
all of them so `applySet` reads the same shape.

### Why "bake the internal plugins in" is the version that actually pays

This is where the user's framing is exactly right, and it is stronger than §24's:
if the compiler resolves the framework's **internal** plugins statically —
`cors(...)` and `security(...)` are recognised plugin calls with known,
analyzable options — it can emit their decoration **inline into the specialized
templates** instead of routing them through the generic `__lc.afterHandle` chain.
Then the ladder is not merely cheap on a lean context, it *does not exist* for
those routes. The plugin options become the compile-time trigger for which
decoration code is emitted:

| internal plugin | what the compiler already knows | what it can emit |
|-----------------|--------------------------------|------------------|
| `security(opts)` | static header set → already baked into `__DEFAULT_HEADERS`; HSTS is boot-derived; `hidePoweredBy` | nothing per-route for framework-built responses; a short tail for raw-`Response` routes |
| `cors(opts)` | origin list, methods, allowed/exposed headers, credentials, maxAge | an inline origin-match + `ACAO`/`Vary` block in the route tail |

Everything not resolvable this way (user plugins, aliased imports, non-literal
options) must keep forcing the full context — the same conservative rule as
`FULL_USAGE`.

### Deliberately not implemented here

Two reasons, both about *how* it should land rather than whether:

1. **It is security-sensitive codegen.** The CORS allow-list and origin matching
   would be re-implemented as emitted code; a mismatch is a CORS bypass, and the
   contract harness only covers the bench's own origin list. It needs its own
   test suite over allow-list edge cases (`null` origin, absent `Origin`,
   wildcard-vs-credentials, `Vary` correctness) before it ships.
2. **The payoff stays bounded and the work is not small.** The hooks' actual work
   (~1.65 µs, §15) still has to happen; only the *ladder* and the full-context
   construction are recoverable, so ~1 µs is the ceiling against a four-template
   codegen change plus a plugin-recognition analyzer.

Recommended order, smallest safe step first: (a) extend the app-config analyzer
to report resolved plugin calls (the `dev-only-plugins.ts` walk already resolves
call names and import sources for `debugbar`), (b) add the conservative
"declared vs unknown" rule and a test that an unknown plugin still forces
`needsFull`, (c) only then move the ladder into the specialized templates.

---

## 27. Second blocker: the specialized context cannot express what hooks read

Step (b) is implemented — `INTERNAL_PLUGIN_USAGE` in
`phases/analysis/internal-plugins.ts` declares, per internal plugin, which
context members its hooks touch, and `resolveGlobalPluginUsage` merges them into
`AppConfigInfo.globalPluginUsage` (`null` = unknown → keep forcing the full
context). Auditing the two plugins for their declarations turned up a second,
independent blocker for step (c).

**What each hook actually reads** (grepped from the plugin sources):

| plugin | members read | declarable? |
|--------|--------------|-------------|
| `security` | `ctx.headers.get("x-forwarded-proto")` (trustProxy path), `ctx.req.url` (boot-info fallback) | **yes** — both emitted by the specialized context |
| `cors` | `ctx.headers.get("origin")`, `ctx.headers.get("access-control-request-headers")`, **`ctx.method`** | **no** — see below |

`cors` needs `ctx.method` for its OPTIONS preflight branch. But:

* `ContextUsage` has **no `method` flag** — its 23 flags are
  `body/params/query/file/headers/state/json/text/html/redirect/stream/empty/`
  `status/req/url/cookie/server/set/sendFile/proxy/forward/cache/loader/debug`;
* the specialized context emits exactly those, and `method` is not among them —
  `buildContextProps` covers set/params/body/query/headers/req/url/server/state/
  json/text/html/stream/redirect/empty/status/sendFile/cookie/proxy/forward.

So on the specialized tier `ctx.method` is `undefined`, and declaring `cors`
narrow would hand its hook `undefined` and **silently break preflight handling**.
It is therefore left undeclared, and an app using `cors()` still resolves to
`globalPluginUsage: null`.

The specialized context is likewise missing `route`, `path`, `requestId`, `ip`
and `startTime`, which exist on `IgnexContextImpl` and which any plugin hook may
legitimately read.

### Consequence for step (c)

(c) is therefore two changes, not one:

1. **Make the specialized context able to satisfy hooks** — add the missing
   members (`method` at minimum, plus `route`/`path`/`requestId`/`ip`/
   `startTime`) *and* the `ContextUsage` flags to request them, so a declaration
   can exist at all; and
2. **Give the specialized templates the hook ladder** (§26).

Both are needed before a single route can be specialized while a plugin runs.
The prize is unchanged and modest — the hooks' own work (~1.65 µs, §15) still
happens, so ~0.6–1 µs is recoverable — but the scope is now measured rather than
guessed, and the ordering is unambiguous: (1) before (2), because a ladder on an
incomplete context is worse than no ladder.

**What landed here changes no runtime behaviour.** `needsFull` still requires
`appConfigHasHooks`; the analysis is read-only. `verify` exit 0 (1969 tests).

---

## 28. `ctx.method` was `undefined` on specialized routes — a real bug

§27 concluded that `cors` could not be declared because its hook reads
`ctx.method` and the specialized context does not emit it. Unblocking that turned
up a latent **bug**, not merely a missing flag.

`USAGE_FLAGS` in `utils/ast/usage.ts` collapsed three members onto one flag:

```ts
url: "url",
path: "url",
method: "url",   // reasoned as: "all imply the request URL was read"
```

But `buildContextProps` emits exactly the **flagged** member and nothing else. So
a handler that read `ctx.method` set `usage.url`, codegen emitted `url`, and the
handler then read **`ctx.method === undefined`** — silently. It type-checks, it
compiles, and it only fails at runtime, which is the worst failure mode this
analyzer has.

It is reachable: a route that reads only `ctx.method` and returns a reply trips
none of the `needsFull` conditions, so it takes the specialized tier.

**Fix.** `method` gets its own `ContextUsage` flag — added to the interface,
`EMPTY_USAGE`, `FULL_USAGE`, and the canonical `FLAGS` list whose drift test
exists precisely to catch a flag added in one place and not the other (it did).
`USAGE_FLAGS` now maps `method: "method"`, and `buildContextProps` emits
`method: req.method` — a plain property on the Request, so no URL is built for
it. With that, `cors` is declarable and is declared as
`{ headers: true, method: true }`, replacing §27's `null`.

**`ctx.path` is the same bug and is still open.** It maps to `url`, nothing emits
a `path` member, so `ctx.path` is `undefined` on a specialized route. Fixing it
needs a `path` member whose value matches `pathnameOf(req.url)` exactly: that
helper is core-internal and not exported, and `url.pathname` is not obviously
identical for every URL shape. It deserves its own change rather than being
folded into an unrelated one. (Fixed in §29.)

## 29. `ctx.path` — the same bug, and why the fix is NOT `url.pathname` (2026-09-15)

§28 closed with `ctx.path` still open. It is the same collapse: `USAGE_FLAGS`
mapped `path` onto `url`, so a route that read `ctx.path` set the `url` flag,
codegen emitted `url` and no `path` member, and the handler read `undefined`.

The interesting part is *what value* the compiled route must emit. The obvious
choice is `new URL(req.url).pathname`, but the interpreted path does not use it:
the full context's `pathnameOf` slices the string and never builds a URL. The two
disagree on dot-segments — measured directly:

| input | `pathnameOf` | `url.pathname` |
|---|---|---|
| `http://h/a/b?x=1` | `/a/b` | `/a/b` |
| `http://h:3000/api/users?x=1` | `/api/users` | `/api/users` |
| `http://h` | `/` | `/` |
| `http://h/a/../b` | `/a/../b` | `/b` |

So emitting `url.pathname` would make compiled and interpreted builds return
different strings for the same request — a divergence a user would hit on any
route that reads `ctx.path`. `pathnameOf` is therefore exported from
`@ignex/core` and reused verbatim: one helper, one behaviour, no second
implementation to drift.

**Fix.** `path` gets its own flag (interface, `EMPTY_USAGE`, `FULL_USAGE`, the
canonical `FLAGS` list that exists to catch exactly this), `USAGE_FLAGS` maps
`path: "path"`, and codegen emits `path: pathnameOf(req.url)` with
`usedCore.add("pathnameOf")` so the import is carried. The emissions for
`req`/`url`/`method`/`path` moved into a `pushRequestMembers` helper — not for
tidiness, but because the extra flag pushed `buildContextProps` past the
25-point cognitive-complexity ceiling.

Verified: `verify` exit 0 (1971 tests); `ctx.path` has its own flag while `url`
and `method` stay `false`, and the emitted helper is byte-identical to the one
the interpreted path calls.

### 29.1 The `files: "body"` collapse is NOT a bug — and the vocabulary is now audited

§28 flagged `files: "body"` as a suspected remaining instance of the same bug.
It is not, and the reason generalizes. The test is **divergence**, not "does the
mapping collapse":

> A collapse is a bug iff the two tiers emit *different member sets* for the
> same source.

`method`/`path` collapsed onto `url`, and the specialized tier emitted `url`
while the full context had real `method`/`path` values — different sets, so the
handler saw a value in one build and `undefined` in the other. `files` collapses
onto `body`, but **neither** tier has a `files` member: `ctx.files` and
`ctx.file` exist nowhere in core, nothing declares them, nothing reads them
(uploads go through `ctx.body.file()` / `ctx.body.files()`, and
`saveUpload(ctx, …)` in `http/uploads.ts`), so the `file`/`files` entries are
conservative leftovers of a shape that never shipped. Both tiers return
`undefined` → no divergence.

Auditing the whole vocabulary mechanically, every `ContextUsage` flag is exactly
one of two things:

- **emitted** — codegen writes a member of that name onto the specialized
  context: `body`, `params`, `query`, `headers`, `state`, `req`, `url`, `method`,
  `path`, `cookie`, `server`, `set`, the reply helpers (`json`, `text`, `html`,
  `redirect`, `stream`, `empty`, `status`), plus `sendFile`, `proxy`, `forward`;
- **sentinel** — the flag forces `needsFull`, so the specialized tier is never
  reached and codegen has nothing to emit: `file`, `cache`, `loader`, `debug`.
  These four are also what `FULL_USAGE` sets, which is the mechanism that keeps
  an unresolvable handler on the full context (`generate.ts` lists them for
  exactly that reason).

No flag is in neither set, so no `method`/`path`-style hole remains.

**The guard.** `packages/compiler/test/context-members.test.ts` pins this. For
each emitted flag it calls codegen's `buildContextProps` (now exported for this)
with a single-flag usage bitmap and asserts a member of that name comes back. It
also fails when a new `ContextUsage` flag is added without being classified as
emitted or sentinel, and when a classified flag no longer exists. Mutation
checked — rewriting `if (usage.path)` as `if (usage.url)` fails it with

> `usage.path was set but codegen emitted no 'path' member (got: )`

which is precisely the bug the two preceding commits fixed, so this class cannot
return silently.

**Still open.** The specialized context lacks `route`, `requestId`, `ip` and
`startTime` — which is not merely a blocker for the hook ladder, it is a bug
(§30).

## 30. `route`, `requestId`, `startTime` and `ip` were `undefined` on the fast path (2026-09-15)

§27 and §29 both listed these four as "the specialized context still lacks…",
framed as the blocker for the hook ladder. It is worse than that: they are a
silent runtime bug on the default path.

They had **no entry in `USAGE_FLAGS` at all**, so a handler reading one set no
flag. Measured with the analyzer directly:

| handler reads | flags set |
|---|---|
| `method`, `path` | `json`, `method`, `path` |
| `ip`, `route`, `requestId`, `startTime` | `json` |

`json` trips none of the `needsFull` conditions, `enableTraceHeaders` and
`enableAccessLog` default to `false`, and `specializeContext` defaults to `true`
— so such a route takes the usage-specialized tier, whose object literal has no
`ip`/`route`/`requestId`/`startTime` member, and the handler reads `undefined`
while the interpreted path returns a real value. That is the same
compiled-vs-interpreted divergence as §28/§29 but a worse variant: there was no
flag to collapse, the members were simply never in the vocabulary. `ctx.ip` is
what rate limiting, allow-lists and access logs key on, so this is not cosmetic.

**Fix, stage 1 (shipped).** Each gets a flag, and each forces `needsFull`, so all
four became correct immediately. Routes that never read them are unaffected and
stay specialized, so the fast path is not taxed for a member it does not use.

**Fix, stage 2 (shipped).** `route`, `requestId` and `startTime` are now EMITTED
on the specialized context, each using the *exact* expression the full context
uses — `route: <route.source.path>` (the same literal `__ctxOpts_<ref>` hands to
`createContext`), `startTime: performance.now()` (mirroring the impl's
`this.startTime = performance.now()`, both at request dispatch), and
`requestId: generateRequestId()` (core's generator, now exported, so a compiled
and an interpreted build cannot mint different ids). Only `ip` still forces the
full context.

**Why `ip` is the one that stays behind — and a second bug found doing it.**
Emitting `ip` needs the trust-proxy setting at runtime, so the audit traced where
a compiled app gets it from. It never does:

```
compiled:   ctx = createContext(req, params ?? EMPTY_PARAMS, __ctxOpts_<ref>)
            __ctxOpts_<ref> = { body, route, responseDefaults }   // no trustProxy
interpreted: createApp({ trustProxy }) -> lifecycle ctxOptions.trustProxy -> ctx.ip
```

`IgnexContextImpl.ip` reads `opts.trustProxy`, and the compiler's per-route opts
never set it — `trustProxy` appears nowhere in the compiler at all. So in an AOT
app `trustProxy: true` is inert for `ctx.ip`: the getter's header branch is
skipped and every client resolves to the socket address (the proxy's, behind a
proxy). That is the §25/`624ebf9` bug again, but only in compiled builds — which
is exactly why it went unnoticed: the fix was verified against `createContext`
callers that pass the option. Emitting `ip: resolveClientIp(server, req, false)`
would preserve this status quo and hardcode it, so `ip` stays sentinel until
`trustProxy` is plumbed properly. That plumbing needs a decision the compiler
cannot make alone: `security({ trustProxy: true })` (the plugin's own option,
used for `isHttpsRequest`) and `createApp({ trustProxy: true })` (the context
option) are separate settings with the same name, and `PluginCallInfo` carries
only `{name, source}` today, so neither is extractable without widening it.

**The guard.** `context-members.test.ts` classifies `route`/`requestId`/
`startTime` as emitted and `ip` as sentinel, and a `usage-soundness.test.ts` case
asserts the analyzer sets all four flags; drop the entries again and it fails.

**Still open.** The hook ladder (§27 step (2)) still needs `ip` emit-able on the
specialized context, which is blocked on the `trustProxy` plumbing above; the
perf unlock beyond that remains the bounded ~0.6–1 µs of §26.

## 31. `trustProxy` was inert in every compiled app (2026-09-15)

§30 ended by noting `ip` could not be emitted because it needs the trust-proxy
setting, and that `trustProxy` appears nowhere in the compiler. Following that up
found a second, larger bug — and then closed both.

**The bug.** `ctx.ip` reads `ContextOptions.trustProxy`. The compiler builds those
options itself:

```
compiled:    ctx = createContext(req, params ?? EMPTY_PARAMS, __ctxOpts_<ref>)
             __ctxOpts_<ref> = { body, route, responseDefaults }   // no trustProxy
interpreted: createApp({ trustProxy }) -> lifecycle ctxOptions.trustProxy -> ctx.ip
```

`packages/compiler` mentioned `trustProxy` nowhere (two hits, both comments), so
in an AOT app the getter's forwarded-header branch was dead code: every client
resolved to the socket address — behind a proxy, the PROXY's. This is the `624ebf9`
bug again, and it survived because that fix was verified against `createContext`
callers that DO pass the option. It worked interpreted and stayed inert compiled.

**Why the obvious fix is wrong.** `security({ trustProxy: true })` looks like the
switch to read — its own option docs mention "`trustProxy` discipline (ctx.ip,
rate limiting)". It is not: `security()` reads the option into a closure and uses
it *only* for its HSTS decision (`isHttpsRequest`). It never touches
`ContextOptions`, and no plugin can, because the impl only receives whatever
object was passed to `createContext`. Two independent settings share the name.

**The fix — declare, don't extract.** The framework already has the right
mechanism for "an app-invariant value a plugin needs the framework to apply":
`IgnexPlugin.responseDefaults`, which BOTH paths read (interpreted via
`collectResponseDefaults` at boot, compiled by inlining an equivalent loop over
the plugin objects the artifact boots). `IgnexPlugin.contextOptions` is its
sibling, and the same shape works here:

- `security({ trustProxy: true })` declares `contextOptions: { trustProxy: true }`.
- `collectContextOptions(plugins)` merges it. A plugin can only ENABLE the
  setting, never disable it: one declaration means "this deployment sits behind a
  proxy", and no plugin can prove the opposite.
- `createApp` resolves explicit option → plugin declaration (`resolveTrustProxy`),
  so the interpreted path honours either surface.
- The compiled server folds the same declaration ONCE at boot into
  `const __TRUST_PROXY`, guarded by `state.hasAppConfig` — so an app with no
  config const-folds to `false` and pays nothing.

This also settled §30: with the setting finally reachable, `ip` did not have to
stay a sentinel. `resolveClientIp(server, req, trustProxy)` is extracted out of the
`ip` getter (one implementation, exported) and codegen emits
`ip: resolveClientIp(server, req, __TRUST_PROXY)`. `ip` moved from sentinel to
emitted, so a route that reads `ctx.ip` is now correct AND on the fast tier.

**Verified.** Core unit tests cover the merge semantics, `security()`'s
declaration, and the resolver — header-first when trusted, socket otherwise,
`"anonymous"` last, and a client-supplied header IGNORED when the deployment does
not trust a proxy. Compiler tests assert the emitted artifact contains
`const __TRUST_PROXY`, reads it off `__appConfig.plugins`, and folds it into both
context-options literals — including `__ctxOpts`, which serves the non-route
contexts (404/405/OPTIONS/error), so those resolve the client identically.

**Still open.** The hook ladder (§27 step (2)) — the remaining bounded ~0.6–1 µs
of §26. Note also that `globalPluginUsage` (§27 steps a/b) is computed and stored
on `AppConfigInfo` but has NO codegen consumer yet, so any active plugin still
forces `needsFull` on every route via `hasGlobalLifecycle`. (Fixed in §32.)

## 32. The plugin layer no longer forces the full context — the hook ladder (2026-09-15)

§31 left this as the remaining lever, and it is the one that matters: the bench
participant registers `cors()` and `security()`, the two plugins whose context
requirements were already declared in §27, so `hasGlobalLifecycle` put **every
route in the benchmark app** on the full context. Compiled with the new
compiler, on the participant's own routes and app config:

| | before | after |
|---|---|---|
| `__ctxOpts_<ref>` consts (full-context only) | every route | **0** |
| afterHandle ladder | `needsFull` only | every route |
| pre-parse ladder | `needsFull` only | every route |

**What changed.**

1. **The gate split.** `appConfigHasHooks` was doing two jobs. It still gates
   constant HOISTING untouched — a hoisted body bypasses hooks, so any plugin or
   user lifecycle keeps that optimization off — but `needsFull` now distinguishes:
   - user `lifecycle`/`hooks` → **always** full context. Opaque: the members a
     user hook reads cannot be declared.
   - the plugin layer → full context only when `globalPluginUsage === null`
     (unresolvable) **or** a declared flag is absent from the new
     `EMITTED_USAGE_FLAGS`. That set is the single authority for the gate AND for
     `context-members.test.ts`, which now imports it instead of keeping its own
     list — so the gate and the test cannot drift apart.

2. **The ladder moved to the specialized tier.** `assembleNeedsFullSyncCoreFn`
   and the async resume were already generic over `ctx`; they only needed the
   context to exist as a VARIABLE rather than an inline literal. So
   `buildSpecializedContext` now emits `ctx = { … }` (assignment — a `let` would
   shadow the binding the error path needs) plus the pre-parse stage, and
   `assembleCoreFn` emits the same post-handler ladder on both tiers. Every stage
   is a boot-constant guard (`__hasPreParse`, `__hasBeforeHandle`, …), so an app
   with no hooks const-folds the whole ladder away and hook-less routes keep
   their existing behavior.

3. **`sync` is no longer tied to `needsFull`.** The sync assembler serves both
   tiers, so a statically-sync route keeps its zero-Promise path; `resumeName` is
   now emitted whenever `routeIsSync`, not only for the full context.

4. **Two traps found while implementing.** `__ABL_APPLYSET` is a global ablation
   switch, NOT a compact indicator — reusing the sync assembler's tail verbatim
   would have added an `__applySet` to every compact route, deleting the very
   optimization `compact` exists for; the sync tail is compact-aware now. And
   `__EMPTY_SET` is FROZEN, so a plugin hook writing `ctx.set` would have thrown:
   a route in a plugin app now gets a mutable `__set`, and therefore cannot be
   `compact`.

**Verified.** `verify` exit 0 (2014 tests) and the smoke gate 52/52 — including
CORS preflight and actual requests, the security header set, the plugin
`x-request-id` + lifecycle middleware chain, and 405/OPTIONS/HEAD/404. A new
`plugins-specialize` fixture pins the codegen shape (specialized AND laddered AND
`__applySet`, with a mutable context variable).

**Not yet measured — and the first attempt was INVALID.** `bench/compare/cpu.ts`
REBUILDS the AOT artifact on every run: `buildAot()` spaws
`servers/ignus-aot-server.ts` with `BENCH_BUILD_ONLY=1`, i.e. it compiles the app
with the CURRENT compiler into `dist/__server.js`. So swapping the artifact and
re-running measures the same thing twice. Three consecutive runs produced
ignus-aot at **26.24 / 29.50 / 30.00 µs** — all three the new-compiler output —
with `ignus` drifting 32.54 → 35.51 → 38.12 in the very same runs. That is ±14%
run-to-run noise, larger than any effect being chased. A valid A/B must run the
harness from a checkout of the pre-change commit (`git worktree add … 0a6e21a`),
not from `main`. What those runs DO show consistently: ignus-aot beat Elysia in
every one (26.24/31.76, 29.50/33.09, 30.00/33.25), while still sitting at
1.07–1.22× raw Bun — short of the harness's own 1.0× `CPU_GATE_TOLERANCE`. No µs
figure for the ladder is claimed here.
