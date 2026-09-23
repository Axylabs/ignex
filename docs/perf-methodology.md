# Performance methodology — measuring ignex × castrum without fooling yourself

Everything in this file was learned by getting it wrong first. Follow it and you
do not have to re-litigate "is this real?" every time the native layer is
touched. Companion reading: `docs/native-acceleration.md` (what the native
layer is), `docs/comparison-bench.md` (the cross-framework harness).
§7 is the consolidated record of the framework's own measured cost budget —
the numbers, the hypotheses already refuted, and the rules for measuring them.

## 1. The three-level ladder

Measure at the level that matches the claim; each answers a different question.

| level | tool | question |
| --- | --- | --- |
| **op** | `bun run bench:native:all` (`scripts/bench-native.ts`) | does native beat the JS fallback for THIS primitive? (also prints the SELECTION **MISMATCH** worklist) |
| **call** | fixed-op harness on `createNativeRoute` / `nativeFor(op)` (recipe below) | what does one real call cost, and where inside it? |
| **server** | `bun run bench:server` + `bun run bench:server:check` | what does a saturated server do end-to-end? (the CI gate) |
| **compare** | `bun run bench:compare` (+ `bench:compare:gate`) | how does ignus/ignus-aot compare to raw Bun and Elysia on the SAME workload? |

## 2. Mechanics that make machine noise irrelevant

* **Warm up first** — JIT, inline caches, scratch pools. Never measure the first
  N calls.
* **Fixed-OP trials, not wall-clock windows** — every trial does identical work,
  so per-op cost is comparable across trials.
* **Use `Bun.nanoseconds()`** (ns resolution). `performance.now()` is µs and too
  coarse: our own harness showed CV 60-70% with it and 2-3% after switching.
* **Give each trial ≥1 ms of work** so timer resolution is negligible.
* **9-11 interleaved trials per variant, rotating the LEAD position** — machine
  drift then cancels between variants instead of biasing one.
* **Report MEDIAN + MIN + CV%.** The median is robust to preemption/GC outliers;
  the CV tells you whether a delta is even measurable. A result is believable
  when the effect is several times the CV **and** survives a re-run.
* **One thing at a time.** No `cargo build`, no test suite, no other heavy
  process while measuring. A concurrent `cargo build` inflated *every* number
  ~3x in one of our runs — including the JS baseline, which is what made it
  obvious.
* **Re-measure the baseline in the same session** to prove the machine is in the
  same state (a stable baseline is the control).

Reference harness (drop into `/tmp` and import):

```ts
const nowNs = () => Bun.nanoseconds();                 // ns resolution
const trial = (fn: () => void, ops: number) => {       // fixed-op trial
  const t0 = nowNs(); for (let i = 0; i < ops; i++) fn(); return (nowNs() - t0) / ops;
};
// warmup → rounds × rotate-lead interleave → median/min/p95/CV per variant
```

## 3. Pitfalls that produced wrong conclusions here
* **Measure the MEASURING TOOL first.** For months `bench:compare` reported
  ~1,030 rps with p75-p99 latencies of 4-9 SECONDS for bun, elysia and ignus
  alike — the giveaway was that all three identical, including their percentiles.
  The load generator's concurrency gate awaited `Promise.race(activeSet)` while
  at capacity, i.e. O(in-flight) *per completed request*: at
  `maxConcurrent = 10_000` that is 10k reaction registrations for every
  response. Same server, same 8s, same 10k ceiling: **1,811 rps (old gate) vs
  23,608 rps (O(1) counter gate)**. Swapping the gate, sharding the generator
  across processes, and retuning the ceilings moved the reported 03-stress peak
  from **1,044 rps to ~36k rps** for ignus-aot — a 34x measurement error that
  had been read as "all three servers are equal". Rule: if every variant
  reports the same number, you are measuring the harness. Bisect the generator
  (does throughput scale with concurrency? with worker count?) before believing
  any server-vs-server delta.
* **A closed-loop generator's latency is `concurrency / throughput`.** Raising
  the in-flight ceiling past the server's knee inflates p50 linearly while rps
  stays flat (measured: 256 -> 33.6k rps @ p50 7.5 ms; 512 -> 30.9k @ 15.9 ms;
  1024 -> 30.6k @ 32.9 ms). Flat rps + linear latency = the server is saturated
  and the number is trustworthy; rising rps = you were client-limited. Sweep the
  ceiling once per scenario and keep the smallest value that maximises rps.
