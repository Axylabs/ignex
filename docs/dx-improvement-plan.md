# DX Improvement Plan — "Send an event to the frontend" user journey

> **Status**: P0 implemented + verified on a fresh scaffold (2025-08-26).
> Findings were **reproduced in real scaffolded apps**
> (`/home/adeel/poc/ignus/.dx-eval/` — throwaway; `rm -rf` it), fixed in the
> working tree, and re-verified end to end (see §4).
>
> Goal: make the *default* scaffolded journey the *optimal* one, so users
> manage business requirements instead of navigating the framework, and turn
> that journey into a CI-enforced regression gate so the product stays stable.

---

## 1. What we did (the dogfood)

1. Scaffolded a fresh app with the local CLI:
   `ignex create dx-app --features openapi,middleware,examples,tests,cors,compression,security,logger,auth,sse,ws`.
2. Installed (linked local packages per `docs/ai/LOCAL_DEV.md`), `ignex build`
   (130 ms, native castrum), ran the compiled server, hit routes — all clean.
3. Ran the **"send a message to the frontend"** scenario exactly as the
   framework tells a user to: `ignex event bus order` → wire
   `novaPlugin({ port: 3001, inbound: [...] })` → publish via the scaffolded
   route → receive on a typed FE client (`createRealtimeClient` from the
   generated SDK).
4. Fixed, one by one, everything that broke; reached a working end-to-end
   delivery (`POST /events/emit.order` → 202 → FE received
   `order.created: {"id":"o-1","total":99.5}` over `ws://localhost:3001/ws`).

**Bottom line**: the journey works, but the scaffold's own instructions
produce **2 runtime 500s and 2+ typecheck failures**, and ~6 of ~13 steps are
undocumented or require reading framework source to discover. Details below.

---

## 2. Friction inventory (all reproduced)

### A. `ignex event bus` — the scaffold's own output is broken

