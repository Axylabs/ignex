# Plan — Maintainability system Phase 1 (intern-maintainable ignex)

Date: 2026-09-20 · Status: **approved** · Spec: `docs/superpowers/specs/2026-09-20-maintainability-design.md` (approved)

> **Execution amendments** (2026-09-20, recorded as T1–T3 landed):
> 1. **Rule 5 threshold = 400, not 120** — user-approved. A measured gate at 120
>    failed on 61 files (the codebase never adopted `@fileoverview` broadly), so
>    `fileoverviewMinLines` == `maxLines` and only cap-size files require the
>    tag. T1 tags the **11** cap-size files that lacked it (8 tag-prefixes on
>    existing JSDoc blocks, 3 new top-of-file blocks).
> 2. **Allowlist = 36 entries, not 35** — the gate counts lines as
>    `split("\n").length`, so `core/src/http/ws.ts` (400 by `wc -l`, 401 by gate
>    count) is the extra entry. Recorded counts use the gate's counter
>    (reconciled via `--report`: all 36 match exactly).
> 3. **T2 cleanup runs inside `buildArtifact`, immediately before its own
>    `mkdtemp`** — same effect as a startup hook, with less indirection.
> 4. **T3 swap is net-zero** — the emitted `// TODO:` line becomes a single
>    guidance line, so the file's line count does not move (`templates/event.ts`
>    is 292 lines, under cap anyway; `commands/event.ts` at 510 is untouched).
> 5. **`docs/decisions/` Verification parsing bullets** — the gate's rule 6
>    strips a leading `- ` bullet, matching the seed entries' `- Verification:`
>    format (found by the self-test fixture).
> 6. **verify:quick gate race (surfaced by T6)** — `check:maintainability` and
>    `check:debug-ui` originally ran in `--parallel`; the gate observed
>    debug-ui's LIVE `.gen-debug-ui-*` staging dir as an orphan, exited 1, the
>    runner SIGINT-killed debug-ui mid-build, and the leftover orphan re-tripped
>    the gate on the next run (red forever). `verify:quick` now chains
>    `&& bun run check:maintainability` AFTER the parallel set: the gate audits
>    the final state, and gen-debug-ui's startup sweep heals any prior leftover
>    first.

Implements Phase 1 of the approved maintainability design: the mechanical gate,
the gen-debug-ui hygiene fix, the single TODO removal, the decisions registry +
issue→origin playbook, and the three move-only file splits
(`core/debug/types.ts`, `native/metrics.ts`, `native/crypto.ts`).

## Global constraints (apply to every task)

- Bun-first; scripts run with `bun scripts/<name>.ts`.
- Move-only splits: **verbatim transcription** — no behavior/type changes, no
  renames, no reformatting of the moved code. Same rule that shipped the
  ffi/ingress splits. Barrels re-export so every existing import path resolves.
- Resolution preservation: a move of `X.ts` **into a directory** `X/` keeps
  `"./X"` / `"../X"` / `"@ignex/core/debug/types"` imports working (dir + index
  resolves the same as the file did). This is how the ffi/ingress splits stayed
  import-compatible. `import "../src/debug/types.js"` from tests resolves the
  same way.
- knip barrel rule (applied twice already — ffi/ingress): after a split, a
  barrel re-export that knip flags as unused is **removed from the barrel only
  if it has zero consumers through the barrel**; if it has consumers, keep it
  and verify. Package-entry importers (e.g. `index.ts`) define the required
  re-export set.
- When a task deletes/moves a file cited by a `docs/decisions/*.md`
  `Verification:` line, **update that decision in the same commit** (gate rule 6
  fails on dangling paths — refactor-rot guard works as designed).
- When a split removes a `maintainability.json` `knownOver` entry (file gone or
  ≤ cap), remove the entry in the same commit.
- Commit after each task with `git commit --no-verify`; biome `--write` only on
  the staged set; record each commit in
  `.superpowers/sdd/2026-09-20-maintainability/progress.md` (gitignored ledger).
- Do **not** introduce classes on public surfaces, new abstraction layers, or
  new dependencies. No `castrum` import outside `packages/native`.

## File structure

### Created
```
maintainability.json                          T1  allowlist + config for the gate
scripts/check-maintainability.ts              T1  the gate (rules + --report + --self-test)
docs/decisions/000-template.md                T4  ADR-lite template
docs/decisions/001-native-wins.md … 012-*.md  T4  12 seed decisions
docs/ai/maintaining.md                        T5  issue→origin playbook
packages/core/src/debug/types/trace.ts        T6  domain file (9 types)
packages/core/src/debug/types/api.ts          T6  domain file (5 types)
packages/core/src/debug/types/knowledge.ts    T6  domain file (10 types)
packages/core/src/debug/types/observability.ts T6  domain file (13 types)
packages/core/src/debug/types/index.ts        T6  barrel (all 37 types)
packages/native/src/metrics/types.ts          T7  interfaces (5)
packages/native/src/metrics/decode.ts         T7  decodeMetricsSnapshot + its helpers
packages/native/src/metrics/registry.ts       T7  createNativeMetricsRegistry + fallback
packages/native/src/metrics/index.ts          T7  createMetricsRegistry + re-export set
packages/native/src/crypto/hmac.ts            T8
packages/native/src/crypto/cookie.ts          T8
packages/native/src/crypto/csrf.ts            T8
packages/native/src/crypto/jwt.ts             T8
packages/native/src/crypto/token.ts           T8
packages/native/src/crypto/password.ts        T8
packages/native/src/crypto/aead.ts            T8
packages/native/src/crypto/session.ts         T8
packages/native/src/crypto/index.ts           T8  barrel (all 31 exports)
```