* **The FFI crossing is invisible at this scale.** A 43 ns crossing cannot show
  up next to 4-10 µs of work. Measure it directly (`ffi.crc32(new Uint8Array(8))`
  = **43 ns**), never infer it from an end-to-end ratio. `IGNEX_FFI_MODE=ffi` vs
  `napi` measured *identical* on the same op — as expected, because the ~100-350 ns
  NAPI crossing is still <2% of the call.
* **"Native" is not automatically faster.** What usually loses is
  **materialization** — turning native bytes back into JS values (new strings)
  costs more than the parse JS already did, because a JS parser returns
  **zero-copy slices of the source string**. Two paths can both be "native" and
  still differ by 2x: the route stack pays a decode, the ingress pipeline does
  not (it only returns a verdict).
* **Keep a control experiment.** An empty-plan route call (`createNativeRoute({
  pipeline: [] }).runParts("", "", null)`) = boundary + wrapper protocol floor
  (~550-610 ns). If the floor does not move, a win came from the work — not from
  the boundary.
* **Separate-boot CPU numbers are indicative only** (thermal/scheduler state).
  Cross-check any per-route CPU delta against an isolated per-op median.
* **Do not trust a single-shot `perf`-less profile either** — use
  `bun --cpu-prof --cpu-prof-md` (writes `<name>.md.md`) under mixed load.
* **A well-formed "parity" suite is not a compatibility proof.** The pair
  parsers had a clean parity suite and a real speed win, yet the native query
  parser THROWS on malformed escapes (see §5.4). Fuzz the malformed space
  against the fallback BEFORE selecting an op — a fast path that can throw
  where the fallback cannot is a DoS surface, not a slower option.
* **A pin can be about correctness, not speed.** When it is, say so in the
  wrapper and leave a tripwire; otherwise the next person unpins it because the
  median looks good. And when the fix lands, SELECT it behind a capability probe
  (`src/decode-compat.ts`) rather than pinning until every environment upgrades —
  an old addon then degrades to the previous behaviour instead of throwing.
* **A pin is transport-specific.** "Native loses" is almost never a property of
  an op; it is a property of the transport you measured. `aeadEncrypt` loses
  0.86-0.93x on the addon (napi) handle and WINS 1.5-2.0x on the C-ABI — the
  framework was pinning it framework-wide from a napi measurement and running the
  slow path for every session encryption on Bun. `crc32` is the mirror image:
  Bun's builtin beats napi by 5.5x and loses to the C-ABI by 1.9x, which is why
  it (like `hmacSha256`/`randomToken`) lives in BOTH `BUN_WINS` and `FFI_WINS`.
  Measure all four implementations (Bun builtin / addon / C-ABI / JS) before
  pinning.
* **A pin's SYMBOL must actually resolve.** `PINNED_NATIVE` checks
  `typeof addon[opName] === "function"`; when the addon's export name differs
  from the op name (napi camelCases `jwt_sign_eddsa` → `jwtSignEddsa`, the op is
  `jwtSignEdDsa`) the check silently returns false and the "structurally pinned"
  op runs the JS fallback — EdDSA JWT sign/verify were doing exactly that
  (1.80x/1.45x left on the table). Grep the addon object for the real names.
* **Short ops need big trials, and varied input.** With `ops = 4,000` a ~50 ns op
  reports cv 60-160%, and a CONSTANT input lets the JIT const-fold the whole
  call (a regex test measured 1.7 ns — the result was hoisted). Use 100k ops per
  trial and a rotating input pool, then read `min` (the median of a 50 ns op is
  mostly noise).

### 3.1 Fuzz for compatibility (recipe)

```ts
// charset weighted to the dangerous bytes: separators, escapes, truncations,
// multibyte, NUL; compare EVERY input against the fallback.
for (const text of cases) {
  let native: unknown;
  try { native = nativePath(text); } catch (e) { throws++; record(text, e); continue; }
  if (JSON.stringify(native) !== JSON.stringify(jsFallback(text))) mismatches++;
}
```

