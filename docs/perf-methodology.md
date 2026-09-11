# Performance methodology — measuring ignex × castrum without fooling yourself

Everything in this file was learned by getting it wrong first. Follow it and you
do not have to re-litigate "is this real?" every time the native layer is
touched. Companion reading: `docs/native-acceleration.md` (what the native
layer is), `docs/performance-baseline-2026-08.md` (the measured history).

## 1. The three-level ladder

Measure at the level that matches the claim; each answers a different question.

| level | tool | question |
| --- | --- | --- |
| **op** | `bun run bench:native:all` (`scripts/bench-native.ts`) | does native beat the JS fallback for THIS primitive? (also prints the SELECTION **MISMATCH** worklist) |
| **call** | fixed-op harness on `createNativeRoute` / `nativeFor(op)` (recipe below) | what does one real call cost, and where inside it? |
| **server** | `bun run bench:server` + `bun run bench:server:check` | what does a saturated server do end-to-end? (the CI gate) |

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
| `bun:ffi` does not manage memory — free what you allocate | ⚠️ audit per surface: every `*Create` needs its `*Destroy` (instances/routes/metrics hold handles alive from JS) | leak = RSS growth under load, not a latency change |
| Pointer alignment: an API expecting `u32*` needs a `Uint32Array`, not `Uint8Array` | ✅ castrum's reads are slice/unaligned-safe (`read_u32_at`) | — |
| `toArrayBuffer(bytes, off, len, deallocator)` for zero-copy native buffers | not used (native returns copied JS strings/views; no ownership hand-off) | — |
| `JSCallback.prototype.ptr` instead of the object | n/a — no callbacks in this bridge | — |
| `bun:ffi` is documented as experimental; Node-API is the stable path | ✅ both are first-class: `IGNEX_FFI_MODE=auto\|ffi\|napi` | transport axis measured identical on the same op (the 100-350 ns NAPI crossing is <2% of a call) |

## 6. Where things live

* **ignex FFI layer**: `packages/native/src/ffi.ts` (bindings), `ffi-read.ts`
  (fast reads), `packed.ts` (wire decode), `scratch.ts` (buffer pool),
  `route-wire.ts` + `route.ts` (route v3 wire), `selection.ts` (**single source
  of truth** for which impl wins; `MEASURED_JS_WINS` holds the measured
  overrides) + `runtime.ts` `FFI_WINS` (**C-ABI-only** overrides — the second
  place a decision can live), `ingress.ts` + `pipeline.ts` (pre-flight),
  `telemetry.ts` (degradation reasons — check it before assuming "no addon").
* **castrum Rust**: `rust/ingress/native_route.rs` (route wire v3),
  `rust/ffi/route.rs` (`castrum_route_*` C-ABI), `rust/ingress/{packed,api}.rs`,
  `rust/util/bytes.rs` (lenient decoders).
* **castrum checkout**: `/home/adeel/poc/castrum` (the older
  `bun-rust-runtime-bench` path in some notes is stale). `cargo test --release`
  is the crate gate; `cargo clippy --release --lib -- -D warnings` and
  `cargo fmt --check` too. ignex installs the **registry** build
  (`node_modules/.bun/castrum@0.9.4+…`), so a local build must be injected to be
  measured at all.
* **Build pitfall**: `sha2` must stay on **0.10** while `pbkdf2 0.12` is in use
  (pbkdf2 is on digest 0.10; sha2 0.11 breaks `pbkdf2_hmac::<Sha256>` with E0277
  `CoreProxy`). A Dependabot bump did exactly that and broke `cargo test`.