The command scaffolds 3 files and prints: *"add `novaPlugin({ port: 3001,
inbound: ["order.created"] })` to src/app.config.ts plugins"*.

| # | Friction | Evidence |
|---|----------|----------|
| A1 | Hint omits `events: {}` — the module-global `emit`/`on`/`emitToUser` only bind when `createServer({ events })` runs. Following the hint → **500 at runtime**: `ignex events: no events hub bound — pass events: {} to createServer()`. The error names `createServer()`, which the user never called (they called `novaPlugin`) — misleading. | `POST /events/emit.order` → `500 INTERNAL_ERROR`; stack in server log. |
| A2 | Custom events are unknown to the built-in registry. Even with `events: {}`, emit → **500**: `ignex: unknown event "order.created"`. Fix requires generating bindings from a TypeBox wire contract and passing `bindings` to `novaPlugin` — the hint never mentions it. | second 500 in server log. |
| A3 | The scaffolded `src/lib/events.ts` re-exports `emit`/`on`/`emitToUser` from `@ignex/nova/events`, which is **typed against the built-in market-data registry** (`"trade" | "quote" | ...`). The scaffolded route + consumer call `emit("order.created", …)` → **TS2345, won't typecheck**. | `tsc --noEmit`: 2× TS2345. |
| A4 | Consumer template returns `off` from `on(...)` — but the global `on` returns `void` → **TS2322**. | `tsc --noEmit`: TS2322 in `src/modules/events/order.consumer.ts`. |
| A5 | The contract file `src/realtime.ts` is **not scaffolded** and its exact shape (`export const realtime = { subjectPrefix, schemas?, events, controlEvents? }`, `import { Type } from "@sinclair/typebox"`) is only documented in `packages/cli/src/utils/realtime-artifact.ts` source comments — not in any user-facing doc, and not discoverable from the scaffold. | the events.ts comment says "declare in src/realtime.ts" but no file, format, or import source is given. |
| A6 | The generated SDK lands in `.ignex/` (gitignored, outside the app's `tsconfig.include`). Wiring `bindings` into the app requires hand-relative imports (`../.ignex/sdk/realtime/index.js`), a tsconfig `include` edit, and survives only until the next clean clone. The *supported* path is publishing/installing the SDK as an npm package — heavy for a single-app monolith. | TS2307 until tsconfig/include fix. |
| A7 | `ignex sdk --platform realtime` needs **`flatc` on PATH** — only mentioned in the error message, never in the scaffold hint/docs. | error text in `compiler/src/sdk/realtime.ts:64`. |
| A8 | **No typed server-side emit.** The plugin's public type (`NovaServerHandle`) hides `server.events`; the typed hub is reachable only by casting. The global emit needs `as never` casts for custom events. Server-side code gets no payload types. | `plugins/nova.ts` interface; the cast in the working demo. |

### B. `--features sse` scaffold route does not compile

| # | Friction | Evidence |
|---|----------|----------|
| B1 | `sseRouteTemplate` emits `sse(async function* () { … })` — a **thunk** — but `sse()` takes the **generator**. → TS2345. (`ignex event sse <name>` is correct; the create-time feature template is wrong.) | `tsc --noEmit` on the scaffold. |

### C. Ports & concurrent instances

| # | Friction | Evidence |
|---|----------|----------|
| C1 | `novaPlugin` requires a hardcoded `port: 3001`; nothing derives it from env/config. Two app instances (dev server + `vitest` boot smoke) **clash on 3001** → the scaffolded test fails until the dev server is stopped. | test run failed with the app server up; passed when stopped. |
| C2 | The realtime server is a **second port** alongside the HTTP server. Users must know/configure both; app-level middleware (cors, security, logger, ratelimit) does **not** apply to the WS port. |

### D. Dependency discovery

| # | Friction | Evidence |
|---|----------|----------|
| D1 | `bun add @ignex/nova` is hinted (good) but never auto-installed in non-TTY; `@sinclair/typebox` (needed by `src/realtime.ts` and the generated SDK) is **never mentioned** — the scaffold installs `typebox` (v1.x) for route schemas, so the app ends up with two TypeBox majors. | scaffold `package.json`; `src/realtime.ts` import. |

### E. Docs drift (the docs teach the broken flow)

| # | Friction | Evidence |
|---|----------|----------|
| E1 | `docs/cookbook.md` "Typed realtime events" shows `novaPlugin({ port, path, inbound, authenticate })` **without `events`**, then shows `emitToUser` — the exact combination that 500s (A1). | cookbook lines 292–315. |
| E2 | `ignex doctor` reports "All checks passed" on an app whose realtime wiring is broken — no check for realtime contract/bindings/events. | `ignex doctor` on the broken app. |

### F. What already works well (keep)

- `ignex create` → `ignex build` (130 ms, native) → run: zero-config, clean.
- Generated artifacts (`routes.d.ts`, `client.ts`, `openapi.json`, `manifest.json`).
- `ignex event bus` scaffolds the right *shape* (thin route + module) quickly.
- `ignex build` auto-writes `realtime.json` from `src/realtime.ts`; `ignex sdk --platform realtime` emits a complete typed client (28 files) incl. `createRealtimeClient` and RPC.
- End-to-end typed delivery works once wired; scaffolded vitest passes (when ports are free); `ignex doctor` exists and is useful.

---

## 3. The plan

Principle: **the happy path must be the only path** — scaffolded code compiles
and runs; anything a user must hand-wire beyond business logic is a framework
bug. Priority order below.

### P0 — make scaffolded code correct (stability: users cannot ship broken output)

1. **`ignex event bus` emits a working, compiling project.**
   - Scaffold `src/realtime.ts` too, with the named event + a TypeBox payload
     (`import { Type } from "@sinclair/typebox"`), so the contract file the
     events.ts comment points at actually exists.
   - Emit the full `novaPlugin` snippet: `{ port, inbound, events: {}, bindings }`
     with the `bindings` import from the generated SDK (see P0-3 for where).
   - Fix the consumer template: `on(...)` returns `void` — drop `return off`
     and the `(): () => void` return type; document when to call it (after the
     hub binds, e.g. lifecycle `started`).
   - Add `@sinclair/typebox` to the scaffold's dependency list when realtime
     features are involved (or make the wire contract use the scaffold's
     existing `typebox` v1 import to avoid two TypeBox majors).
2. **Fix `sseRouteTemplate`** (`--features sse`): call the generator —
   `sse((async function* () { … })())` — or change `sse()` to also accept a
   thunk (backwards-compatible). Add a compile gate so this can't regress
   (P2).
3. **Fix the docs that teach the broken flow**: cookbook realtime example gets
   `events: {}` + bindings note; getting-started mentions the realtime flow
   briefly; `ignex doctor` gains a realtime check (realtime.json present when
   a plugin uses bindings, `events` set, generated SDK import resolvable) so
   onboarding scripts catch wiring errors before a user hits a 500.

### P1 — remove the hand-wiring (optimal DX)

4. **`novaPlugin` auto-enables the events layer.** When `bindings` are
   provided (or always), default `events: {}` internally and expose
   `server.events` on the plugin's typed surface (`NovaServerHandle`). The
   "no events hub bound" error should mention `novaPlugin({ events: {} })`,
   not `createServer()`.
5. **Typed server-side events without casts.** Have `ignex sdk --platform
   realtime` emit a server-side facade (e.g. `realtime/server.ts`:
   `on/emit/emitToUser` typed against the app's events, backed by the bound
   hub), and make `ignex event bus` generate `src/lib/events.ts` from it
   instead of re-exporting the default-registry global.
6. **One command for the realtime stack.** Either fold realtime into
   `ignex event bus <name>` (scaffold contract + wire config + run sdk) or add
   `ignex realtime <name>`; and a `create --features realtime` option. The
   flow should be: one scaffold command → `ignex build` → FE consumes the
   generated package. `flatc` presence should be checked by the CLI and
   reported *before* codegen with an install hint.
7. **Local SDK consumption without publishing.** Support a local mode
   (`ignex sdk --platform realtime --local` or a `ignex sdk:link`): emits the
   SDK into a tracked location (e.g. `src/generated/realtime/`) and updates
   `tsconfig.include` automatically, so single-app monoliths never touch the
   npm-publish path. Keep the publish path for FE teams.
8. **Ports.** Default the nova port from env (`NOVA_PORT`) or derive it from
   the server port; support `port: 0` (OS-assigned) with the actual port
   logged and exposed (`novaPlugin.server.port`) so tests/dev/tools never
   clash. Document C2 (second port, no shared middleware) explicitly; longer
   term, consider serving `/ws` from the main `Bun.serve` with shared
   middleware.

### P2 — the feedback loop (stable product over time)

9. **Dogfood script + CI gate.** Add `scripts/dx-journey.ts` (under `verify:*`
   or `test:parallel`): scaffolds a temp app, runs the exact scenario above
   (create → event bus → build → sdk → publish → FE client receives), and
   **fails if any manual fix is needed** — i.e., asserts the scaffolded code
   compiles (`tsc --noEmit`) and the E2E delivery works with zero edits.
   This is the regression test for P0/P1; run it in CI (a real product
   stability gate — a framework whose scaffold doesn't compile is broken).
10. **Error-message review pass.** Every runtime error a user can hit must
    name the framework API they used and the exact fix (A1's message already
    does this modulo naming `createServer`; A2 should mention `bindings`).
11. **Cadence.** Re-run this journey at least once per release cycle (hook
    into `scripts/verify:full`), and keep the journey script's step count as
    the DX metric: **target ≤ 5 framework steps, 0 undocumented fixes** for
    the event→FE scenario (today: ~13 steps, ~6 undocumented fixes).

### Success criteria (measurable)

- Scaffolded `ignex event bus` app: `tsc --noEmit` clean + E2E delivery works
  **before any user edit** (P0).
- Event→FE journey step count from the dogfood script: **≤ 5**, no casts, no
  hand-imports into `.ignex` (P1).
- `ignex doctor` flags realtime misconfig before runtime (P0-3).
- CI runs `scripts/dx-journey.ts` and has never regressed P0 output (P2).

---

## 4. Suggested implementation order

1. P0-1/P0-2 (templates + scaffold contract) — small, mechanical, unblocks
   every user.
2. P0-3 (docs + doctor realtime check) — parallel.
3. P2-9 dogfood script against the fixed templates — locks it in.
4. P1-4/P1-5 (plugin surface + server-side facade) — the typed-emit payoff.
5. P1-6/P1-7/P1-8 (real-time command, local SDK mode, ports) — the remaining
   hand-wiring.
6. P2-10/P2-11 (error pass + cadence) — ongoing.

Evidence app: `/home/adeel/poc/ignus/.dx-eval/dx-app` (throwaway — delete
after review; the working E2E demo is there, including the generated SDK).

---

## 5. Round 2 — implemented & verified (feedback loop closed once)

### FE FlatBuffers consumption verified

A browser-like FE client consuming the generated event SDK was run against a
live BE:
- broadcast decode (plain payload) — exact;
- rich FlatBuffers decode (nested table + string vector + int64 fields) —
  exact;
- FE→BE send + per-user ack (`emitToUser` with `?token=` identity, since
  browser WebSockets cannot set headers) — delivered only to the sender.

The generated wire stack is pure JS (`DataView`/`TextDecoder`, no FFI), so it
runs in the browser. Verdict on "are events easily sent": receiving on the FE
is one call (`createRealtimeClient(url).connect()` + `on(name, cb)`); sending
from the BE was previously untyped (casts) — fixed by the generated
server-side facade (below).

### Wire/transport findings (production-grade)

- **W1 — stale wire stack silently corrupts frames.** `ignex build` bundles
  the generated SDK at compile time; running `ignex sdk` *after* a build left
  the server embedding a stale stack — observed as string fields decoding to
  `""` (no error). **Fixed**: `writeRealtimeSdk` (realtime-only codegen, no
  build artifacts needed) + `buildProject` regenerates `realtime.json` and the
  local SDK *before* compiling (`ignex build` and `ignex dev` both inherit).
- **W2 — no wire-level schema-fingerprint check.** Server and client with
  name-compatible but stale registries decode silently wrong instead of
  erroring. The fingerprint exists (`SCHEMA_FINGERPRINT`) but is only used in
  the FFI self-test. **Remaining** (lives in `@ignex/nova`, sibling repo):
  verify the fingerprint in the welcome/handshake and reject loudly.

### Fixes shipped this round

- `ignex event bus <name>` scaffolds `src/realtime.ts` (wire contract),
  `src/realtime.plugin.ts` (pre-wired `novaPlugin` with `events: {}` +
  generated `bindings` + auth placeholder), `src/lib/events.ts` (re-export of
  the generated server facade), the publish route, and a fixed consumer;
  updates the app `tsconfig` include and generates the local SDK immediately.
- `novaPlugin` enables the events layer by default and exposes
  `plugin.server.events` on the typed surface (A1 killed at the source).
- Generated SDK gains `realtime/server.ts` — typed `emit`/`emitToUser`/`on`/
  `once`/`off` against the app's events (A8 killed: no casts in user code).
- `--features sse` route template fixed (B1); scaffold `biome.json` fixed for
  Biome 2.x; `docs/cookbook.md` realtime section now teaches the working flow
  (E1); `suggest.ts` pre-existing lint fixed.

### Re-verified journey (fresh scaffold, `dx-app2`)

`create` → `ignex event bus order` → paste 2-line plugin entry →
`ignex build` → run → FE receives `order.created` decoded exactly. The app
typechecks clean (`tsc --noEmit`) with **zero casts and zero undocumented
fixes**. Step count: **5** (target was ≤ 5). Changing the contract and running
only `ignex build` regenerates the SDK (W1 fix proven).

### Remaining (next round)

- W2 wire fingerprint check (in `@ignex/nova`).
- NOVA port default from env + `port: 0` support (C1 — dev/test port clashes).
- `ignex doctor` realtime check (realtime.json/bindings/events wiring).
- CI dogfood gate (`scripts/dx-journey.ts` — P2-9) and error-message pass
  (P2-10).