Real result for the packed query parser (20,011 inputs): **17,496 throws**
(`query: parse failed`) and **322 mismatches** (lossy UTF-8 vs the fallback's
"return the segment raw"). That is why `queryPairs` started out pinned to JS.
After the castrum 0.9.5 decoder fix (one shared implementation with the JS
contract) the same fuzz plus 200k generated inputs — 400,520 comparisons across
both packed parsers — reports **0 throws / 0 mismatches**, and the op is selected
past 512B. Note the fuzz must compare on the BYTES the native side sees: a lone
surrogate cannot be encoded (`TextEncoder` substitutes U+FFFD), so comparing a
raw JS string against its encoded bytes reports failures that are not decoder
differences.

## 4. Need-to-know numbers (idle machine, 2026-09-11)

Payload unless stated: 60 query params (2055 B, 80 `%` escapes) + 30 cookies (602 B).

| measurement | value |
| --- | --- |
| FFI crossing floor (`ffi.crc32(8B)`) | **43 ns** |
| empty-plan route call (boundary + wrapper protocol) | **~550-610 ns** |
| Rust route parse (optimized, in-crate, no boundary) | **3,998 ns** (was 9,494) |
| route result decode, 95 pairs / 3055 B (ASCII fast path) | **6,143-6,347 ns** (was 10,225-11,213) |
| **full route call** (optimized Rust + optimized decode) | **11,439 ns** (was 21,623) |
| JS `queryPairs` + `cookiePairs`, same payload | ~13,800 ns |
| native route stack vs JS, same payload | **1.20x native** (was 0.80x) |
| `queryPairs` gated wrapper vs JS fallback, 589B / 1.1KB / 2.2KB | **1.04x / 1.14x / 1.19x native** (below 440B: 0.98-1.06x JS — the 512B gate) |
| `aeadEncrypt` C-ABI vs JS, 64B / 512B / 4KB | **2.02x / 1.73x / 1.64x native** |
| `aeadEncrypt` ADDON (napi) vs JS, same sizes | 0.89x / 0.93x / 0.86x (js wins — hence the transport split) |
| body validate — valid / invalid, native vs `JSON.parse`+Ajv | natives 40.0 µs (2.23x SLOWER) / 12.9 µs (**1.45x faster**) |
| ingress pipeline (query+cookie+CORS) vs JS equivalent | 10.8 µs vs 13.9 µs |
| retained heap growth per `GET /health`, WS0 protocol (5 × 10k, post-full-GC; `bench:allocations`, 2026-09-18) | **median 4.8 B/req** (JIT first round ~85 B excluded; rounds 2–5: 1.1–19.6 B) |

Rule of thumb from the table: **native wins where no JS values are
materialized** (verdicts, rejects, preflight) and **loses where they are**
(pairs, accepted bodies) — unless the native side avoids the copy.

## 5. Recipes

### Rust-native (zero boundary) — in-crate probe

Add a `#[cfg(test)]` timing test beside the code under test (e.g.
`rust/ingress/native_route.rs` `mod tests`, reusing its `descriptor()` /
`frame()` helpers), read payloads from `/tmp` so Bun and Rust see identical
bytes, then:

```bash
cargo test --release --manifest-path ../castrum/Cargo.toml --lib <test> \
  -- --nocapture --test-threads=1        # prints ns/op (median of N)
```

### Build the addon + inject it

```bash
cd ../castrum && cargo build --release --lib          # → target/release/libcastrum.so
cp target/release/libcastrum.so castrum-local.node    # any name; keep it inside a package dir
IGNEX_NATIVE_PATH=/abs/path/castrum-local.node bun <harness>
```

`IGNEX_NATIVE_PATH` must resolve: the loader walks UP from the file to the
nearest `package.json`, so put it inside a package directory (a bare `/tmp/x.node`
will be ignored and the registry addon used instead — a silent wrong-config trap).
Note `bun run build` (`napi build`) needs `node_modules`; for FFI-only
measurement the plain `cargo build --release --lib` cdylib is enough.

### Transport axis

```bash
IGNEX_FFI_MODE=napi bun <same harness>   # vs default (auto → bun:ffi C-ABI)
```

### Castrum-side benches

```bash
cd ../castrum && bun run bench:ffi | bench:cost | bench:router | bench:http
```

### Bun FFI practices — what we use, and what each one buys

Verified against Bun 1.4.2 (`bun:ffi` docs), measured where measurable:

