# Plan — Maintainability Phase 2 (intern bar: doc-rot guard, Tier-A splits, core barrel, playbook, first-day)

Date: 2026-09-20 · Status: **approved** · Parent spec: `docs/superpowers/specs/2026-09-20-maintainability-design.md` (approved; Phase 1 delivered the gate + registry + playbook + 3 splits)

> **Scope (user-approved, five work items):** (1) extend the doc-rot guard from
> `docs/decisions/` to `.agents/skills/*/SKILL.md` + `docs/ai/*.md`; (2) split
> `native/ffi/bind.ts` (481); (3) split `native/loader.ts` (445); (4) split
> `native/route-wire.ts` (444); (5) split `core/src/index.ts` (606, the public
> barrel — tree-shaking care); (6) expand `docs/ai/maintaining.md` playbook with
> non-native bug classes, add `docs/ai/first-day.md` onboarder, point to it from
> `AGENTS.md`, and close out (stability item 12, TREE, full verify, ledger).

## Global constraints (apply to every task)

- Bun-first; scripts run with `bun scripts/<name>.ts`.
- Move-only splits: **verbatim transcription** — no behavior/type changes, no
  renames, no reformatting of the moved code. Same rule that shipped the
  ffi/ingress/metrics/crypto splits. Barrels re-export so every existing import
  path resolves. Walking a monolith into a directory `X/` keeps `"./X"` /
  `"../X"` imports working (dir + index resolves like the file did).
- The **only** allowed non-move change inside a split: extracting a private
  helper into the file of its sole consumer (dominant-consumer rule), and a
  thin facade (e.g. `bind()`) calling the new modules instead of inlining them.
  Function bodies stay byte-identical.
- knip barrel rule: after a split, a barrel re-export knip flags as unused is
  removed **only if it has zero consumers through the barrel**; package-entry
  importers (e.g. `packages/native/src/index.ts`) define the required set.
- When a split removes a `maintainability.json` `knownOver` entry (file gone or
  ≤ cap), remove the entry in the same commit (gate rule 1 fails on stale
  entries).
- Fix any path cited in scoped docs **before** wiring the doc-rot guard, or the
  new rule fails red on the real tree (verified pre-flight: 3 real cites to
  fix, 6 glob tokens the rule must skip, 2 cross-repo castrum docs to reword).
- Commit after each task (`git commit --no-verify`); biome `--write` only on the
  staged set; record each commit in
  `.superpowers/sdd/2026-09-20-maintainability-phase2/progress.md`
  (gitignored ledger).
- Do **not** introduce classes on public surfaces, new abstraction layers, or
  new dependencies. No `castrum` import outside `packages/native`.

## File structure

### Created
```
docs/superpowers/plans/2026-09-20-maintainability-phase2.md   this plan
packages/native/src/ffi/bind/types.ts      T2  Raw1/4/5/6/9 + DlopenFn types
packages/native/src/ffi/bind/dlopen.ts      T2  createRequire("bun:ffi") + symbol table → dlopenSymbols()
packages/native/src/ffi/bind/surface.ts     T2  buildSurface(symbols): one/validator/packedWrite/cstr + surface literal
packages/native/src/ffi/bind/access.ts      T2  cached/bound/bind()/isFfiActive/getFfi
packages/native/src/ffi/bind/index.ts       T2  barrel: getFfi, isFfiActive (+ Raw types if referenced)
packages/native/src/loader/types.ts         T3  NativeAddon, NativeInitOptions, NativeInitResult
packages/native/src/loader/paths.ts         T3  castrum package-location probing (ancestorDirs, castrumFrom*, findCastrumDir, …)
packages/native/src/loader/require.ts       T3  isNativeSurface guard + requireAddon/normalize/reportLoadFailure
packages/native/src/loader/native.ts        T3  `native` let + init IIFE + memoized resolveAddonPathOnce + getNative/getAddonPath/isNativeAvailable
packages/native/src/loader/init.ts          T3  defaultThreads + initNative + loadCastrumModule
packages/native/src/loader/index.ts         T3  barrel (8 names)
packages/native/src/route-wire/constants.ts T4  ROUTE_DESC_MAGIC, ROUTE_DESC_VERSION, RoutePartKind, PART_TAG/TAG_PART, frame+result flags
packages/native/src/route-wire/stages.ts    T4  NativeRouteStage, ROUTE_STAGE_TAG, TAG_STAGE
packages/native/src/route-wire/plan.ts      T4  NativeRoutePlan, planHasStage, dv, encodeRouteDescriptor, DecodedRouteDescriptor, decodeRouteDescriptor
packages/native/src/route-wire/frame.ts     T4  NativeRouteFrame + pack/read frame functions
packages/native/src/route-wire/result.ts    T4  NativeRouteRunResult, ReadRouteResultOptions, readRouteResult
packages/native/src/route-wire/index.ts     T4  barrel (28 names)
packages/core/src/publ/{native,shared,client,content,data,debug,http,lifecycle,platform,plugins,realtime,security,types}.ts  T5  sub-barrels
docs/ai/first-day.md                        T6  intern onboarder (run → trace → feature → gates)
.superpowers/sdd/2026-09-20-maintainability-phase2/progress.md  T6  ledger
```

