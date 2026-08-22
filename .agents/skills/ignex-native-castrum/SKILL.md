---
name: ignex-native-castrum
description: Work inside @ignex/native (packages/native) — the typed bridge over the castrum Rust addon, the SELECTION table, byte-compatible pure-TS fallbacks, and the route-wire v3 native route contract. Use when touching native primitives or native routing.
---

# ignex: Native bridge (`@ignex/native` × castrum)

`@ignex/native` is the **single typed bridge** over the **castrum** Rust addon
(`optionalDependencies: { "castrum": "^0.9.1" }`; the dev checkout lives at
`/home/adeel/poc/bun-rust-runtime-bench`). Native is **pure acceleration**:
importing this package never throws — every primitive has a byte-compatible
pure-TS fallback. `docs/native-acceleration.md` is the full reference.

## Key files (`packages/native/src/`)

| File | Role |
| --- | --- |
| `selection.ts` | ★ `SELECTION` table — single source of truth for which impl wins (`impl`, `nativeRatio`). **Read-only data — never mutate.** |
| `execution.ts` | Unified execution API: `backend.*` groups ops by domain, binds each to the fastest impl; `implFor(op)`, `createExecutionBackend`, `executionStatus`, `initNative` |
| `index.ts` | Flat parity-testable surface: `jwtSign`/`jwtVerify`, `hmacSha256`, `passwordHash`/`passwordVerify`, `randomToken`, `signCookie`/`verifyCookie`, `csrfToken`/`csrfVerify`, `aeadEncrypt`/`aeadDecrypt`, `ed25519` helpers + every `*Fallback` twin |
| `crypto.ts` / `hash.ts` / `json.ts` / `packed.ts` / `payload.ts` | Op domains (hashing, JSON, packed pairs, payload) |
| `bun.ts` | Bun built-in delegation (some ops are faster as Bun built-ins than the Rust addon — measured in castrum's bench) |
| `http/` + `ingress.ts` + `native-handler.ts` + `ratelimit.ts` | Native HTTP helpers (ingress pipeline wrappers) |
| `ffi.ts` / `ffi-read.ts` / `loader.ts` | Addon loading + FFI transport: `loader.ts` `require()`s the castrum NAPI `.node` (never bare `import` — tsconfig paths stub it); `ffi.ts` additionally `dlopen`s the SAME binary via `bun:ffi` (`IGNEX_FFI_MODE=auto\|ffi\|napi`, cstring args, bind-time self-test). Path comes from `getAddonPath()` (shared by both transports) via `IGNEX_NATIVE_PATH` override — there is NO `IGNEX_FFI_PATH` env var |
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