| practice | status here | measured effect |
| --- | --- | --- |
| `read.u8/u32/u64/...` for short-lived pointers (no `DataView`/`ArrayBuffer` allocation) | ✅ `ffi-read.ts` (`ffiU32`/`ffiU64`/`ffiString`) | part of the 43 ns crossing floor |
| `CString(ptr, byteOffset, byteLength)` for UTF-8 reads | ✅ `ffiString` | ditto |
| `buffer`/`buffer_length` (engine snapshots ptr + byteLength off ONE object — no stale-length hazard with resizable/transferred buffers) | ✅ probe-gated (`probeBufferLength`) with `(ptr, usize)` fallback | **1.01x** vs `(ptr, usize)` at 8 B and 2 KB → it is an atomicity/API win, NOT a speed one. Don't expect throughput from it. |
| `dlopen`/`linkSymbols` are implemented natively in JSC (hot call sites compile to direct calls, no per-arg shim) | ✅ used directly | why a crossing is 43 ns, not µs |
| Pass the TypedArray itself where `ptr` is expected | ✅ everywhere | zero manual `ptr()` bookkeeping |
| `bun:ffi` does not manage memory — free what you allocate | ✅ audited 2026-09-18 (WS3): every `*Create` has its `*Destroy`/free — `routeCompile`↔`routeDestroy` (route.ts:143), `metricsCreate`↔`metricsDestroy` (metrics.ts:352), napi `Ingress`/`Route` ctor↔GC-managed `destroy()`, task runtime↔`shutdown()`. All handles are created ONCE at boot (module-level route consts, eager pipeline init, one registry) and never per-request; the destroys exist and are wired but the compiled server intentionally never calls them (handle dies with the process) — **bounded boot-time handles, not a leak-under-load class**. The one honest gap: an app that tears down and rebuilds a server repeatedly in one process would accumulate route handles (no stop-hook path frees them) — no such app exists in-repo; the fix is a lifecycle stop-hook flush, not a hot-path change. |
| Pointer alignment: an API expecting `u32*` needs a `Uint32Array`, not `Uint8Array` | ✅ castrum's reads are slice/unaligned-safe (`read_u32_at`) | — |
| `toArrayBuffer(bytes, off, len, deallocator)` for zero-copy native buffers | not used (native returns copied JS strings/views; no ownership hand-off) | — |
| `JSCallback.prototype.ptr` instead of the object | n/a — no callbacks in this bridge | — |
| `bun:ffi` is documented as experimental; Node-API is the stable path | ✅ both are first-class: `IGNEX_FFI_MODE=auto\|ffi\|napi` | transport axis measured identical on the same op (the 100-350 ns NAPI crossing is <2% of a call) |

## 6. Where things live

* **ignex FFI layer**: `packages/native/src/ffi/` (bindings), `ffi-read.ts`
  (fast reads), `packed.ts` (wire decode), `scratch.ts` (buffer pool),
  `route-wire.ts` + `route.ts` (route v3 wire), `selection.ts` (**single source
  of truth** for which impl wins; `MEASURED_JS_WINS` holds the measured
  overrides) + `runtime.ts` `FFI_WINS` (**C-ABI-only** overrides — the second
  place a decision can live), `ingress/` + `pipeline.ts` (pre-flight),
  `telemetry.ts` (degradation reasons — check it before assuming "no addon").
* **castrum Rust**: `rust/ingress/native_route.rs` (route wire v3),
  `rust/ffi/route.rs` (`castrum_route_*` C-ABI), `rust/ingress/{packed,api}.rs`,
  `rust/util/bytes.rs` (lenient decoders).
* **castrum checkout**: `/home/adeel/poc/castrum`. `cargo test --release`
  is the crate gate; `cargo clippy --release --lib -- -D warnings` and
  `cargo fmt --check` too. ignex installs the **registry** build
  (`node_modules/.bun/castrum@0.9.4+…`), so a local build must be injected to be
  measured at all.
* **Build pitfall**: `sha2` must stay on **0.10** while `pbkdf2 0.12` is in use
  (pbkdf2 is on digest 0.10; sha2 0.11 breaks `pbkdf2_hmac::<Sha256>` with E0277
  `CoreProxy`). A Dependabot bump did exactly that and broke `cargo test`.

### CPU per request at a pinned pace (framework-vs-baseline comparisons)

**Use this, not rps, when comparing whole servers.** rps A/B varies ±8% run to
run on a shared machine — larger than most optimizations — and conflates "does
less work" with "is more efficient".

