# D-013 · Failures are classified and reported, never dumped

- Status: accepted
- Context: A failure used to reach the operator as whatever was thrown. A plugin
  whose `init` failed rethrew with `cause: __err`, so Bun's uncaught-error
  printer expanded a `MongoServerError` — whose enumerable properties carry BSON
  `Timestamp`/`Long` graphs — into hundreds of lines of getter noise. Request
  errors had the mirror problem: `errorToResponse` logged a bare
  `"[ignex] unhandled error:"` plus a stack, so a 500 said *what* was thrown and
  never *which subsystem* broke or what to fix. Nothing carried a
  machine-readable origin, and nothing was correlated to the request.
- Decision: Every failure is classified into a **fault** — an origin (`request`,
  `auth`, `app`, `internal`, `config`, `db`, `network`, `dependency`, `native`),
  a kind, a stable code (the error's own, else `IGN_<ORIGIN>_<KIND>`), a
  retryable verdict, hints, the service, and a sanitized `cause` chain — and is
  reported once through the same renderer.
  `packages/core/src/platform/fault.ts` classifies any throw (the structural
  reading of a throw — `cause` walk, `code`/`codeName`, stack frame — lives in
  `fault-throw.ts`, and the human hints/summary in `fault-hints.ts`);
  `fault-report.ts` renders and prints it idempotently; `app-error.ts` and
  `http-errors.ts`/`operational-errors.ts` supply the typed classes
  (`AppError`, `RequestError`, `DBError`, `ConfigError`, `UpstreamError`,
  `DependencyError`, …); `error-envelope.ts` owns what may leave the process
  (JSON headers, memoized envelope bodies, canonical reason phrases); `errors.ts`
  is the single response boundary that maps a fault to a status and reports 5xx
  only.
  Three rules are deliberate: **a plain throw keeps its 500** (only a typed error
  declares a status), **nothing quoted in a report reaches a log unmasked**
  (`redactLogText` masks URL credentials and `secret=…` pairs), and **the raw
  object is not attached as `cause`** (that is what Bun expanded; `IGNEX_DEBUG=1`
  prints it on request instead).
  Client exposure is **fail-closed**: a 4xx message is the caller's contract, a
  5xx message is operator detail — the envelope carries the canonical reason
  phrase plus the machine `code`, and `exposeErrors` (on outside production)
  reveals the redacted message to a developer. `expose: true` opts a single error
  in. A third-party error that declares `statusCode`/`status` + `code` is honoured
  as typed, so a library's mapped error keeps its status and origin without a
  dependency in either direction. Identical faults are printed once per 5s window
  in production (a 500 storm cannot flood the log; development prints every one).
- Consequences: A failure answers "which part broke down, why, is retrying worth
  it" in one block, and the same block serves boot and request paths because both
  call the same seam. The wire envelope is unchanged (`errorToResponse` still
  emits `{ error, status, code }` and masks plain throws), so clients are
  unaffected; the taxonomy rides in logs and in `x-request-id` correlation. A
  third-party error that matches no pattern stays `internal`/`unexpected` — the
  case worth investigating — rather than being guessed at.
- Verification: `packages/core/src/platform/fault.ts`,
  `packages/core/src/platform/fault-throw.ts`,
  `packages/core/src/platform/fault-hints.ts`,
  `packages/core/src/platform/fault-vocabulary.ts`,
  `packages/core/src/platform/fault-report.ts`,
  `packages/core/src/platform/app-error.ts`,
  `packages/core/src/platform/http-errors.ts`,
  `packages/core/src/platform/error-envelope.ts`,
  `packages/core/src/platform/operational-errors.ts`,
  `packages/core/test/fault.test.ts`, `packages/core/test/boot-failure.test.ts`,
  `packages/compiler/test/hardening.test.ts`, `docs/errors.md`
