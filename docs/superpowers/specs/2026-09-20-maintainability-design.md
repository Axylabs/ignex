# Design — Intern-maintainable ignex (maintainability system)

Date: 2026-09-20 · Status: **proposed** · Owner: maintainability working group

This spec turns "so maintainable an intern can maintain it" into a concrete,
mechanically-enforced system for the ignex monorepo. It is the design for
`docs/stability.md` item 12's *next* stage: not just "split the big files", but
a repeatable contract that keeps the codebase small, duplicate-free, and
traceable from symptom to origin.

## 1. Context and honest baseline

Evidence gathered 2026-09-20 (measured, not vibes):

| Claim | Status |
| --- | --- |
| No dead code / unused exports | ✅ knip `check:dead` clean |
| No tech-debt markers | ✅ exactly **1** `TODO` across ~81k src LOC, 0 in tests |
| No accidental source duplication | ✅ normalized-content scan of 555 src files: no duplicate pairs (only 2 near-identical `vitest.config.ts`, excluded by design, and 12 gitignored `.gen-debug-ui-*` build dirs) |
| Public API documented | ✅ jsdoc:check:strict 1043/1043 (coverage-gated) |
| Behavioral tests | ✅ 1090 core / 178 native / 322 cli / 27 mcp / 16 shared; smoke + fallback parity gates |
| Symptom → origin traceability | ⚠️ **code-centric only** — telemetry taxonomy (`call-failed → surface.stage`), 16 Rust error codes projected into a typed layout; but the *why* of each design decision is scattered across doc prose + git log (completed plans are deleted by rule) |
| File size | ❌ **36** src files > 400 lines (by the gate's line counter; see allowlist §8 — `core/http/ws.ts` sits at 400 by `wc -l` = 401 by gate count) |

The intern gap is *decision discoverability*, not composition. The repo already
mandates factories-over-classes and small pure functions (RULES.md rule 3); the
`native`↔pure-TS twins are deliberate byte-compatible parity (RULES.md rule 2),
not accidental duplication. More abstraction/indirection would make the codebase
**harder** for a newcomer, so this spec deliberately does **not** add a
composition/HOF layer. The lever is: machines enforce the invariants, docs
record the why, and a playbook links symptom → origin → test.

## 2. Goal and non-goals

**Goal:** define and mechanically enforce a maintainability contract such that:

1. Every behavioral invariant is checked by CI (regressions = red builds).
2. Every "why" lives in one searchable decisions registry, linked from the code.
3. Every symptom traces to its origin module + the test that pins it.
4. Files fit in one screen (≤400 lines) and carry a `@fileoverview`.

**Non-goals (explicitly out of scope):**

- Composition/HOF abstraction layer — already the law; expanding it is anti-goal.
- De-duplicating the native/fallback twins — byte-parity is the product's contract.
- Enforcing the *rest* of the roadmap this session — §8 phases later sessions.

## 3. Design overview

Three layers, each with a mechanical anchor:

| Layer | Artifact | How it stays honest |
| --- | --- | --- |
| Mechanical conditions | `scripts/check-maintainability.ts` + `maintainability.json`, wired into `verify:quick` | hard-fail like `check:dead` |
| Decisions ("why") | `docs/decisions/` ADR-lite files | gate verifies referenced paths exist (doc-rot guard) |
| Traceability ("where from") | `docs/ai/maintaining.md` playbook | seeded, maintained alongside telemetry taxonomy |

Plus a hygiene fix (`gen-debug-ui` proactive cleanup) and the file-split work.

## 4. Mechanical gate — `check:maintainability`

A new root script, `bun run check:maintainability`, run inside `verify:quick`
(after `lint`, alongside `check:dead` — user-approved hard gate). Exit 1 with
path:rule diagnostics on any violation. Rules:

1. **File-size cap (400 lines).** Every src `.ts` (exclusions: `node_modules`,
   `dist`, `test`, `fixtures`, `*.config.ts`, `.gen-debug-ui-*`) over 400 lines
   must be listed in `maintainability.json.knownOver` with
   `{lines, rationale}`. A listed file **cannot grow** past its recorded count
   (recorded lines = floor of current size at spec time; the gate fails if a
   file exceeds its recorded number). Entries are **shrink-only** (removed when
   the file is split below the cap). Cap is configurable but the committed
   `maintainability.json` pins it at `400`.
2. **No `TODO|FIXME|HACK|XXX` in src.** (Today: 1 — `cli/src/templates/event.ts` —
   fixed in Phase 1.)
3. **No orphan generated dirs.** Any `.gen-debug-ui-*` directory under
   `packages/` fails (catches SIGINT-killed build leftovers, currently invisible
   because gitignored).
4. **No exact-duplicate src files** (normalized: comments/whitespace stripped,
   then whole-file hash). `*.config.ts` excluded by design. Block-level
   duplication stays advisory (future work — the native/fallback twins will
   false-positive naive block matchers).
5. **`@fileoverview` on every src file over the size cap** (`fileoverviewMinLines`
   == `maxLines` == 400, not 120). A measured gate at 120 lines failed on 61
   files — the codebase never adopted `@fileoverview` broadly — so the tag is
   required only on cap-size files (the ones being actively shrunk, which need
   orientation prose). The 11 cap-size files missing the tag were tagged during
   Phase 1; the check is trivially satisfiable for smaller files by exempting
   them.
6. **Decision references exist.** Every `docs/decisions/*.md` file's
   `Verification:` lines that quote repo paths must resolve to a real file.

`maintainability.json` schema (committed at repo root):

```jsonc
{
  "maxLines": 400,
  "fileoverviewMinLines": 400,
  "knownOver": {
    "packages/native/src/metrics.ts": { "lines": 826, "rationale": "native metrics surface + NAPI class wrapper — Phase 1 split" },
    // …36 entries (incl. core/src/http/ws.ts at 401 by gate count), see §8…
  },
  "ignoreGlobs": ["**/vitest.config.ts", "**/.gen-debug-ui-*/**"]
}
```

Edge cases the script must handle: the recorded `lines` is the tiebreaker for
"can't grow" (>= recorded + 1 fails); a file *dropping out* of the list when
its size falls ≤ `maxLines` is an automatic removal suggestion; the allowlist
is validated against reality (entry for a file ≤400 lines is an error — stale
entries must be removed).

## 5. Decisions registry — `docs/decisions/`

ADR-lite files, `NNN-topic.md`, template:

```md
# NNN · <Title>
Status: <accepted | superseded-by-NNN>
Context: …
Decision: …
Consequences: …
Verification: <test/gate/path that pins this>
```

Seed entries (lifted from existing prose + git log — no new research, just
relocation to one searchable place):

- `D-001` native-wins selection: `SELECTION` table + `FFI_WINS` measured overrides (single source of truth; read-only, never mutated at runtime).
- `D-002` native/fallback duality: native acceleration is never a hard dependency; byte-compatible pure-TS fallbacks, `IGNEX_NATIVE=off` parity is a CI gate.
- `D-003` C-ABI `(ptr,len)` vs `cstring` conventions (accept-negotiator / conditional / ingress-* gotchas; a `(ptr,len)` bound as `cstring` leaves a register uninitialized — cross-platform parity lane caught it).
- `D-004` wire-layout ownership: Rust owns ingress/route/scalar layouts, JS projects them from the `castrum_*_layout` blobs; `DEFAULT_LAYOUT` parity safety nets pinned by `verify-native-ffi.ts` + parity tests.
- `D-005` fail-closed policy: native core fault → telemetry + optional 503; default availability-first pass-through; option wins over `IGNEX_INGRESS_FAIL_CLOSED`.
- `D-006` abort-status ruling: aborted-request responses are **200** (matches interpreted lifecycle + Elysia; deviates from the original 499 plan — recorded in the castrum-adoption plan close-out).
- `D-007` metrics bind is lazy + optional: pre-symbol addons/missing `bun:ffi` yield `null` → NAPI-plus wrapper; bind-time probe (`__probe_total`) guards partial surfaces.
- `D-008` header size guards: cookie/xff 8192, small headers 2048 — oversized values dropped *before* packing (native caps the block at 64 KiB).
- `D-009` `COMPILER_CACHE_VERSION` contract: bump on any codegen/linker output change; `check:cache-versions` gates drift.
- `D-010` compose-over-classes: factories, no classes on public surfaces (RULES.md rule 3) — the constant that this spec refuses to expand into an abstraction layer.
- `D-011` no `castrum` import outside `packages/native`; `@ignex/native` is the only bridge.
- `D-012` off-thread consumers: hot-path async work (password verify, gzip compress) goes through the shared task-consumer pool (2026-09-20 follow-on plan).

Each decision's `Verification:` cites at least one path that exists today (gate
rule 6 keeps them honest).