```bash
bun run bench:compare:cpu                  # all participants, 3×8s, medians
SERVER=bun,ignus-aot bun run bench:compare:cpu
bun run bench:compare:cpu:gate             # exit 1 if ignus-aot/bun > 1.0x
```

Every participant is driven at the SAME fixed rate (default 15k rps: below
saturation, so no queueing) and the server's own `process.cpuUsage()` is
divided by the requests served. Rounds alternate between participants and the
reported number is the median, so drift hits everyone equally. Spread between
rounds observed: ±0.2µs.

`bench/compare/cpu-wrap.ts` is what makes this possible — `Bun.spawn` exposes
no child CPU accounting, so the participant is started through a wrapper that
reports its own CPU time on SIGTERM.

**Trap (cost a whole round):** `bench/compare/servers/ignus-aot-server.ts`
compiles on import, so spawning it directly keeps the entire compiler +
bundler resident in the server's heap — measured **35.4µs/req vs 33.2µs/req**
for the same compiled entry spawned alone. It made the AOT participant look
*slower than the interpreted one*. `cpu.ts` therefore builds once
(`BENCH_BUILD_ONLY=1`) and measures `dist/__server.js` in a clean process.

Layer attribution is done with matched variants (same harness, one layer
removed) — see §7.1 for the table.

Baseline (2026-09-18, 3×8s @ 15k rps, medians): `bun` 23.25µs, `elysia` 31.76µs,
`ignus-aot` 30.35µs (**1.306x**), `ignus` 34.88µs, `ignus-native` 34.91µs.
Refreshed from the 2026-09-14 baseline (`bun` 23.28µs … `ignus-aot` 33.24µs,
1.428x) after the specialized-context tier landed 2026-09-15 → 09-18 — that
work moved the AOT ratio from **1.428x down to 1.306x**.

Same-day WS1 refresh (after fused lifecycle lanes, 09-18): `bun` 22.49µs,
`ignus` 33.42µs, `ignus-aot` 28.68µs (**1.275x**). The ~0.7µs/req move is
below the §6 resolution floor (round spread 28.47–30.10µs overlaps the WS0
value), so the fused lanes are argued *structurally*, not from this run
(§7.2) — semantics parity is gated by the boot-time `__fusedOK` count check +
the fused-vs-runtime parity net.

#### Resolution limit — read this before concluding "no change"

**`bench:compare:cpu`'s ratio has ±2–3% run-to-run noise.** Concretely: the
identical-server control (three entries pointing at the same server, 4 rounds)
measured 23.41 / 23.66 / 23.66µs, and the `ignus-aot / bun` ratio across runs
bounced between 1.413 and 1.448 for unchanged code. **A change smaller than
~1µs is invisible in this mode.** Do not conclude "no effect" from it.

For anything under ~1µs, use a **head-to-head interleaved A/B instead**: add the
two variants as separate entries in ONE run so both see identical machine
conditions, e.g.

```ts
// temp measurement hook in the code under test, read once at module load
const __STYLE = process.env.IGNEX_ACC_STYLE;
```

```ts
// /tmp/var-a.ts
process.env.IGNEX_ACC_STYLE = "a";
process.env.PORT = "9141";
await import("/tmp/full-server.ts");
```

This caught a real case: a cross-run comparison suggested an accumulator change
was worth 2.35µs; the head-to-head measured **0.79µs** (dict 33.14µs vs literal
32.35µs). Cross-run deltas on this machine are not trustworthy — several
"no measurable change" readings during the same investigation were real effects
sitting below the resolution limit.

## 7. The framework's own cost budget — measured, and what is already ruled out

Everything below was measured on the comparison bench over 2026-09-14 → 09-15.
The specialized-context tier landed 2026-09-15 → 09-18 and changed the
baseline (see the dated line in §6): `ignus-aot` fell from 33.24µs (1.428x) to
30.35µs (**1.306x** vs bun 23.25µs). It is kept so the same questions are not
re-litigated: **most plausible-sounding optimisations here were tried and lost
to the measurement.** Numbers move as the codegen changes; the *conclusions*
have held.

### 7.1 Layer attribution (matched variants, one layer removed; medians ±0.2µs)