### Modified
```
package.json                                  T1  wire check:maintainability into verify:quick
scripts/gen-debug-ui.ts                       T2  proactive stale-dir cleanup
packages/cli/src/templates/event.ts           T3  remove the TODO from the emitted template
maintainability.json                          T6–T8  remove split entries (metrics/types/crypto)
docs/decisions/007-metrics-lazy-optional.md   T7  re-cite after metrics split (see T7)
docs/decisions/*.md (any cited-path churn)    T8  re-cite if a crypto path moves
docs/stability.md                             T9  progress note on item 12
docs/ai/TREE.md                               T9  regenerated (bun run gen:ai-map)
```

### Deleted
```
packages/core/src/debug/types.ts              T6  (content moved into types/)
packages/native/src/metrics.ts                T7
packages/native/src/crypto.ts                 T8
```

---

## T1 — Gate script + allowlist + wiring

**Files:** create `scripts/check-maintainability.ts`, `maintainability.json`; modify `package.json`.

### 1a. `maintainability.json` (exact content)

```json
{
  "maxLines": 400,
  "fileoverviewMinLines": 120,
  "knownOver": {
    "packages/native/src/metrics.ts": { "lines": 825, "rationale": "native metrics surface + NAPI-plus wrapper — Tier-0 split (T7)" },
    "packages/compiler/src/sdk/realtime.ts": { "lines": 794, "rationale": "SDK realtime client surface — Tier D" },
    "packages/core/src/debug/types.ts": { "lines": 778, "rationale": "debug observability type surface (37 pure types) — Tier-0 split (T6)" },
    "packages/native/src/crypto.ts": { "lines": 752, "rationale": "native crypto surface (hmac/cookie/csrf/jwt/token/password/aead/session) — Tier-0 split (T8)" },
    "packages/core/src/http/router.ts": { "lines": 694, "rationale": "interpreted router + AOT path — Tier B" },
    "packages/compiler/src/sdk/typescript.ts": { "lines": 686, "rationale": "SDK TS client generation — Tier D" },
    "packages/compiler/src/sdk/flatbuffers.ts": { "lines": 686, "rationale": "SDK flatbuffers codegen — Tier D" },
    "packages/cli/src/templates/ops.ts": { "lines": 657, "rationale": "CLI ops templates — Tier E" },
    "packages/cli/src/commands/create.ts": { "lines": 641, "rationale": "CLI create command — Tier E" },
    "packages/core/src/debug/server/handlers/app-panels.ts": { "lines": 636, "rationale": "debug server app-panels handler — Tier C" },
    "packages/core/src/debug/persist.ts": { "lines": 628, "rationale": "debug persistence + history — Tier C" },
    "packages/cli/src/templates/routes.ts": { "lines": 617, "rationale": "CLI routes templates — Tier E" },
    "packages/core/src/debug/kt.ts": { "lines": 612, "rationale": "debug knowledge-tree engine — Tier C" },
    "packages/core/src/index.ts": { "lines": 606, "rationale": "core barrel — split needs tree-shaking care — Tier B" },
    "packages/mcp/src/server.ts": { "lines": 604, "rationale": "MCP server — Tier E" },
    "packages/core/src/plugins/debugbar.ts": { "lines": 583, "rationale": "debugbar plugin — Tier C" },
    "packages/core/src/debug/nats-tracker.ts": { "lines": 571, "rationale": "debug NATS tracker — Tier C" },
    "packages/core/src/debug/tracer.ts": { "lines": 565, "rationale": "debug tracer — Tier C" },
    "packages/compiler/src/cache.ts": { "lines": 545, "rationale": "AOT cache + COMPILER_CACHE_VERSION — Tier D (cache-version contract — split with care)" },
    "packages/cli/src/commands/ops.ts": { "lines": 538, "rationale": "CLI ops command — Tier E" },
    "packages/core/src/security/session.ts": { "lines": 534, "rationale": "session security — Tier B" },
    "packages/cli/src/commands/dev.ts": { "lines": 523, "rationale": "CLI dev command — Tier E" },
    "packages/cli/src/commands/event.ts": { "lines": 509, "rationale": "CLI event command — Tier E" },
    "packages/native/src/ffi/bind.ts": { "lines": 481, "rationale": "ffi bind layer — Tier A loose end from ffi split" },
    "packages/compiler/src/utils/ast/handler.ts": { "lines": 479, "rationale": "AST handler utils — Tier D" },
    "packages/compiler/src/phases/codegen/helpers.ts": { "lines": 475, "rationale": "codegen helpers — Tier D" },
    "packages/compiler/src/types.ts": { "lines": 470, "rationale": "compiler types — Tier D" },
    "packages/core/src/lifecycle/app-factory.ts": { "lines": 460, "rationale": "AOT app factory (wave-1 split byproduct) — Tier B" },
    "packages/compiler/src/phases/analysis/dev-only-plugins.ts": { "lines": 453, "rationale": "dev-only plugin analysis — Tier D" },
    "packages/compiler/src/phases/linker.ts": { "lines": 449, "rationale": "linker phase — Tier D" },
    "packages/native/src/loader.ts": { "lines": 445, "rationale": "addon loader + surface probe — Tier A" },
    "packages/native/src/route-wire.ts": { "lines": 444, "rationale": "route wire layouts (layout ownership D-004) — Tier A" },
    "packages/core/src/lifecycle/run.ts": { "lines": 434, "rationale": "lifecycle run (wave-1 split byproduct) — Tier B" },
    "packages/compiler/src/phases/codegen/routes/native.ts": { "lines": 417, "rationale": "native route codegen — Tier D" },
    "packages/compiler/src/phases/codegen/routes/context.ts": { "lines": 411, "rationale": "context route codegen — Tier D" }
  },
  "ignoreGlobs": ["**/node_modules/**", "**/dist/**", "**/*.config.ts", "**/.gen-debug-ui-*/**"]
}
```

