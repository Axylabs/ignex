---
name: ignex-native-castrum
description: Work inside @ignex/native (packages/native) — the typed bridge over the castrum Rust addon, the SELECTION table, byte-compatible pure-TS fallbacks, and the route-wire v3 native route contract. Use when touching native primitives or native routing.
---

# ignex: Native bridge (`@ignex/native` × castrum)

`@ignex/native` is the **single typed bridge** over the **castrum** Rust addon
(`optionalDependencies: { "castrum": "^0.9.6" }`; the dev checkout lives at
`/home/adeel/poc/castrum`). Native is **pure acceleration**: importing this
package never throws — every primitive has a byte-compatible pure-TS fallback.
`docs/native-acceleration.md` is the full reference.
`docs/perf-methodology.md` is the **measurement runbook** — read it before
touching perf: it records the mechanics that make machine noise irrelevant and
the numbers to expect (FFI crossing 43 ns, empty-plan route call ~550-610 ns,
optimized Rust route parse ~4.0 us, optimized pair decode ~6.1-6.3 us, full route
call ~11.4 us, JS pairs ~13.8 us; body validate is 2.23x SLOWER to accept
natively but 1.45x FASTER to reject; **native wins only where no JS values are
materialized**).

Three hard-won rules from that runbook, because each one cost a wasted round:
**fuzz the malformed input space before selecting an op** (a well-formed parity
suite is not a compatibility proof — the packed query parser was 1.17-1.22x
faster past 589B and still unsafe: it THREW on malformed escapes, 17,496 of
20,011 fuzzed inputs, until castrum 0.9.5 made the decoder match JS
`decodeURIComponent`), **charge the real path** (encode/transcode costs inside the
timed variant — pre-encoding the native input flattered it enough to move the
crossover ~150B), and **a pin is transport-specific** ("native loses" describes a
TRANSPORT, not an op: `aeadEncrypt` lost 0.86x on the addon/napi handle but WINS
1.5-2.0x on the C-ABI, and `crc32` is the mirror image — Bun beats napi 5.5x and
loses to the C-ABI 1.9x — which is why both live in `BUN_WINS` *and* `FFI_WINS`).
Two traps that decided Round 24: a pin's **symbol must resolve** (napi exports
`jwtSignEddsa` while the op is `jwtSignEdDsa`, so the "structurally pinned" EdDSA
JWT ops silently ran JS — 1.80x sign / 1.45x verify left on the table), and short
ops need **100k-op trials with VARYING input** (a constant lets the JIT const-fold
the call: a regex test measured 1.7 ns).

## Working against the local castrum checkout (`bun link`)

See `docs/ai/LOCAL_DEV.md` for the full workflow. Short version:
`cargo build --release --lib` + copy to `castrum.linux-x64-gnu.node`, run
`bash scripts/build-v3.sh` for the x86-64-v3 SIMD variant the loader prefers,
then `bun link` in the checkout and link/symlink it into
`packages/native/node_modules/castrum`. Always confirm what the loader actually
resolved — a lingering `IGNEX_NATIVE_PATH` export silently wins over the link:

## Key files (`packages/native/src/`)

| File | Role |
| --- | --- |
| `selection.ts` | ★ `SELECTION` table — single source of truth for which impl wins (`impl`, `nativeRatio`). **Read-only data — never mutate.** |
| `execution.ts` | Unified execution API: `backend.*` groups ops by domain, binds each to the fastest impl; `implFor(op)`, `createExecutionBackend`, `executionStatus`, `initNative` |
| `index.ts` | Flat parity-testable surface: `jwtSign`/`jwtVerify`, `hmacSha256`, `passwordHash`/`passwordVerify`, `randomToken`, `signCookie`/`verifyCookie`, `csrfToken`/`csrfVerify`, `aeadEncrypt`/`aeadDecrypt`, `ed25519` helpers + every `*Fallback` twin |
| `crypto.ts` / `hash.ts` / `json.ts` / `packed.ts` / `payload.ts` | Op domains (hashing, JSON, packed pairs, payload) |
| `bun.ts` | Bun built-in delegation (some ops are faster as Bun built-ins than the Rust addon — measured in castrum's bench) |
| `http/` + `ingress.ts` + `native-handler.ts` + `ratelimit.ts` | Native HTTP helpers (ingress pipeline wrappers) |
| `tasks.ts` | Off-thread task runtime bridge (castrum 0.9.6 "castrum Tasks"): async `createTaskRuntime()` + `isNativeTaskRuntime`; prefers castrum's Rust pool, falls back to a synchronous pure-TS runtime (byte-identical output). |
| `ffi.ts` / `ffi-read.ts` / `loader.ts` | Addon loading + FFI transport: `loader.ts` `require()`s the castrum NAPI `.node` (never bare `import` — tsconfig paths stub it); `ffi.ts` additionally `dlopen`s the SAME binary via `bun:ffi` (`IGNEX_FFI_MODE=auto\|ffi\|napi`, bind-time self-test). Path comes from `getAddonPath()` (shared by both transports) via `IGNEX_NATIVE_PATH` override — there is NO `IGNEX_FFI_PATH` env var. **Match the real C-ABI signature**: `cstring` ARGs are NUL-terminated, so byte inputs use `(ptr,len)` (validator `*_bytes`, `castrum_accept_negotiator_negotiate`) — binding a `(ptr,len)` symbol as `cstring` leaves the length register uninitialized (worked on Linux by luck; failed on macOS). |
| `route.ts` / `route-wire.ts` | ★ route-wire v3: `createNativeRoute(plan)` — compile a route descriptor once, run each frame in ONE native call (see castrum's `docs/NATIVE-ROUTE.md`; pins `ROUTE_DESC_VERSION`) |
| `runtime.ts` | Runtime detection + `isNativeAvailable` |

## Conventions

- **Never import castrum directly outside `packages/native`** — other packages
  use `backend.*` / named exports from `@ignex/native`.
- Every new native op needs a byte-compatible `*Fallback` and a `SELECTION`
  row; `test:native:real` and the parity checks
  (`verify:native:ffi`, `verify:native:route`) gate correctness.
- `IGNEX_NATIVE=off` must behave identically (the `smoke:fallback` gate runs
  this way); `IGNEX_NATIVE_PATH` points at a custom addon build.
- The cstring/zero-text-encoding FFI conventions live in castrum
  (`bun-rust-runtime-bench/docs/FFI_BUN_GUIDE.md`); when changing the wire
  contract here, keep byte parity with castrum's `castrum_route_*` exports.
- `@ignex/core` re-exports the whole unified surface (`backend`, `SELECTION`,
  `implFor`, `createNativeRoute`, …) — consumers get it from `@ignex/core`.

## Verify

- `bun run test:native` (vitest) and `bun run test:native:real`
  (`--no-file-parallelism`, real addon paths).
- `bun run verify:native:ffi` and `bun run verify:native:route` (parity gates).
- After changes: `bun run smoke` + `bun run smoke:fallback`; benchmark impact
  via `bun run bench:native` / `bench:ffi` / `bench:jwt*`.
