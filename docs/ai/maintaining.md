# Maintaining ignex — issue → origin → test

The human face of the telemetry taxonomy. When a symptom shows up in logs,
telemetry, or a response, this table points at the module that produced it,
the test that pins it, and the documented why (see `docs/decisions/`).

**Rule:** every new `reportDegradation` reason, native error code, or new
telemetry `call-failed` surface adds a row here (and a decision entry where a
design choice is involved). Keep rows terse; the linked module is the source
of truth.

## Seed table

| Symptom (log/telemetry/response) | Origin | Pinning test / fix |
| --- | --- | --- |
| `call-failed → ingress.handle` / "native ingress returned 0" | `packages/native/src/ingress/factory.ts` fault path | `packages/native/test/ingress-binding.test.ts` (fail-closed subprocess) |
| 429 `rate_limited` body | `packages/native/src/ingress/terminal.ts` + `ingress/errors.ts` | rate-limit tests; `retry_after_ms` inline |
| `U32_MAX` "rate limiting disabled" | `packages/native/src/ingress/constants.ts` | `packages/native/test/ingress-stages.test.ts` parity tests |
| 304/412 conditional oddities | `packages/native/src/http/conditional.ts` ↔ `packages/core/src/http/conditional.ts` | `packages/native/test/http-property.test.ts` conditional suite |
| C-ABI garbage value in a header match | D-003 `(ptr,len)` gotcha | `scripts/verify-native-ffi.ts` + `packages/native/test/wire-hardening.test.ts` |
| `IGNEX_NATIVE=off` behavior mismatch | any native surface | `smoke:fallback`, `packages/native/test/selection.test.ts` |
| SIGILL v3 guard trip | `packages/native/src/loader.ts` | `scripts/check-native-surface.ts` |
| Cache serving stale output | `packages/compiler/src/cache.ts` | `scripts/check-cache-versions.ts` + cache self-heal tests |
| Debugbar blank / missing panels | `packages/core/src/debug/*` | `check:debug-ui`, `gen:debug-ui --check` |

## The three-layer mental model

1. **Mechanical** — `scripts/check-maintainability.ts` (rules + self-test) and
   `maintainability.json`: size cap, debt markers, orphan build dirs,
   duplicates, `@fileoverview`, decision-ref rot.
2. **Why** — `docs/decisions/` (D-001 … D-012; see the template).
3. **Where from** — this table: symptom → module → test → fix.

When a bug report says "it returns a weird 429", start at the Origin column
(`ingress/terminal.ts`), read D-005/D-008 for the why, and run the pinned
tests before touching code.