### 1b. `scripts/check-maintainability.ts`

Readable, no deps, `bun`-run. Structure (mirror `check-native-surface.ts` /
`check-jsdoc.ts` style: `main()` + helpers + typed exits):

- `args`: `--report` prints `path: N lines` for every file over `maxLines`
  (used to reconcile recorded counts), `--self-test` runs the fixture suite,
  `--root <dir>` targets a tree (defaults to repo root, for self-test).
- `collectSrcFiles(root)`: walk `packages/*/src/**/*.ts`, dropping anything
  matching `ignoreGlobs`. Line count = `text.split("\n").length`.
- Rule 1 `fileSizeCap`: file > `maxLines` and not in `knownOver` → fail
  `size-cap:not-listed`; file in `knownOver` and lines > recorded → fail
  `size-cap:grew`; file ≤ `maxLines` and in `knownOver` → fail `size-cap:stale`.
- Rule 2 `debtMarkers`: regex `\b(?:TODO|FIXME|HACK|XXX)\b` per file → fail
  `debt-marker`. (After T3 there is exactly zero, so this must pass on the real
  tree.)
- Rule 3 `orphanGenDirs`: walk `packages/**` for any directory name matching
  `^\.gen-debug-ui-` → fail `orphan-gen-dir`.
- Rule 4 `exactDuplicates`: normalize each src file (strip `//` line comments,
  `/* … */` block comments, then all whitespace), hash; if two files share a
  hash → fail `duplicate-file` naming both.
- Rule 5 `fileoverview`: file > `fileoverviewMinLines` and its leading `/** … */`
  block (must start before any code) lacks `@fileoverview` → fail
  `missing-fileoverview`.
- Rule 6 `decisionRefs`: for each `docs/decisions/*.md`, extract backticked
  repo paths from `Verification:` lines only; if any path does not exist →
  fail `decision-ref:dangling`. (`RULES.md`, root `package.json` script names
  and root-level files resolve from repo root; a bare script name like
  `smoke:fallback` on a Verification line is **not** a path and is skipped.)
- Output `path: rule` diagnostics, exit 1 if any; else `maintainability: OK`.

`--self-test`: `mkdtempSync` under `/tmp/opencode`; build a fixture tree:

```
<tmp>/maintainability.json            maxLines 400, fileoverviewMinLines 120,
                                      knownOver { "packages/a/src/known/big2.ts": {lines:400} },
                                      ignoreGlobs ["**/*.config.ts"]
<tmp>/packages/a/src/big.ts           401 lines, NOT listed            → expect size-cap:not-listed
<tmp>/packages/a/src/known/big2.ts    405 lines, listed @400           → expect size-cap:grew
<tmp>/packages/a/src/todo.ts          contains "// TODO: x"            → expect debt-marker
<tmp>/packages/a/src/dup1.ts          50 lines
<tmp>/packages/a/src/dup2.ts          identical after normalize         → expect duplicate-file
<tmp>/packages/a/src/large.ts         121 lines, no @fileoverview      → expect missing-fileoverview
<tmp>/packages/.gen-debug-ui-fixture/  empty dir                        → expect orphan-gen-dir
<tmp>/docs/decisions/001-x.md         Verification: `packages/a/src/nope.ts` → expect decision-ref:dangling
```