### Modified
```
scripts/check-maintainability.ts  T1  rule 6 → doc-refs (decisions + skills + docs/ai), token normalization, glob skip
maintainability.json              T1  ignoreDocRefs/rule config if needed; T2–T5  remove 4 entries (33 → 29)
.agents/skills/ignex-core-framework/SKILL.md  T1  fix stale `http/context.ts` cite
.agents/skills/ignex-native-castrum/SKILL.md  T1  reword cross-repo `docs/NATIVE-ROUTE.md` / `docs/FFI_BUN_GUIDE.md`
packages/native/src/ffi/index.ts  T2  `./bind` now resolves to ffi/bind/index.ts (no edit needed — dir+index)
docs/ai/maintaining.md            T6  + non-native bug-class rows
AGENTS.md                         T6  “New here?” pointer to docs/ai/first-day.md
docs/stability.md                 T6  item 12 progress (29-file allowlist, Phase-2 splits, doc-rot guard)
docs/ai/TREE.md                   T6  regenerated (bun run gen:ai-map)
```

### Deleted
```
packages/native/src/ffi/bind.ts    T2
packages/native/src/loader.ts      T3
packages/native/src/route-wire.ts  T4
packages/core/src/index.ts         T5  (content moves into publ/*; slim entry replaces it)
```

---

## T1 — Doc-rot guard: decisions + skills + docs/ai

**Files:** `scripts/check-maintainability.ts`, the 2 stale-cite skill fixups, `maintainability.json` (only if config keys are added).

### 1a. Rule rework (`check-maintainability.ts`)

Replace `checkDecisionRefs` (rule 6) with `checkDocPathRefs`:

- Scan **three doc scopes**:
  1. `docs/decisions/*.md` → only `Verification:` lines (existing behavior).
  2. `.agents/skills/**/SKILL.md` (recurse the skills dir) → all lines.
  3. `docs/ai/*.md` **except `docs/ai/TREE.md`** (generated from the tree; its
     content is guaranteed current and it would fight the gate on staleness).