## 6. Issue→origin playbook — `docs/ai/maintaining.md`

A table: **symptom → origin module → pinning test → fix path**. Seeded rows:

| Symptom (log/telemetry/response) | Origin | Pinning test / fix |
| --- | --- | --- |
| `call-failed → ingress.handle` / "native ingress returned 0" | `native/src/ingress/factory.ts` fault path | `ingress-binding.test.ts` (fail-closed subprocess) |
| 429 `rate_limited` body | `ingress/terminal.ts` + `errors.ts` | rate-limit tests; `retry_after_ms` inline |
| `U32_MAX` "rate limiting disabled" | `ingress/constants.ts` | parity tests |
| 304/412 conditional oddities | `native/src/http/conditional.ts` + `core/src/http/conditional.ts` | conditional suite |
| C-ABI garbage value in a header match | D-003 `(ptr,len)` gotcha | cross-platform parity lane |
| `IGNEX_NATIVE=off` behavior mismatch | any native surface | `smoke:fallback`, `test:native` fallback lanes |
| SIGILL v3 guard trip | `native/src/loader.ts` | `check:native:surface` |
| Cache serving stale output | `compiler/src/cache.ts` | `check:cache-versions` + cache self-heal tests |
| Debugbar blank / missing panels | `core/src/debug/*` | `check:debug-ui`, `gen:debug-ui --check` |

