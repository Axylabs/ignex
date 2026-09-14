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