| config | CPU/req | delta vs `bun` |
| --- | --- | --- |
| `bun` (raw `Bun.serve` routes) | 20.72µs | — |
| `bare` ignex (no plugins, no hooks) | 23.62µs | **+2.90** — framework core |
| `+ cors + security` | 28.90µs | +5.28 — **plugin dispatch** |
| `+ guard` (one `beforeHandle` hook) | 34.45µs | +5.55 — **hook dispatch** |

The plugin bodies are one `headers.get("origin")` and one `WeakSet` probe: the
cost is *dispatching* the work, not doing it.

### 7.2 Where the cost ended up (after the AOT work)

- The framework's own JS is **~1.5µs of a 30.46µs request**; routing + wrapper +
  context + reply finalize ("plumbing") is **~1.25µs**.
- **No dispatch/context/reply bottleneck remains.** Routing is already
  `Bun.serve({ routes })` (Bun's native trie) plus thin wrappers; every function
  on the request path has been measured, the largest being 1.3µs.
- ~12.5µs of the budget is Bun's own HTTP floor and ~4.5µs is its header/JSON
  serialisation — not reachable from JS.
- **The framework's JS cannot be profitably moved to Rust FFI.** The C-ABI
  crossing is ~3ns, so the boundary is not the barrier — **marshalling** is:
  every context/hook field is a JS string costing ~40–46ns to encode or
  transcode. Byte-oriented work does win (§4); object-shaped work does not.
- **Re-baselined (2026-09-18):** a CPU profile under the same 03-stress mix at
  15k rps, both participants driven through `cpu-wrap.ts`, sampled **66
  distinct named functions** in the AOT artifact vs **23** in raw Bun (a **2.9x**
  function-count gap; cf. the older "~406 vs ~50 functions/request" figure in
  §7.3, which was a different per-request metric). Retained heap growth per
  `GET /health` request after full `gc()` settles at **~1–5 B** (5 rounds × 10k
  reqs, 32-way; median 68.5 B once the first rounds' JIT warm-up transients are
  included) — the request path retains essentially nothing per request.
- **WS3 resource pass (2026-09-18):** allocation-count bench (bench:allocations, post-full-GC, 5 rounds x 10k reqs) reports median 4.8 B/req retained (JIT first round ~85 B excluded; rounds 2-5: 1.1-19.6 B, consistent with WS0 1-5 B). RSS-stability probe (check-rss-stability, 3 min load + full-GC settle every 5s) reports bounded drift - end drift -11.2% vs 20% threshold; peak drift 1.27% (informational); verdict PASS. ignus-aot/bun 1.264x (29.24us vs bun 23.13us, bench:compare:cpu at 15k rps pinned, 8s x 3 alternating rounds).
- **WS1 fused lifecycle lanes (2026-09-18):** an app whose whole plugin layer is
  statically attributed and carries no user lifecycle now composes the plugin
  hooks DIRECTLY at boot (`buildFusedChains` → `runFusedPre`/`runFusedPost` in
  `core/lifecycle/fused.ts`) instead of walking the HookContainer stage arrays
  on every request. Per-request saving by construction: no container wrapper
  frame, no synthesized `{ ctx }` result object per hook, no stage-array walk.
  The compiler emits the dispatchers in every build with a boot-time structural
  gate (`__fusedOK` count check) and falls back to `runHooks` on any mismatch,
  so the lanes are identical semantics by construction; correctness is gated by
  the fused-vs-runtime parity net and the emitted-lane smoke runs.

### 7.3 Ruled-out hypotheses — do not re-attempt

| Hypothesis | Result |
| --- | --- |
| Reply path (`JSON.stringify`+`encode` vs `Response.json`) | Already **wins**: manual encode 1.30M ops/s vs `Response.json` 844k. |
| Response header-construction shape / post-hoc `Headers.set` | Fixed (0 `Headers.set`/request, proven with a prototype counter). **No measurable change.** |
| HSTS / `isHttpsRequest` per response | **Free** — 34.33 vs 34.45µs. |
| Async stage runners / microtask hops | **Noise** (~0.1µs); reverted. |
| `applySet` / `serializeCookie` allocations | Fixed and verified. **No measurable change.** |
| Object pooling, boot-time hoisting, Bun-specific APIs | **No win.** The context constructor's cost is not its allocations. |
| Rust/castrum for the JS object path | **Not applicable** — see §7.2. |
| Cross-module usage union in the analyzer | ~0.2µs, not the 2.4µs it was expected to be worth. |
| Request headers as a µs-scale cost | **Refuted.** `ctx.headers` is lazy (correct, free, small). |
| Micro-optimisation generally | Each lands ~0.2µs against a multi-µs gap. The profile shows **~406 functions/request vs Bun's ~50** — the cost is the count, not a hotspot. |
| Replacing `pino` with an in-repo logger (drops 13 packages) | **Rejected — 2.39× slower** per line (1,645 vs 689 ns; interleaved medians, 200k iters × 7 rounds, identical discarding sink). Precomputing the redaction rule tree and caching the numeric level threshold only moved it 2.55× → 2.39×; the remainder is pino's hand-rolled stringifier + async `sonic-boom` sink. Not worth owning redaction correctness for ~1.1 MiB. |
| Replacing `ajv`/`ajv-formats` (6 packages) with `typebox/compile` | **Impossible, not merely expensive.** `compiler/src/phases/validators.ts` emits **Ajv standalone** modules into `validators/*.cjs`, and `core/src/data/schema.ts` uses Ajv as the documented mutation/oracle (`coerceTypes` / `removeAdditional` / `useDefaults` + `ErrorObject` shapes). No other engine emits standalone validators. |
| Hand-rolling `lru-cache` / `defu` / `citty` / `@clack/prompts` | **Declined on cost/benefit, not feasibility** — 1, 1, 1 and 6 packages respectively (but `lru-cache` is 2.67 MiB of the install), each traded for owning internals or a CLI-framework rewrite. `CompilerOptions` is flat scalars, so a local merge would in fact be equivalent — still not worth it. |
| `@ignex/mcp` as a hard `@ignex/cli` dependency | **Fixed (was the biggest lever found):** it dragged the MCP SDK (**91 packages**) into every `@ignex/cli` and `create-ignex` install. Now an optional peer + dynamic import. |

The one codegen-shaped lever left is **declarative plugin context requirements**:
a plugin's `onResponse`/`beforeHandle` receives the context, so the compiler must
assume the full context and no route specializing behind a plugin can use the
lean tier (measured cost of that: **2.24µs**). Letting a plugin *declare* what it
needs — the pattern `responseDefaults` already uses — is the change that unlocks
it. A plugin that declares nothing must keep forcing the full context, so it is a
plugin-API change with its own compatibility story, not a codegen tweak.

### 7.4 Measurement rules earned here

- **Benchmark a dependency with the same instrument you use it with.** pino
  measured only 2.39× ahead when its async `sonic-boom` destination is
  replaced by a discarding sink; the gap is *wider* on the real stdout path.
  A swap that looks free in a hot loop can be a per-request tax once served.
- **Pace at ≥12k rps** (`SERVER=` on `bench:compare:cpu`): the curve is steep
  below ~8k and flat above ~12k. Always include ≥3 identical variants as the
  control and report the control next to every number.
- **AOT source changes resolve to ~1µs, not 0.1µs.** Each variant needs its own
  run (`cpu.ts` rebuilds `dist/__server.js` once per invocation), so run-to-run
  drift is no longer cancelled in-invocation. Below ~1µs, argue the change
  **structurally, not from the number**.
- **Ablate in ONE process with alternating rounds**, never as sequential runs:
  four sequential variants once reported `nocookie` — which *removes* work — as
  *worse* than base, which is impossible.
- **Clear `dist/` before every build** when A/B-ing a source change: the compiler
  cache will otherwise reuse a stale bundle and silently re-measure the previous
  variant.
- **`Bun.serve`'s `headers` option is silently ignored** — it does not merge into
  responses. Verify a "free" header is actually on the wire.
- **A plugin's in-situ cost is ~10–20× its hot-loop cost** (cold call sites / ICs
  / GC). Price plugin work by serving it, not by looping it.
- **Wrapping a definition only observes non-inlined call sites.** When the
  bundler inlines, per-function instrumentation undercounts — read any
  per-function budget as a **lower bound**.
- **Check what the other participant is doing before quoting a cross-framework
  gap.** `ctx.ip` alone costs **3.37µs served** (780ns isolated) because it calls
  `server.requestIP()`; a port that skips that call, or reuses an already-parsed
  query/cookie state, is doing measurably less work. See
  `docs/comparison-bench.md`.