The playbook is the human face of the telemetry taxonomy; every new
`reportDegradation` reason or new error code must add a row (playbook growth is
part of the developer workflow, enforced by review discipline this quarter).

## 7. Hygiene fix — `gen-debug-ui`

SIGINT-killed `--check` runs (observed in `verify:quick` output:
`check:debug-ui | Signaled: SIGINT`) die before `buildArtifact`'s `finally`,
leaving gitignored `.gen-debug-ui-*` dirs that every subsequent run sees as
"up to date" evidence nothing cleans (12 dirs ≈ 3 MB today). Fix: the script
proactively removes every stale `.gen-debug-ui-*` under `packages/core` at
startup, before its own `mkdtemp`. Gate rule 3 makes future leftovers red.

## 8. Phase 1 (this session) and roadmap

**Phase 1 — implement now:**

1. `scripts/check-maintainability.ts` + root `maintainability.json` + wire into
   `verify:quick` (this spec's gate; user-approved hard gate) + `@fileoverview`
   tags on the 11 cap-size files that lacked them (rule 5, at the cap
   threshold).
2. `gen-debug-ui.ts` proactive cleanup (§7).
3. Fix the 1 TODO (`cli/src/templates/event.ts`).
4. Three move-only splits (each: identical behavior, barrel re-exports, package
   suite + `verify:quick` + `check:dead`; native ones also
   `check:native:surface` + `smoke:fallback`):
   - `core/src/debug/types.ts` (778 — ~99% pure types, trivial domain split).
   - `native/src/metrics.ts` (825 — native metrics surface + NAPI-plus wrapper).
   - `native/src/crypto.ts` (752 — same profile as ffi/metrics).

**Roadmap — later sessions (§8 allowlist drives it):**

Tier A (natives, same proven move-only pattern): `native/ffi/bind.ts` (481),
`native/loader.ts` (445), `native/route-wire.ts` (444).

Tier B (core behavior — careful, dedicated passes): `core/src/http/router.ts`
(694), `core/src/index.ts` (606, barrel — tree-shaking care), `core/src/
security/session.ts` (534), `core/src/lifecycle/app-factory.ts` (460),
`core/src/lifecycle/run.ts` (434).

Tier C (debug cluster): `core/src/debug/{server/handlers/app-panels,persist,kt,
nats-tracker,tracer}.ts` + `plugins/debugbar.ts` (583).

Tier D (compiler): `compiler/src/sdk/{realtime,typescript,flatbuffers}.ts`,
`compiler/src/cache.ts`, `compiler/src/types.ts`, `compiler/src/utils/ast/
handler.ts`, `compiler/src/phases/codegen/helpers.ts`, `compiler/src/phases/
analysis/dev-only-plugins.ts`, `compiler/src/phases/linker.ts`, `compiler/src/
phases/codegen/routes/{native,context}.ts`.

Tier E (cli + mcp): `cli/src/templates/{ops,routes}.ts`, `cli/src/commands/
{create,ops,dev,event}.ts`, `mcp/src/server.ts` (604).

When the allowlist is empty, `maxLines` becomes absolute; stale/shrunk entries
are removed by the gate as splits land.

## 9. Verification of this design

- Gate self-test: the script must have fixtures proving each rule fires
  (temp tree with a 401-line file, a TODO, a `.gen-debug-ui-*` dir, a duplicate
  pair, a >120-line file without `@fileoverview`) and passes on the real tree.
- `verify:quick` green with the gate wired in (allowlist pre-populated so no
  false red).
- The three splits keep every package suite green + `check:native:surface` +
  `smoke:fallback` for the two native ones; knip stays clean (barrel dead-export
  rule from the ffi/ingress splits applies: don't re-export types with zero
  barrel consumers).
- Decisions registry: 12 seed files, each `Verification:` path real (gate rule 6).
- Playbook committed with at least the 8 seeded rows above.

## 10. Risks

- **Threshold gaming** (401-line files split into 8×250-line helpers): accepted
  trade-off; fileoverview + review discipline cover the worst of it.
- **Allowlist stasis**: the shrink-only rule + "stale entry is an error" keeps
  it honest, but a slow roadmap risks permanent exemptions — mitigated by
  recording the tiers in this spec and tracking progress in the SDD ledger.
- **Ball-barrel churn**: each native split re-exports through barrels; the
  knip dead-export rule (already applied twice) is the known edge — verified per
  split, no new mechanism needed.
- **Doc proliferation**: 12 decisions + playbook is the cap for this quarter;
  new decisions must supersede/consolidate, not accumulate.

## 11. Rulings

- Aborted-response status stays **200** (D-006) — unchanged from the plan
  close-out.
- Composition layer is **not** added (non-goal §2) — gate + registry + playbook
  carry the intern bar.
- The gate is **hard in `verify:quick`** (user-approved), not opt-in.
- Phase 1 scope: gate + hygiene + TODO + 3 splits (user-approved "blueprint +
  top mechanical wins").