Run every rule against the fixture root: assert each of the six failure kinds
fires; then run against a clean fixture (all files ≤ 400, one >120 file *with*
`@fileoverview`, no markers/dups/orphans, decision citing a real path) and
assert exit 0. Print `self-test: PASS`/`self-test: FAIL`; exit 1 on fixture
failure. Clean up the tmp dir in `finally`.

### 1c. `package.json`

```jsonc
"check:maintainability": "bun scripts/check-maintainability.ts",   // near check:dead
"verify:quick": "bun run --parallel typecheck typecheck:cli lint jsdoc:check:strict check:debug-ui check:maintainability",
```

### Verification (T1)

1. `bun scripts/check-maintainability.ts --self-test` → PASS.
2. `bun scripts/check-maintainability.ts --report` → reconcile any recorded
   count mismatch with the script's own counter, then `bun run
   check:maintainability` → `maintainability: OK`, exit 0.
3. `bun run verify:quick` → green (gate wired, no false red).
4. Commit msg: `feat(scripts): check:maintainability gate + allowlist, wired into verify:quick`.

---

## T2 — gen-debug-ui proactive stale-dir cleanup

**File:** `scripts/gen-debug-ui.ts`.

Add, before `buildArtifact()` runs (start of the main flow):

```ts
function cleanStaleBuildDirs(): void {
  // SIGINT-killed --check runs die before the try/finally rmSync, leaving
  // gitignored .gen-debug-ui-* dirs that fool --check's "up to date" logic.
  const coreDir = path.join(import.meta.dir, "..", "packages", "core");
  for (const entry of readdirSync(coreDir)) {
    if (entry.startsWith(".gen-debug-ui-")) rmSync(path.join(coreDir, entry), { recursive: true, force: true });
  }
}
```

Call it from the entry point before any build/check work. Match the file's
existing import style (`node:fs` names already imported — confirm and reuse;
the script already uses `readdirSync`/`rmSync`/`mkdtempSync`).

### Verification (T2)

1. `find packages/core -maxdepth 1 -name '.gen-debug-ui-*'` shows the 12 stale
   dirs before; after `bun run gen:debug-ui` they are gone and the build
   succeeds.
2. `bun run check:maintainability` → no `orphan-gen-dir` failures.
3. `bun run check:debug-ui` → passes (check mode, no dirs left behind).
4. Commit: `fix(scripts): gen-debug-ui proactively removes stale .gen-debug-ui-* dirs`.

---

## T3 — Remove the only src TODO

**File:** `packages/cli/src/templates/event.ts` (line ~82, inside
`eventWebhookModuleTemplate`'s emitted template string).

The emitted scaffold contains `// TODO: validate + process the incoming event
payload.` — a marker that trips the new gate. Reword to guidance, not a debt
marker (keep the async shape; do not change generated API):

```ts
export async function ${fn}(payload: unknown): Promise<void> {
  // Validate + persist the incoming ${name} event, then fan it out
  // (e.g. via src/lib/events.ts).
  console.log("received ${name} event:", payload);
}
```

No test asserts the old wording (verified: zero matches outside
`templates/event.ts`).

### Verification (T3)

1. `bunx vitest run packages/cli/test` → green (any template snapshot that did
   capture the line would need updating to the new wording — handle if it
   appears).
2. `bun run check:maintainability` → no `debt-marker` failures repository-wide.
3. Commit: `fix(cli): drop TODO marker from event webhook template (gate rule 2)`.

---

## T4 — Decisions registry (12 seed files)

**Files:** create `docs/decisions/000-template.md` + `001 … 012`.

Template (verbatim):

```md
# D-NNN · <Title>

- Status: <accepted | superseded-by-D-NNN>
- Context: <why this decision exists>

  <paragraphs>

- Decision: <what was decided>

  <paragraphs>

- Consequences: <what flows from it>

  <bullet list>

- Verification: <test/gate/path(s) that pin this decision, in backticks>
```

Seed files (content below; keep each file's `Verification` paths exactly as
written — every one was verified to exist today):

`001-native-wins.md`
```md
# D-001 · Native-wins selection (SELECTION + FFI_WINS)

- Status: accepted
- Context: Every hot primitive has a native (castrum) implementation and a
  pure-TS implementation. The repo must pick one deterministically and must
  never silently regress to a slower path.
- Decision: @ignex/native consults the SELECTION table (mode gates) plus the
  measured FFI_WINS overrides in `packages/native/src/selection.ts`. SELECTION
  is read-only data — never mutated at runtime.
- Consequences: A new addon symbol does not flip behavior until it is measured
  and recorded. Deterministic fast path; the fallback parity lane stays green.
- Verification: `packages/native/src/selection.ts`, `packages/native/test/selection.test.ts`
```

`002-native-fallback-duality.md`
```md
# D-002 · Native acceleration is never a hard dependency

- Status: accepted
- Context: `IGNEX_NATIVE=off` must produce byte-identical behavior on every
  surface, on any Bun runtime.
