# Off-thread task runtime — consumer follow-on plan (A1)

> Follow-on to the castrum-adoption plan (`2026-09-19-castrum-adoption.md`,
> Task 6). Supercedes that task's "no production consumer" premise with the
> state as of 2026-09-20, and scopes the remaining async adoption with
> `superpowers:subagent-driven-development` as the execution mode when run.

**Goal:** make the event-loop-blocking work ignex actually ships (password
verification, compression) run off-thread when the native task pool is present,
without changing results (`IGNEX_NATIVE=off` parity) and only where measured
worthwhile.

**Baseline context:** `packages/native/src/tasks.ts` bridges castrum's
`createTaskRuntime` (gzip/brotli/pbkdf2-sha256/argon2id-verify) with a
byte-compatible synchronous pure-TS fallback. Argon2id verify is 10–200 ms of
CPU; gzip compression of a large body is the same class of stall.

## Already landed (close-out of the original Task 6)

These were wired into `@ignex/core` in `8638c85` and the v0.2.0 cycle; the
original "no production consumer" note is stale:

- `PasswordHasher.verifyAsync(password, phc, opts)` — `packages/core/src/security/crypto.ts`
  → `verifyPasswordAsync` (native off-thread argon2id, sync fallback for
  `$scrypt$` and `IGNEX_NATIVE=off`; identical boolean either way).
- `gzip` compression offload — `packages/core/src/plugins/compression.ts` uses
  `gzipCompressAsync` when native is available (and the body is above
  `OFFLOAD_MIN_BYTES`); brotli intentionally stays synchronous — the task
  runtime has no brotli-compress op.

## Remaining gaps

1. **`brotliDecompressAsync` / `pbkdf2Sha256Async` module-level helpers** —
   the runtime exposes both ops but only `gzipCompressAsync` and
   `verifyPasswordAsync` have thin module-level async helpers today. Requests
   carrying brotli bodies decompress on the JS thread (a decompression bomb
   guard already exists via `maxDecompressed`).
2. **No async body-decode consumer in `@ignex/core`** — `data/schema.ts` /
   `http/body/` decode request bodies synchronously; a large brotli/gzip body
   stalls the loop during decoding.
3. **No measured justification yet** — per the perf-methodology discipline,
   adopt only where measured: interleaved A/B of the sync vs async path under
   `03-stress`/`13-heavy-json` is required before wiring more call sites.

## Plan (when executed)

- [ ] Task A — add the two thin module-level helpers in `tasks.ts`
      (`brotliDecompressAsync`, `pbkdf2Sha256Async`; fallback semantics
      identical to `gzipCompressAsync`), export from `@ignex/native`, JSDoc,
      vitest parity tests (`packages/native/test/tasks.test.ts`).
- [ ] Task B — async body-decode opt-in in `@ignex/core` (new
      `decodeBodyAsync` helper beside the sync one; uses
      `brotliDecompressAsync`/`gzipDecompressAsync` when the runtime is native
      and `maxDecompressed` is honored identically).
- [ ] Task C — measure gate: interleaved A/B sync-vs-async under
      `03-stress`/`13-heavy-json`; wire the consumer only if the offload wins
      ≥1.05× median AND the sync path stays as the documented fallback. Record
      verdict in `docs/perf-methodology.md` + `docs/native-acceleration.md`.
- [ ] Task D — docs (`docs/native-acceleration.md` SELECTION rows, cookbook
      note) + CHANGELOG + `bun run verify:quick` + `smoke:fallback`.

**Acceptance:** both helpers byte-compatible with the sync wrappers (parity
tests), async body decode honors the bomb cap, measurement verdict recorded,
`IGNEX_NATIVE=off` gate green.