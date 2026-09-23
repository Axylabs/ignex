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
  The **debugger carries the same fault**: `packages/core/src/debug/fault-capture.ts`
  is the seam the tracer uses (`faultOf` first, else `toFault`), so a failed
  trace stores the classified `Fault`, the span that failed stores a compact
  `FaultMark` (code/origin/kind/service/where), and the trace summary, the
  SQLite history, `GET /api/ai/summary` and the dashboard Error tab all render
  that one object — the dashboard cannot paraphrase a failure the report
  already explained.
  A fault's `where` is a **source** position, never a bundle offset: the error
  system exposes a frame-remap hook (`fault-throw.ts#setStackFrameRemapper`) that
  `packages/core/src/debug/sourcemaps.ts` installs when the debug layer becomes
  active, and the frame is chosen by usefulness — application code first, then
  the dependency/framework frame that raised it, never a synthetic `native:` /
  `node:` frame.
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
  case worth investigating — rather than being guessed at. Because the dev
  debugger stores the same fault, an incident that is only ever seen in the
  dashboard (a span failure the handler swallowed, a cron-driven request) is
  diagnosable without reproducing it against a terminal: the trace says which
  subsystem broke, what to change and what the driver actually said.
- Verification: `packages/core/src/debug/fault-capture.ts`,
  `packages/core/src/debug/frames.ts`,
  `packages/core/src/debug/tracer.ts`,
  `packages/core/src/debug/persist-schema.ts`,
  `packages/core/src/debug/sourcemaps.ts`,
  `packages/core/src/debug/server/handlers/ai-summary.ts`,
  `packages/core/src/platform/fault-throw.ts`,
  `packages/core/src/platform/fault.ts`,
  `packages/core/src/platform/fault-throw.ts`,
  `packages/core/src/platform/fault-hints.ts`,
  `packages/core/src/platform/fault-vocabulary.ts`,
  `packages/core/src/platform/fault-report.ts`,
  `packages/core/src/platform/app-error.ts`,
  `packages/core/src/platform/http-errors.ts`,
  `packages/core/src/platform/error-envelope.ts`,
  `packages/core/src/platform/operational-errors.ts`,
  `packages/core/test/fault.test.ts`, `packages/core/test/boot-failure.test.ts`,
  `packages/core/test/fault-debugger.test.ts`,
  `packages/compiler/test/hardening.test.ts`, `docs/errors.md`