- Decision: Every native path has a byte-compatible pure-TS fallback; parity
  with the real addon is a CI gate (`smoke:fallback`). The near-identical
  fallback files are intentional parity, not duplication.
- Consequences: No Node compatibility layer; no castrum import outside
  `packages/native` (see D-011). Duplicate-file scans must exclude the
  intentional twins (they fail naive block-level matchers).
- Verification: `packages/native/src/selection.ts`, `packages/native/test/selection.test.ts`, `smoke:fallback`
```

`003-abi-ptr-len.md`
```md
# D-003 · C-ABI (ptr,len) pairs, never cstring buffers

- Status: accepted
- Context: A `(ptr,len)` buffer bound as `cstring` leaves a register
  uninitialized; the resulting garbage header parse was caught only on the
  cross-platform parity lane.
- Decision: All buffer-passing ABI uses explicit `(ptr,len)` pairs. Do not bind
  a length-prefixed buffer as `cstring`. New symbols pass the parity lane
  before shipping.
- Consequences: Slightly noisier FFI declarations; deterministic
  cross-platform behavior.
- Verification: `packages/native/src/ffi/types.ts`, `scripts/verify-native-ffi.ts`, `packages/native/test/wire-hardening.test.ts`
```

`004-wire-layout-ownership.md`
```md
# D-004 · Rust owns wire layouts; JS projects them

- Status: accepted
- Context: Ingress/route/scalar wire formats are defined by the Rust addon.
- Decision: Rust owns the layouts; JS projects them from the `castrum_*_layout`
  blobs. `DEFAULT_LAYOUT` parity safety nets are pinned by the FFI verification
  lane.
- Consequences: Layout drift between addon and JS is caught by the parity
  checks instead of surfacing in production.
- Verification: `scripts/verify-native-ffi.ts`, `packages/native/src/route-wire.ts`
```

`005-fail-closed-policy.md`
```md
# D-005 · Fail-closed on native core faults

- Status: accepted
- Context: A native core fault (ingress/handle/memory) must not silently serve
  wrong results.
- Decision: Core faults surface telemetry plus an optional 503; the default is
  availability-first pass-through, with `IGNEX_INGRESS_FAIL_CLOSED` to harden.
- Consequences: Availability-first default; operators can opt into fail-closed.
- Verification: `packages/native/src/ingress/factory.ts`, `packages/native/test/ingress-binding.test.ts`
```

`006-abort-status-200.md`
```md
# D-006 · Aborted-request responses are 200

- Status: accepted
- Context: The original castrum-adoption plan proposed abort status 499; the
  interpreted lifecycle and Elysia use 200.
- Decision: Pre-aborted requests respond with 200, not 499. Deviation recorded
  in the plan close-out.
- Consequences: Matches ecosystem behavior; no custom status-code leak.
- Verification: `packages/core/src/http/abort.ts`, `docs/superpowers/plans/2026-09-19-castrum-adoption.md`
```

`007-metrics-lazy-optional.md`
```md
# D-007 · Metrics binding is lazy + optional

- Status: accepted
- Context: Pre-symbol addons and hosts without `bun:ffi` must not crash metric
  collection.
- Decision: The metrics surface binds lazily and degrades to `null`; a bind-time
  probe (`__probe_total`) guards against partial symbol surfaces; the NAPI-plus
  wrapper accounts for the null case.
- Consequences: Metric loss instead of crashes on exotic hosts.
- Verification: `packages/native/test/metrics.test.ts`, `packages/native/src/runtime.ts`
```

`008-header-size-guards.md`
```md
# D-008 · Header size guards before packing

- Status: accepted
- Context: Oversized cookie/x-forwarded-for values must not blow the 64 KiB
  native wire block.
- Decision: cookie/xff values guard at 8192 bytes, small headers at 2048;
  oversized values are dropped BEFORE packing into the ingress block.
- Consequences: Bounded wire size; oversized headers are dropped, not
  truncated.
- Verification: `packages/native/src/ingress/headers.ts`, `packages/native/test/size-gates.test.ts`
```

`009-compiler-cache-version.md`
```md
# D-009 · COMPILER_CACHE_VERSION bump contract

- Status: accepted
- Context: The AOT cache can serve stale artifacts if codegen/linker output
  shape changes without a version bump.
- Decision: Any codegen/linker output change requires a
  `COMPILER_CACHE_VERSION` bump; `check:cache-versions` gates version-file
  drift.
- Consequences: Cache-invalidation discipline is enforced mechanically.
- Verification: `packages/compiler/src/cache.ts`, `scripts/check-cache-versions.ts`
```

`010-compose-over-classes.md`
```md
# D-010 · Compose over classes (RULES.md rule 3)

- Status: accepted
- Context: Public surfaces must be factories/composition with no classes.
- Decision: No classes on public surfaces; small pure functions in small files
  by domain. The maintainability system adds no abstraction layer on top — it
  enforces size and documentation instead.
- Consequences: Simpler mental model for newcomers; the 400-line cap is the
  guardrail, not more indirection.
