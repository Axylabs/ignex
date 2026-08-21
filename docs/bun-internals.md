# Bun internals decision matrix

> **Source of truth for "use Bun internals when runtime = Bun".** Every row is
> backed by a measured ratio from `scripts/bench-bun-internals.ts`
> (`bun scripts/bench:bun-internals`), which writes `bench/results/bun-internals.json`.
> A swap ships only when the Bun builtin is **≥ 1.0× the implementation it
> replaces (median, interleaved trials) AND byte-compatible**. Otherwise the
> row records "keep" and the code stays as-is. This mirrors castrum's
> `docs/bun-builtins-decision-matrix.md` / the `BUN_WINS` set in
> `packages/native/src/selection.ts`.

Measured on `Bun v1.4.0-canary` (Linux), 2026-08-20, 5 interleaved trials.

## Matrix

| Bun builtin | Current impl | Ratio (bun/current) | Verdict | Wiring |
|---|---|---|---|---|
| `Bun.write` | `node:fs/promises writeFile` / `writeFileSync` | **3.80×** | **swap (async CLI writes)** | `cli` `writeFileEnsuringDir` + `hook` registration. Sync bootstrap (`env.writeEnvKeys`), atomic persists (`jobs-store` tmp+rename), and once-per-build compiler artifact/cache writes stay `node:fs`. |
| `Bun.file(path).text()` | `node:fs readFile` | 0.82× | keep | Reads stay node:fs — faster. |
| `Bun.file(path).stat()` | `node:fs stat` | 1.00× | parity | No change to `http/files.ts` (node stat stays). |
| `Bun.Glob` scan | `node:fs readdir` recursion | 0.79× | keep | Dir scans stay node:fs. |
| `Bun.escapeHTML` | hand-rolled regex `escapeHtml` (`plugins/openapi.ts`) | 0.06× | keep | Hand-rolled is ~16× faster for typical strings. |
| `Bun.deepEquals(a,b,true)` | hand-rolled `deepEqual` (`native/src/json.ts`) | 0.35× | keep | Specialized JSON compare is ~3× faster. |
| `Bun.CryptoHasher("sha1")` | `node:crypto createHash("sha1")` (WS accept key) | **1.12×** | **swap** | `native/src/payload.ts` `wsAcceptKey` prefers Bun SHA-1. |
| `crypto.getRandomValues` | `node:crypto randomBytes` (CSPRNG) | **87×** | **swap** | `native` csrf fallback, `core` password salt, `cli` ops token. |
| `Bun.gzipSync` | `node:zlib gzipSync` | 1.77× | **already wired** | `native/src/bun.ts` `bunGzipSync` + `BUN_WINS` (baseline). |
| `Bun.hash.wyhash` | `fnv1a64` (native/TS) | **16.5×** / **917×** | **swap (runtime-local only)** | `core/src/data/cache/hash.ts` `fastHash`/`entityTag`. Compiler **cache keys stay fnv1a64** (cross-runtime key stability). |
| `Bun.hash.crc32` | native addon / TS table | 0.97× / **115×** | **already wired** | `native/src/bun.ts` `bunCrc32` + `BUN_WINS` (baseline). |
| `Bun.password.hashSync` (argon2id) | native argon2id `passwordHash` | 0.16× | keep | Native Rust is ~6× faster; **do not swap**. |
| `Bun.password.hashSync` (argon2id) | scrypt fallback | 0.31× | keep | Fallback stays. |
| `Bun.password.verifySync` | native `passwordVerify` | — (throws) | keep | **Incompatible**: Bun cannot parse native/scrypt PHC strings (`PASSWORD_UNSUPPORTED_ALGORITHM`). No cross-verify. |
| `Bun.spawnSync` | `node:child_process spawnSync` | **1.19×** | **swap** | CLI subprocess exec when Bun present (`cli/src/utils/runtime.ts`). `core` TLS already uses Bun. |
| `Bun.env` | `process.env` | 0.96× | keep | `process.env` stays (parity, no churn). |
| `Bun.semver.satisfies` | manual range compare | **1.11×** | **swap** | CLI `doctor` version checks when Bun present. |
| `Bun.peek` | promise passthrough | 0.86× | keep | No fast-path benefit measured. |
| `Bun.serve({ h2 })` | HTTP/1.1-only TLS | feature | **feature (opt-in)** | Add `server.h2` config; emit `h2` when TLS is on. Default off → no behavior change. |

## Rules applied

1. **File writes → `Bun.write` only at async CLI write sites** (`writeFileEnsuringDir`, `hook` registration). Bun has no `writeSync`; sync bootstrap writes (`env.ts writeEnvKeys`), sync atomic persists (`jobs-store.ts` tmp+rename), and once-per-build compiler artifact/cache writes keep `node:fs` (no API churn for rare/one-time writes).
2. **Reads, dir scans, escapeHTML, deepEquals, password, peek, env, stat stay
   as-is** — measured slower or parity; the benchmark is the gate.
3. **`Bun.password` is not wired** — native is faster *and* Bun rejects native
   PHC strings, so any swap would break stored-hash verification.
4. **Compiler cache keys stay on `fnv1a64`** even though wyhash is ~16× faster —
   cache keys must be stable across runtimes/machines; wyhash is used only for
   runtime-local keys (`core/src/data/cache/hash.ts`).
5. **`h2` is opt-in** (`server.h2: true` + TLS), preserving the HTTP/1.1
   default and the `docs/cookbook.md` TLS guidance until the user opts in.
6. **CLI `spawnSync` sites needing Node shapes stay on `node:child_process`**
   (`create` git-init/install use `result.error`/`shell`/`stdio: "inherit"`;
   `route`/`dev` taskkill) — only the status-only `commandExists` check uses
   `Bun.spawnSync`.

## Re-run

```sh
bun scripts/bench-bun-internals.ts     # or: bun run bench:bun-internals
```

Results land in `bench/results/bun-internals.json`; update this doc when the
ratio changes materially.
