# Performance

ignex doesn't publish "Nx faster than X" marketing numbers. It publishes a
[methodology](https://github.com/Axylabs/ignex/blob/main/docs/comparison-bench.md),
a [cost budget](https://github.com/Axylabs/ignex/blob/main/docs/perf-methodology.md),
and a set of gates that run in CI on every change. This page is the honest
summary.

## Where the speed comes from

**The build, not the runtime.** A conventional framework matches routes,
validates, and serializes while requests arrive. ignex does all three while
*compiling*:

1. **Native routes table** — every route is registered in Bun's Rust route
   matcher. There is no JS trie and no per-request string scan.
2. **Precompiled validators** — your TypeBox schemas become standalone Ajv
   validators at build time.
3. **Per-status serializers** — response shapes precompiled per status
   code.
4. **Usage-specialized contexts** — the compiler reads which `ctx` members
   each handler touches and builds a context with only those.
5. **Constant-response hoisting** — a handler that provably always returns
   the same response becomes a pre-built `Response` bound into the routes
   table: served in Rust, zero per-request JavaScript.

## The Rust addon (castrum)

On top of AOT, the optional `@ignex/castrum` addon (via `@ignex/native`)
accelerates the byte-heavy paths — query/cookie parsing, body-schema
validation, AEAD crypto, base64 — through a Rust addon. Measured highlights
from ignex's own benches:

- **Ingress route** (query + cookies parsed natively): ~90k RPS vs ~48k for
  the JS `URLSearchParams` path.
- **Full native route call**: 11,439 ns vs ~13,800 ns pure-TS on the same
  payload (60 params, 30 cookies) — and 1.51× on a fused
  query+cookie+body-schema route.
- **Invalid-body rejection**: 1.45× vs JSON.parse+Ajv.
- AEAD encryption 1.6–2× faster at 64B–4KB; base64 decode up to 3×.

Also measured honestly: **crossovers exist**. Validating a *valid* body
natively is currently slower than the compiled prelude — which is exactly
why the adopt/reject table is per-path, and why some lanes deliberately
stay in JavaScript. The engineering rule: *native pays for byte-heavy work,
not small-route assembly.*

## Native is acceleration, never a requirement

If the addon is missing — a platform without prebuilt binaries, a locked-
down environment — every native path transparently falls back to a
**byte-compatible pure-TS implementation**. Same behavior, same wire
output. `IGNEX_NATIVE=off` forces the fallback everywhere and is a CI gate
(`bun run smoke:fallback`), so the no-native mode is tested as rigorously
as the accelerated one.

The parity rule: a native path must produce byte-identical output to its
fallback, or it doesn't ship.

## Measuring it yourself

```sh
bun run bench              # micro benchmarks
bun run bench:server       # server-level route benches
bun run bench:compare      # Bun vs Elysia vs ignex, identical route contract
bun run bench:compare:gate # the regression gate used in CI
```

The comparison harness runs the **same route contract** against Bun's raw
`Bun.serve`, Elysia, and ignex, with a weighted-flow loader and noise
controls — and it flags honestly when results are client-limited. The
headline metric is **peak sustained RPS**; per-flow latency distributions
are in `docs/comparison-bench.md` in the repo.

## What this means for your app

- The framework's per-request overhead is small and **constant** — your
  handlers and I/O dominate, as they should.
- Dev-mode adds tracing for the debugbar; production builds eliminate it
  entirely.
- Don't trust any framework's numbers (including ours) — run
  `bench:compare` against your *actual* route shapes before committing.
  The methodology doc tells you how to do it without fooling yourself.