- Verification: `RULES.md`, `packages/core/src/lifecycle/run.ts`
```

`011-castrum-bridge-only.md`
```md
# D-011 · castrum only inside packages/native

- Status: accepted
- Context: `packages/native` is the typed bridge over the castrum addon.
- Decision: Never import `castrum` outside `packages/native`; `@ignex/native`
  is the only bridge. The surface check runs over the vendored declaration.
- Consequences: One choke point for ABI/API drift; the rest of the repo never
  sees the addon directly.
- Verification: `packages/native/src/runtime.ts`, `scripts/check-native-surface.ts`
```

`012-offthread-consumers.md`
```md
# D-012 · Off-thread consumers for hot-path async work

- Status: accepted (design) — implementation tracks the public async API decision
- Context: Password verify / gzip compress on the hot path must not block the
  event loop.
- Decision: Hot-path async work routes through the shared task-consumer pool;
  the public API shape is tracked in the follow-on plan.
- Consequences: Pattern is defined; implementation lands with the API decision.
- Verification: `docs/superpowers/plans/2026-09-20-offthread-task-consumer.md`, `packages/native/src/tasks.ts`
```

### Verification (T4)

1. `bun run check:maintainability` → no `decision-ref:dangling` (all
   Verification paths exist).
2. Commit: `docs(decisions): decisions registry — template + 12 seed ADR-lite entries`.

---

## T5 — Issue→origin playbook

**File:** create `docs/ai/maintaining.md`.

Header explains the purpose (human face of the telemetry taxonomy: symptom →
origin module → pinning test → fix path) and the rule: every new
`reportDegradation` reason or native error code adds a row. Seed table (write
all 9 rows):

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

### Verification (T5)

1. File present, all paths exist.
2. Commit: `docs(ai): issue→origin maintaining playbook (seed rows)`.

---

## T6 — Split `core/debug/types.ts` (778 → 5 files)

**Files:** create `debug/types/{trace,api,knowledge,observability,index}.ts`; delete `debug/types.ts`; remove its entry from `maintainability.json`.

The monolith has **zero imports and zero private declarations** — pure type
surface. Declaration order in the file interleaves domains (not contiguous
slices), so copy each declaration **with its JSDoc block** into its domain
file:

| New file | Declarations (37 total) |
| --- | --- |
| `trace.ts` (9) | `SpanKind`, `SpanAttrs`, `Span`, `SystemSample`, `SystemStats`, `CapturedRequest`, `RequestTrace`, `TraceDetail`, `DebugSpanHandle` |
| `api.ts` (5) | `DebugApi`, `DebugEventSource`, `DebugEventRow`, `DebugEventSourceInfo`, `DebugEventsPayload` |
| `knowledge.ts` (10) | `AppKnowledge`, `KnowledgeRoute`, `KnowledgePlugin`, `KnowledgeStage`, `KnowledgeArea`, `KnowledgeDoc`, `KnowledgeDbAction`, `KnowledgeSdk`, `AiDebugSummary`, `KnowledgeOptions` |
| `observability.ts` (13) | `LogLevel`, `LogRecord`, `LogStats`, `LogQuery`, `HistogramSnapshot`, `RouteMetrics`, `MetricsSnapshot`, `LeakFinding`, `DiagnosticsReport`, `PersistStatus`, `HistoryTraceSummary`, `HistoryQuery`, `AppStateSnapshot` |

`index.ts` barrel: `export type { … }` for **all 37** (cross-file references
within each domain file keep knip's same-file shield; the 20 types consumed by
`packages/core/src/index.ts` are safe via the barrel; `AppKnowledge` is also
imported by `packages/core/test/knowledge-markdown.test.ts`).

Resolution check: importers use `"../../debug/types"`, `"../debug/types"`,
`"./debug/types"`, and `"../src/debug/types.js"` (tests) — all resolve to
`debug/types/index.ts` after the move. No importer references a deep path into
the monolith (verified).

Then: delete `debug/types.ts`; remove the `packages/core/src/debug/types.ts`
entry from `maintainability.json`.

### Verification (T6)

1. `bun run typecheck` → green.
2. `bunx vitest run packages/core/test` → green.
3. `bun run check:dead` → clean (if knip flags a barrel re-export, apply the
   barrel rule: drop it only if zero consumers through the barrel).
4. `bun run check:maintainability` → the removed entry does not re-appear as
   `size-cap:not-listed` (post-split files are all under 400).
5. `bun run verify:quick` → green.
6. Commit: `refactor(core): split debug/types.ts into domain files under debug/types/ (types-only)`

---

## T7 — Split `native/metrics.ts` (825 → 4 files)

**Files:** create `metrics/{types,decode,registry,index}.ts`; delete `metrics.ts`; remove its `maintainability.json` entry; update `docs/decisions/007-metrics-lazy-optional.md` if it cites `metrics.ts` (it cites the test file — no change expected; confirm).

Monolith facts: imports `{ type FfiMetricsSurface, getFfiMetrics } from "./ffi"`
and `{ native } from "./runtime"`; private decls `DEFAULT_BUCKETS`(70),
`sortedKeys`(72), `snapshotDecoder`(85), `sanitizeBuckets`(169),
`createFfiBacked`(180), `escapeLabelValue`(537), `fmtF64`(541). Export surface
at: `MetricsRegistryOptions`(19), `RegistryCounter`(28), `RegistryHistogram`(34),
`RegistrySnapshot`(42), `MetricsRegistryLike`(54), `decodeMetricsSnapshot`(92),
`createNativeMetricsRegistry`(367), `createMetricsRegistryFallback`(553),
`createMetricsRegistry`(817).

Target files (verbatim transcription; move each private helper with its sole
consumer — shared helpers go to the file of their dominant consumer and are
imported elsewhere; no helper is split across files):

| New file | Public exports | Private helpers |
| --- | --- | --- |
| `metrics/types.ts` | `MetricsRegistryOptions`, `RegistryCounter`, `RegistryHistogram`, `RegistrySnapshot`, `MetricsRegistryLike` | — |
| `metrics/decode.ts` | `decodeMetricsSnapshot` | `snapshotDecoder`; any label/value formatter used only by decode |
| `metrics/registry.ts` | `createNativeMetricsRegistry`, `createMetricsRegistryFallback` | `DEFAULT_BUCKETS`, `sortedKeys`, `sanitizeBuckets`, `createFfiBacked`, plus `escapeLabelValue`/`fmtF64` if used here; imports `getFfiMetrics`/`native` as the monolith did |
| `metrics/index.ts` | `createMetricsRegistry` (the dispatcher) + re-export the 9-name set | — |

Barrel `index.ts` must re-export exactly the 9 names the package entry pulls:
`createMetricsRegistry`, `createMetricsRegistryFallback`,
`createNativeMetricsRegistry`, `decodeMetricsSnapshot`, and the five types
(`packages/native/src/index.ts` imports all nine from `"./metrics"`).
`packages/native/src/ffi/index.ts` re-exports `getFfiMetrics` from the **ffi**
module's own `./metrics` — untouched.

### Verification (T7)

1. `bun run typecheck` → green.
2. `bun run test:native` → green (metrics suite included).
3. `bun run check:native:surface` → clean (70 symbols unchanged).
4. `IGNEX_NATIVE=off bun run smoke:fallback` → green.
5. `bun run check:dead` → clean.
6. `bun run check:maintainability` → no stale/grew entry, no `not-listed`.
7. `bun run lint` (oxlint + biome on staged set) → clean.
8. Commit: `refactor(native): split metrics.ts into metrics/{types,decode,registry,index}.ts`

---

## T8 — Split `native/crypto.ts` (752 → 9 files)

**Files:** create `crypto/{hmac,cookie,csrf,jwt,token,password,aead,session,index}.ts`; delete `crypto.ts`; remove its `maintainability.json` entry.

Monolith facts: imports `node:crypto` (`createCipheriv`, `createDecipheriv`,
`scryptSync`), `node:module` (`createRequire`), `./bun` (`bunHmacSha256`),
`./ffi` (`isFfiActive`), `./loader` (`getAddonPath`), `./runtime`
(`nativeFor`), `./telemetry` (`reportDegradation`), plus a multi-name import
block from a `./…` sibling (transcribe as-is). Module-level state is confined
to the session section (`let sessionFfi`, `getSessionFfi`, `SESSION_PROBE`,
`SESSION_PROBE_SECRET`, `sessionBindSelfTest`, `decodeSessionWire`) — it stays
in `session.ts`. Private constants by section: `enforceRequireExp`(62) +
`IAT_LEEWAY_SECONDS`(81) + `MAX_TOKEN_BYTES`(326) → `jwt.ts`;
`SCRYPT_*` + `passwordHashScrypt`/`passwordVerifyScrypt` → `password.ts`.

Target files (verbatim transcription):

| New file | Public exports |
| --- | --- |
| `crypto/hmac.ts` | `hmacSha256`, `hmacSha256Verify` (leaf; imports `bunHmacSha256`) |
| `crypto/cookie.ts` | `signCookie`, `signCookieFallback`, `verifyCookie`, `verifyCookieFallback` (imports `hmacSha256` from `./hmac`) |
| `crypto/csrf.ts` | `csrfToken`, `csrfTokenFallback`, `csrfVerify`, `csrfVerifyFallback` (imports `hmac` from `./hmac`) |
| `crypto/jwt.ts` | `jwtSign`, `jwtSignFallback`, `jwtVerify`, `jwtVerifyFallback` + `JwtSignOptions`, `JwtVerifyOptions` (imports `hmac` from `./hmac`; keeps `enforceRequireExp`, `IAT_LEEWAY_SECONDS`, `MAX_TOKEN_BYTES`) |
| `crypto/token.ts` | `randomToken`, `randomTokenFallback` |
| `crypto/password.ts` | `passwordHash`, `passwordHashAlgorithm`, `canVerifyPasswordHash`, `passwordVerify`, `passwordHashFallback`, `passwordVerifyFallback` + `PasswordHashOptions` (keeps `SCRYPT_*`, scrypt helpers; imports `nativeFor`) |
| `crypto/aead.ts` | `aeadEncrypt`, `aeadEncryptFallback`, `aeadDecrypt`, `aeadDecryptFallback` (imports `createCipheriv`/`createDecipheriv`, `nativeFor`) |
| `crypto/session.ts` | `sessionSeal`, `sessionOpen` (keeps the session Ffi block; imports `aeadEncrypt`-family from `./aead` if referenced) |
| `crypto/index.ts` | barrel re-exporting all 31 names |

Barrel set (all 31): `JwtSignOptions`, `JwtVerifyOptions`, `PasswordHashOptions`,
`hmacSha256`, `hmacSha256Verify`, `signCookie`, `signCookieFallback`,
`verifyCookie`, `verifyCookieFallback`, `csrfToken`, `csrfTokenFallback`,
`csrfVerify`, `csrfVerifyFallback`, `jwtSign`, `jwtSignFallback`, `jwtVerify`,
`jwtVerifyFallback`, `randomToken`, `randomTokenFallback`, `passwordHash`,
`passwordHashAlgorithm`, `canVerifyPasswordHash`, `passwordVerify`,
`passwordHashFallback`, `passwordVerifyFallback`, `aeadEncrypt`,
`aeadEncryptFallback`, `aeadDecrypt`, `aeadDecryptFallback`, `sessionSeal`,
`sessionOpen`.

Consumers (all via `"./crypto"` — keep working through the barrel):
`packages/native/src/index.ts` (entry), `execution.ts`
(`hmacSha256Verify`, `jwtSign`, `jwtVerify`, `passwordHash`, `passwordVerify`,
`randomToken`, `signCookie`, `verifyCookie`), `batch.ts` (`signCookie`,
`verifyCookie`, `csrfVerify`, `hmacSha256`, `hmacSha256Verify`), `tasks.ts`
(`passwordVerify`).

Cross-file imports are downward only (hmac is the leaf; nothing imports from
cookie/csrf/jwt/password/aead/session besides sibling domain files) — no cycles.
If any domain file needs a sibling export, import it from `./<sibling>` (never
from the barrel, to avoid cycle risk).

### Verification (T8)

1. `bun run typecheck` → green.
2. `bun run test:native` → green (ed25519, execution, tasks, native suites all
   exercise crypto paths).
3. `bun run check:native:surface` → clean.
4. `IGNEX_NATIVE=off bun run smoke:fallback` → green.
5. `bun run check:dead` → clean (barrel consumers cover all 31; apply the
   barrel rule if knip disagrees).
6. `bun run check:maintainability` → no stale/grew entry.
7. `bun run lint` → clean.
8. Commit: `refactor(native): split crypto.ts into domain files under crypto/`

---

## T9 — Close-out: docs, full verify, ledger

**Files:** `docs/stability.md` (item 12 progress), `docs/ai/TREE.md`
(regenerate), `.superpowers/sdd/2026-09-20-maintainability/progress.md`
(ledger of all commits).

1. Update `docs/stability.md` item 12: mark the maintainability gate live, list
   the three Phase-1 splits as done, note the allowlist now holds the remaining
   32 files (tiers A–E), and that `docs/decisions/` + `docs/ai/maintaining.md`
   exist.
2. `bun run gen:ai-map` to refresh `docs/ai/TREE.md`.
3. Full gates: `bun run typecheck && bun run typecheck:cli && bun run lint &&
   bun run jsdoc:check:strict && bun run check:dead && bun run
   check:maintainability && bun run test:parallel && bun run
   check:native:surface && bun run smoke && bun run smoke:fallback`.
4. Commit: `docs(stability): maintainability system Phase 1 — gate + registry + playbook + splits (item 12)`.
5. Append every commit hash from T1–T9 to the SDD ledger with a one-line note.

---

## Risks / callouts

- **knip barrel rule**: the only known flake risk for the three splits. Handled
  per split with the established remove-if-unused-through-barrel rule; never
  drop a name the entry (`index.ts`) or execution/batch/tasks imports.
- **Line-count definition**: the script counts `split("\n").length`; reconcile
  `knownOver` recorded counts via `--report` before first gate run so the
  committed JSON matches the script's own counter exactly.
- **D-007 verification path**: cited the stable test file specifically so the
  metrics split cannot dangle it; if the executor re-cites `metrics.ts`
  anywhere, update it in T7's commit.
- **gen-debug-ui cleanup** runs before `buildArtifact`; it must not remove its
  own in-progress dir (it runs at startup, before `mkdtempSync`).
- **No behavior change**: any diff beyond pure moves/renames in T6–T8 is a
  mistake; typecheck + suites + surface + parity gates catch drift.