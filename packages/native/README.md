# @ignex/native

Rust-accelerated primitives for ignex with **byte-compatible pure-TS
fallbacks**. Every function ships two ways: an auto-preferring wrapper
(e.g. `fnv1a64`) and an explicit fallback (`fnv1a64Fallback`).

## How it works

- `src/loader.ts` **first-class**: loads the castrum `.node` NAPI binary
  directly via `require()`/`process.dlopen` (Node-API modules can't be
  ESM-`import`ed under Bun), resolved from the castrum package directory —
  bypassing the root tsconfig `paths` stub that would otherwise hijack a bare
  `import("castrum")` at runtime. It **never throws** — if the addon is
  missing, `native = null` and every wrapper falls back to pure TS.
- Each module captures `const native = getNative()` once at import; the
  fallback runs when `native` is null (or when the measured-faster JS path is
  preferred — see `docs/native-acceleration.md`).
- `IGNEX_NATIVE_PATH` overrides resolution (a `.node` path is `require`d, a
  module specifier is imported). `IGNEX_NATIVE=off` disables the addon.
- `loadCastrumModule()` loads the castrum TS entry for the route-manager
  (`createNativePipeline`) bridge.
- Verify: `bun -e 'const m = await import("./src/index.ts"); console.log(m.isNativeAvailable())'`.

## Module map (`src/`)

| Module       | Primitives                                                          |
| ------------ | ------------------------------------------------------------------- |
| `hash.ts`    | `fnv1a64`, `crc32` + fallbacks                                      |
| `crypto.ts`  | `hmacSha256`, `jwtSign`/`jwtVerify`, `signCookie`/`verifyCookie`, `csrfToken`/`csrfVerify`, `passwordHash`/`passwordVerify`, `aeadEncrypt`/`aeadDecrypt`, `randomToken` |
| `http.ts`    | `queryPairs`, cookie parsing, `multipartParse`, `etag`, `acceptEncoding` |
| `payload.ts` | `gzip`/`brotli`, SSE frames, WebSocket frames                       |
| `template.ts`| `renderTemplate` (minijinja / Jinja-subset), `createTemplate`        |
| `validation.ts` | `validateEmail` / `validateUuid` / `validateIpv4` / `validateIpv6` |
| `json.ts`    | JSON helpers + patch                                                 |
| `packed.ts`  | native packed batch wire-format unpackers                            |
| `util.ts`    | encoder/decoder, `toBytes`/`fromBytes`, `ctEqual`, CRC table         |
| `vendor/castrum.d.ts` | hand-maintained ambient type subset of the addon              |

## Adding a function

Follow section D of [docs/adding-a-feature.md](../../docs/adding-a-feature.md):
implement the fallback, export wrapper + `*Fallback`, add parity vectors to
`packages/native/test/native.test.ts`.

## Note on `castrum`

`castrum` is an `optionalDependencies` entry pointing at an out-of-repo path
(`file:../../../bun-rust-runtime-bench`). On machines without it, install just
warns and the pure-TS fallbacks are used — the loader never throws. CI and
fresh clones run the parity suite against the fallbacks.