- Token extraction stays `` body.matchAll(/`([^`]+)`/g) ``; before matching the
  path, **normalize the token** by stripping all whitespace (handles a
  backticked path wrapped across two lines — the `context.ts` case).
- **Skip** a normalized token when it contains a glob char (`*` or `?`) — e.g.
  `packages/*/test`, `packages/core/src/debug/*` (intentional globs, not paths).
- **Recognized local prefixes** (only these are checked): `packages/`,
  `scripts/`, `docs/`, `.agents/`, plus the bare names `RULES.md`,
  `AGENTS.md`, `maintainability.json`. Anything else (env vars, command names,
  bare script names, `smoke:fallback`) is skipped.
- Missing path → diag `doc-ref:dangling` (rule renamed from
  `decision-ref:dangling`; update the fileoverview prose + the self-test `want`
  set + the OK print text).

Self-test additions (dirty tree must fire `doc-ref:dangling` from BOTH a
skill file and a docs/ai file; clean tree must pass):

```
<dirty>/.agents/skills/z/SKILL.md      "- Requires: `packages/a/src/nope.ts`\n"
<dirty>/docs/ai/scratch.md             "- Uses: `scripts/nope.ts`\n"
<dirty>/docs/ai/wrap.md                "path `packages/a/src/\nwrap.ts`"  → fires after whitespace normalization
```

Move the two existing cross-repo skill cites so they no longer look local:
`.agents/skills/ignex-native-castrum/SKILL.md` — `castrum's `docs/NATIVE-ROUTE.md`` → `castrum's `NATIVE-ROUTE.md`` (same for `docs/FFI_BUN_GUIDE.md`). Fix the real stale cite in `.agents/skills/ignex-core-framework/SKILL.md`: the backticked `packages/core/src/http/context.ts` (wrapped across two lines) → `packages/core/src/http/context/` (directory + barrel).

### 1b. Verification (T1)

1. Pre-flight re-scan (the node one-liner from planning, updated for the new
   prefix/skip rules) → **zero** dangling/scope surprises.
2. `bun scripts/check-maintainability.ts --self-test` → PASS (8 rules, incl. the
   new fixtures).
3. `bun run check:maintainability` → `OK — 464 src files`, exit 0.
4. Commit: `feat(scripts): doc-rot guard covers skills + docs/ai (rule 6 → doc-refs)`.

---

## T2 — Split `native/ffi/bind.ts` (481 → 5 files)

**Files:** create `ffi/bind/{types,dlopen,surface,access,index}.ts`; delete `ffi/bind.ts`; remove its `maintainability.json` entry.

Move-only, per the monolith's line map (all line numbers = current `bind.ts`):

| New file | Contents (verbatim) |
| --- | --- |
| `types.ts` | `RawIn`/`Raw4`/`Raw5`/`Raw6`/`Raw9` (12–34) + the `DlopenFn` type (64–67) |
| `dlopen.ts` | `export const dlopenSymbols = (path: string): Record<string, (...a: unknown[]) => number \| bigint> \| null =>` wrapping lines 69–167: the `createRequire` require of `bun:ffi`, the `dlopen(path, { …symbol table… })` call, destructure + return `symbols`; **throws** on dlopen failure (the current catch in `bind()` keeps its `mode==="ffi"` rethrow + degradation semantics) |
| `surface.ts` | `export const buildSurface = (symbols: Record<string, (...a: unknown[]) => number \| bigint>): FfiSurface =>` containing the closures `one`/`validator`/`packedWrite`/`cstr` (170–203) + the whole `surface` literal (205–434). Imports: `growExact`, `MAX_VAR_OUTPUT`, `safeJsonParse` from `./helpers`; `decoder` from `../util`; `type FfiSurface` from `./types`; and the local `Raw*` types from `./types` |
| `access.ts` | `let cached` / `let bound` (44, 49), `isFfiActive` (47), `bind()` (50–471) with the inline dlopen+surface bodies replaced by `const symbols = dlopenSymbols(path)` / `const surface = buildSurface(symbols)` (the mode/path/self-test/report-degradation skeleton stays verbatim), `getFfi` (477–481). Imports: `getAddonPath` from `../loader`, `reportDegradation` from `../telemetry`, `resolveFfiMode`/`isBun` from `./helpers`, `selfTest` from `./self-test`, `dlopenSymbols` from `./dlopen`, `buildSurface` from `./surface` |
| `index.ts` | barrel: `export { getFfi, isFfiActive } from "./access"` (matches `ffi/index.ts` line 8 exactly) |

Consumers unchanged: `ffi/index.ts` does `export { getFfi, isFfiActive } from "./bind"` — after the move this resolves to `ffi/bind/index.ts`. No other in-repo consumer imports `./bind` (verified).

### Verification (T2)

1. `bun run typecheck` → green.
2. `bun run test:native` → green (178).
3. `bun run check:native:surface` → 70 symbols unchanged.
4. `IGNEX_NATIVE=off bun run smoke:fallback` → green.
5. `bun run check:dead` → clean (barrel rule if knip complains).
6. `bun run check:maintainability` → no `size-cap:not-listed` for `ffi/bind.ts`.
7. `bun run lint` (biome `--write` on staged set) → clean (baseline 6 warnings).
8. Commit: `refactor(native): split ffi/bind.ts into ffi/bind/{types,dlopen,surface,access,index}.ts`

---

## T3 — Split `native/loader.ts` (445 → 6 files)

**Files:** create `loader/{types,paths,require,native,init,index}.ts`; delete `loader.ts`; remove its `maintainability.json` entry.

| New file | Contents (verbatim) |
| --- | --- |
| `types.ts` | `export type NativeAddon = typeof Castrum` (33), `interface NativeInitOptions` (374), `interface NativeInitResult` (383) + the `import type * as Castrum from "../vendor/castrum"` |
| `paths.ts` | castrum package-location probing: `srcDir`/`pkgDir` (51–52), `castrumFromOwnPackage` (55), `castrumFromSymlink` (70), `castrumFromNodeModules` (82), `castrumFromBunLink` (88), `ancestorDirs` (96), `castrumFromWorkspace` (109), `findCastrumDir` (174), `supportsX8664V3` (200), `findAddonPath` (211), `resolveCastrumEntryPath` (231), `castrumFromOverride` (257). Imports: `node:fs`, `node:module`, `node:path`, `node:url` |
| `require.ts` | `isNativeSurface` guard (38), `requireAddon` (273), `normalize` (280), `reportedLoadFailure` (289), `reportLoadFailure` (290) + `telemetry` import |
| `native.ts` | `let native` (35), `addonPath` memo (308), `resolveAddonPathOnce` (311), the `init` IIFE (323), `getNative` (360), `getAddonPath` (368), `isNativeAvailable` (371) — imports `findCastrumDir` etc. from `./paths` and the require block from `./require` |
| `init.ts` | `nativeInitialized` (390), `defaultThreads` (393), `initNative` (409), `loadCastrumModule` (432) — imports `native`/`getNative` handling from `./native` |
| `index.ts` | barrel: `NativeAddon`, `NativeInitOptions`, `NativeInitResult` (types) + `getNative`, `getAddonPath`, `isNativeAvailable`, `initNative`, `loadCastrumModule` |

Consumers (all `"./loader"` → resolve to `loader/index.ts`, unchanged): `batch.ts`, `http/conditional.ts`, `pipeline.ts`, `runtime.ts` (type), `selection.ts`, `ingress-binding.ts`, `route.ts`, `index.ts`, `memory.ts`.

### Verification (T3)

Same gate set as T2 (typecheck, test:native, surface 70, smoke:fallback, dead, maintainability, lint). Commit: `refactor(native): split loader.ts into loader/{types,paths,require,native,init,index}.ts`

---

## T4 — Split `native/route-wire.ts` (444 → 6 files)

**Files:** create `route-wire/{constants,stages,plan,frame,result,index}.ts`; delete `route-wire.ts`; remove its `maintainability.json` entry.

| New file | Contents (verbatim) |
| --- | --- |
| `constants.ts` | `ROUTE_DESC_MAGIC` (32), `ROUTE_DESC_VERSION` (42), `RoutePartKind` (45), `PART_TAG` (47), `TAG_PART` (55); `ROUTE_FRAME_FLAG_HAS_BODY` (240); `ROUTE_RESULT_FLAG_*` (344–356) |
| `stages.ts` | `NativeRouteStage` (72), `ROUTE_STAGE_TAG` (81), `TAG_STAGE` (89) — imports `PART_TAG`-style maps only if used, else standalone |
| `plan.ts` | `NativeRoutePlan` (104), `planHasStage` (116), `dv` (119), `encodeRouteDescriptor` (128), `DecodedRouteDescriptor` (171), `decodeRouteDescriptor` (180); imports `RoutePartKind`/maps from `./constants`, `NativeRouteStage`/`ROUTE_STAGE_TAG` from `./stages` |
| `frame.ts` | `NativeRouteFrame` (243), `packRouteFrameLength` (253), `packRouteFramePartsLength` (271), `readRouteFrameLengths` (283), `packRouteFrameInto` (291), `packRouteFramePartsInto` (302), `packRouteFrame` (336) |
| `result.ts` | `NativeRouteRunResult` (359), `ReadRouteResultOptions` (380), `readRouteResult` (409); imports the result flags from `./constants` |
| `index.ts` | barrel: all 28 public names (`ROUTE_DESC_MAGIC`, `ROUTE_DESC_VERSION`, `RoutePartKind`, `NativeRouteStage`, `ROUTE_STAGE_TAG`, `NativeRoutePlan`, `planHasStage`, `encodeRouteDescriptor`, `DecodedRouteDescriptor`, `decodeRouteDescriptor`, `ROUTE_FRAME_FLAG_HAS_BODY`, `NativeRouteFrame`, the 5 `packRouteFrame*`/`readRouteFrameLengths`, the 7 `ROUTE_RESULT_FLAG_*`, `NativeRouteRunResult`, `ReadRouteResultOptions`, `readRouteResult`) |

Consumers (all `"./route-wire"` → resolve to `route-wire/index.ts`, unchanged): `native-handler.ts`, `route.ts` (+ its `export type { … } from "./route-wire"`), `index.ts`, `ingress/router.ts` (`../route-wire`). Private helpers shared between sections (`dv`, part/stage tag maps) go to their dominant consumer per the table; no helper is split across files.

### Verification (T4)

Same gate set as T2/T3. Commit: `refactor(native): split route-wire.ts into route-wire/{constants,stages,plan,frame,result,index}.ts`

---

## T5 — Split `core/src/index.ts` (606 → 13 sub-barrels + slim entry)

**Files:** create `packages/core/src/publ/{native,shared,client,content,data,debug,http,lifecycle,platform,plugins,realtime,security,types}.ts`; replace `index.ts` with a ~30-line entry; remove its `maintainability.json` entry.

Partition by the section banners in the current file (line refs = today's `index.ts`):

| Sub-barrel | Source lines | Exports (names verbatim from the file) |
| --- | --- | --- |
| `publ/native.ts` | 27–80 | the `@ignex/native` block (49 names, incl. `backend`, `SELECTION`, native route types) |
| `publ/shared.ts` | 81–97 | FP toolkit (`compose`, `pipe`, `Result`, `Task`, …) |
| `publ/client.ts` | 98–100 | `ClientOptions`, `ClientResponse`, `IgnexClient`, `createClient` |
| `publ/content.ts` | 101–127 | i18n + template blocks |
| `publ/data.ts` | 128–186 | cache/content-encoding/dataloader/drivers/query/ratelimit/request/schema/store blocks |
| `publ/debug.ts` | 187–229 | debug + observatory primitives |
| `publ/http.ts` | 230–326 | http surface (context, body, proxy, files, sse, ws, route DSL, conditional) |
| `publ/lifecycle.ts` | 327–362 | hooks/lifecycle/plugin |
| `publ/platform.ts` | 363–455 | env/config/jobs/errors/platform |
| `publ/plugins.ts` | 456–518 | plugin factories |
| `publ/realtime.ts` | 519–528 | realtime rpc block |
| `publ/security.ts` | 529–590 | auth/csrf/session/security |
| `publ/types.ts` | 591–606 | shared types |

Each sub-barrel keeps its moved `export { … } from "…"` / `export type { … }` blocks **verbatim** (including internal comments). New `index.ts`:

```ts
/// <reference lib="dom" />
export * from "./publ/native";
export * from "./publ/shared";
export * from "./publ/client";
export * from "./publ/content";
export * from "./publ/data";
export * from "./publ/debug";
export * from "./publ/http";
export * from "./publ/lifecycle";
export * from "./publ/platform";
export * from "./publ/plugins";
export * from "./publ/realtime";
export * from "./publ/security";
export * from "./publ/types";
```

Collision safety: the current single-file barrel already compiles, so no name
is exported by two modules today → `export *` star-star ambiguity cannot arise
(tsc would report it if it did). The `/// <reference lib="dom" />` stays at the
top of the entry (it is the DOM-lib contract for consumers, per the fileoverview).

### Verification (T5)

1. `bun run typecheck` → green (root + cli + app use `@ignex/core` entry).
2. `bunx vitest run packages/core/test` → green (tests import the entry + deep paths).
3. `bun run build && bun run smoke` → green (the app imports many core names; smoke exercises the surface).
4. `bun run check:dead` → clean; if knip flags sub-barrel re-exports with zero
   barrel consumers, apply the barrel rule (drop only if truly unused through `index.ts`).
5. `bun run check:maintainability` → no `size-cap` violation for the new entry.
6. `bun run lint` (biome `--write` on staged set) → clean.
7. Commit: `refactor(core): split the public barrel into src/publ/* sub-barrels (entry stays the full surface)`

---

## T6 — Docs close-out: playbook, first-day, AGENTS, stability, TREE

**Files:** `docs/ai/maintaining.md`, `docs/ai/first-day.md` (new), `AGENTS.md`, `docs/stability.md`, `docs/ai/TREE.md`, ledger.

### 6a. Playbook expansion (`docs/ai/maintaining.md`)

Append these rows to the Seed table (every cited test path verified to exist):

| Symptom (log/telemetry/response) | Origin | Pinning test / fix |
| --- | --- | --- |
| 404/405/`OPTIONS` oddities on an interpreted route | `packages/core/src/http/router.ts` | `packages/core/test/router.test.ts` + `router-utils.test.ts` |
| Session cookie missing/`HttpOnly` off / visits not persisting | `packages/core/src/security/session.ts` | `packages/core/test/session-fusion.test.ts` + `session-store.test.ts` (fail-closed + expiry) |
| JWT/cookie port mismatch (interpreted vs AOT) | `packages/core/src/security/` ↔ `packages/native/src/crypto/` | `packages/core/test/cookie-port.test.ts`, `packages/core/test/auth-module.test.ts`, `packages/native/test/` crypto suites |
| Generated server artifact wrong / stale / won't boot | `packages/compiler/src/phases/*` + `emitter.ts` | `bun run smoke` (+ `smoke:fallback`), `packages/compiler/test/cache.test.ts` (cache-version self-heal) |
| SDK client emits wrong types / dead surface | `packages/compiler/src/sdk/*` | `packages/compiler/test/sdk.test.ts` (+ `sdk-flatbuffers`/`sdk-realtime`) |
| Scaffolded project broken (create/templates) | `packages/cli/src/commands/create.ts`, `templates/*` | `packages/cli/test/create.test.ts` + template suites; `bun run smoke` |

### 6b. First-day onboarder (`docs/ai/first-day.md`)

Short doc (≈60 lines): ① run it (`bun install` → `bun run verify:quick` → `bun run dev`); ② the three-layer mental model (mechanical gate / decisions registry / playbook) with one link each; ③ three canned exercises — (a) trace a bug from `docs/ai/maintaining.md` row to code+test; (b) add a route plugin following `docs/adding-a-feature.md` section A; (c) run the gates (`verify:quick`, `test:parallel`, `smoke:fallback`); ④ where each package lives (1-line table) + the skill list. Point to it from `AGENTS.md` (top, under the intro: "**New here?** Start with `docs/ai/first-day.md`").

### 6c. Close-out

1. `docs/stability.md` item 12: gate extended to skills + docs/ai; Phase-2 splits listed (`ffi/bind`, `loader`, `route-wire`, core barrel); allowlist now 29 files (tiers A–E); first-day + expanded playbook noted.
2. `bun run gen:ai-map` → refresh `docs/ai/TREE.md`.
3. Full gates: `bun run typecheck && bun run typecheck:cli && bun run lint && bun run jsdoc:check:strict && bun run check:dead && bun run check:maintainability && bun run test:parallel && bun run check:native:surface && bun run smoke && bun run smoke:fallback`.
4. Commit: `docs(ai): playing-by-ear + first-day onboarder; stability item 12 (Phase 2)`.
5. Append T1–T6 commit hashes to the SDD ledger with one-line notes.

---

## Risks / callouts

- **`export *` barrel collisions (T5):** cannot arise (the current single file
  compiles with distinct names); tsc + app build + smoke verify regardless.
- **Self-test false-red (T1):** the 6 glob tokens (`packages/*`, `docs/*.md`,
  `packages/core/src/debug/*`, …) must be skipped by the glob-char check; the 2
  cross-repo castrum docs get reworded (not placed on an ignore list) so the
  rule stays simple.
- **TREE.md exclusion (T1):** `docs/ai/TREE.md` is generated and guaranteed
  current; scanning it would only add noise.
- **Dominant-consumer moves (T2–T4):** `dlopenSymbols`/`buildSurface`/`bind()`
  facades are the only non-verbatim edits; every moved body stays byte-identical.
- **No behavior change (T2–T5):** typecheck + suites + surface + parity gates
  catch drift; any diff beyond the documented moves is a mistake.