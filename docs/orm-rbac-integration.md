# ORM Integration + RBAC + Ed25519 JWT — Implementation Plan

**Date:** 2026-08-17 · **Status:** DONE (M1–M4 implemented + verified)

## Implementation status
- **M1 (native EdDSA)** ✅ — `rust/crypto/ed25519.rs` + EdDSA JWT in castrum (NAPI + C-ABI), `@ignex/native` wrappers/fallbacks (RFC 8032 vectors, 550 cargo tests, 10 vitest), `verify-native-ffi.ts` (74 C-ABI checks), `@ignex/core` `createEd25519Jwt`.
- **M2 (auth module)** ✅ — `security/auth-module.ts` + `plugins/auth-module.ts`: `createAuthModule`/`authModule`, Ed25519 `.env` bootstrap (`writeEnvKeys`), claim shaping (`role`/`permission`/`both`), `issueToken`/`middleware`/plugin.
- **M3 (RBAC)** ✅ — `security/rbac.ts` + `plugins/rbac.ts`: `hasRole`/`can`/`canAll`/`requireAuthenticated`/`permissionMatches`, `createRbac`, `withGuards`, `forbidden()`. Interpreted + AOT.
- **M3.5 (AOT compiler RBAC)** ✅ — compiler recognizes `withGuards(handler, guards)`; emits guard hooks (`hasRole`/`can`/`canAll`/`requireAuthenticated`) as module consts wired into the route hook chain; guarded routes never constant-hoisted; `verify:aot:rbac` gate + `compiler/test/guards.test.ts`.
- **M4 (CLI)** ✅ — `ignex model <Name> [--fields]`, `ignex resource <Name> [--auth|--rbac]` (model + pregenerated CRUD under `src/routes/api/<plural>/` + `src/db.ts` bootstrap). Templates `cli/src/templates/{model,resource}.ts`, generators, `cli/test/model-resource.test.ts`, `verify:cli:resource` gate. Field DSL: `string(format email)/integer/boolean/date/objectId/array(x)/enum(a,b)/optional?` with paren-aware splitting.

**Verification:** `bun run test` 100 files / 1106 tests green; typecheck + typecheck:cli green; `verify:aot:rbac`, `verify:cli:resource`, `verify:native:ffi` (74 checks) all pass; lint clean on all new files (only pre-existing baseline errors remain).
**Scope:** `@ignex/*` monorepo (`/home/adeel/poc/ignus`) × `@ignex/ninox` ORM × `castrum` Rust addon (`/home/adeel/poc/bun-rust-runtime-bench`)

This plan covers three interlocking features:

1. **ORM integration in the CLI** — scaffold ninox **models** and **resource route handlers** with pregenerated CRUD.
2. **An RBAC plugin** — role- **and** permission-based authorization with per-route pre-execution guards (`can("permission")` / `hasRole("role")`).
3. **Ed25519 JWT via the Rust FFI** — the auth module bootstraps Ed25519 keys into `.env` and signs/verifies JWTs through `castrum` (with byte-compatible pure-TS fallbacks, following the existing `@ignex/native` contract).

---

## 0. Background — how the pieces fit today

| Layer | What exists | What's missing for this plan |
| --- | --- | --- |
| **castrum** (`bun-rust-runtime-bench`) | NAPI addon + C-ABI (`bun:ffi`) symbols; `rust/crypto/jwt.rs` = **HS256** JWT; argon2/bcrypt/hmac/aead/csrf/cookies | Ed25519 keypair + **EdDSA** JWT (sign/verify) |
| **@ignex/native** | Wrappers + `*Fallback` pure-TS; `selection.ts` (OpName), `vendor/castrum.d.ts`, `ffi.ts` (FfiSurface); `jwtSign/jwtVerify` (HS256) | Ed25519 ops on the surface + selection |
| **@ignex/core** | `createJwt` (HS256), `jwtAuth/requireAuth/optionalAuth/bearerAuth`, `setUser/getUser` on `ctx.state`, plugin system (`onRequest/onResponse/onError/init/close`), `defineConfig/env/loadEnv`, session/csrf/ratelimit/security plugins | EdDSA JWT service; auth module w/ key bootstrap; RBAC guards |
| **@ignex/cli** | `create` (features), `route`, `build`, `dev`, `info`, `mcp`; templates `project/route/routes` | `model` / `resource` generators; `db:*` helpers; `orm`+`rbac` create features |
| **@ignex/compiler** | File-based routes; per-route hooks via `export const config = { hooks: ["require-auth"] }` (string names resolved from `hooksDir`); plugins/lifecycle merged from `app.config.ts` | (Phase 2b) parameterized guards in `config` |
| **@ignex/ninox** (`ignex-mongodb`) | `s.*` schema DSL, `defineCollection/defineCollections`, `createMongoToolkit` → `{service, migrations}`, `db.getOne/getOneOrFail/findMany/countDocuments/insertOne/insertMany/updateOne/updateMany/deleteOne/deleteMany/paginateFlexible/paginateCursor/createSchema/populate`, typed errors w/ HTTP statuses, hooks, timestamps, soft delete | Ignex-side adapters (db plugin, guards, generated CRUD) |

**Key architectural constraints discovered:**

- Auth is **HS256 today** (`security/crypto.ts` → `@ignex/native` `jwtSign/jwtVerify`). EdDSA is **additive** — keep HS256 for back-compat, add `alg: "EdDSA"`.
- `@ignex/native` uses a strict contract: **native wrapper + `*Fallback` pure-TS** must be byte-compatible and parity-tested. The Rust decision table lives in castrum (`opImpl`), consumed once at load (`selection.ts`).
- Per-route hooks today are **string names** (`config.hooks`), resolved to `HookFn`s from `hooksDir`. There is **no parameterized/arg-carrying hook** yet.
- Ninox methods are **collection-name first** and schema-typed (no `<TDoc>` at call sites); errors are a typed taxonomy (`BadRequest`/`DomainError`/`InfraError`) with `httpStatusForError` — ideal for direct route mapping.
- `aws-lc-rs` is already a castrum dependency and supports Ed25519 — no new Rust dependency tree needed for signing (its `signature` module).

---

## 1. Target architecture

```mermaid
flowchart LR
    subgraph Init [Auth module init()]
      E[".env: JWT_PRIVATE_KEY / JWT_PUBLIC_KEY"] -->|missing| FFI[castrum ed25519 keypair]
      FFI --> W[write .env idempotent]
      E --> S[EdDSA JwtService]
    end

    subgraph Login [POST /auth/login]
      L[verify credentials] --> I[issueToken user, roles, permissions]
      I --> M{mode}
      M -->|role| C1["claims { sub, roles }"]
      M -->|permission| C2["claims { sub, permissions }"]
      M -->|both| C3["claims { sub, roles, permissions }"]
    end

    subgraph Request [Protected request]
      R[Request] --> A[authModule.onRequest: verify bearer EdDSA JWT via FFI]
      A --> U["ctx.state.user = claims"]
      U --> G["guards: hasRole()/can()"]
      G -->|pass| H[handler]
      G -->|fail| F[401 / 403 JSON]
    end

    subgraph CLI [CLI scaffolding]
      M1["ignex model User"] --> MODEL["src/models/user.ts (ninox s.*)"]
      M2["ignex resource User"] --> CRUD["src/routes/api/users/* CRUD"]
      CRUD --> DB["db plugin: toolkit connect/close"]
    end
```

**Data flow for authorization (stateless, no per-request DB lookup):**
- At **token issue** time the server resolves the user's effective roles → permissions and embeds them in the JWT (optionally via a `loadRoles`/`loadPermissions` callback for DB-backed roles).
- At **request** time the RBAC plugin reads `ctx.state.user` (populated by the auth module) and checks claims — zero DB round trips for the guard path.

---

## 2. Phase 0 — Native: Ed25519 keypair + EdDSA JWT in `castrum`

### 2.1 Rust (`/home/adeel/poc/bun-rust-runtime-bench`)

**New file `rust/crypto/ed25519.rs`** — pure-Rust core (no napi types) + thin entry points, matching the `jwt.rs` style (pure core unit-testable, napi only at entry):

```rust
// aws-lc-rs::signature
pub fn generate_keypair() -> Result<(Vec<u8> /* pkcs8 private */, Vec<u8> /* spki public */)>
pub fn sign(private_pkcs8: &[u8], msg: &[u8]) -> Result<Vec<u8>>            // 64-byte sig
pub fn verify(public_spki: &[u8], msg: &[u8], sig: &[u8]) -> bool
```

**Extend `rust/crypto/jwt.rs` — EdDSA (Ed25519) JWT:**
- Reuse the existing shared assembly: `inject_and_payload_b64` / `inject_and_payload_b64_sonic`, `split_token`, `build_token`-style assembly. The only delta is the signature primitive + header.
- Header: `{"alg":"EdDSA","typ":"JWT"}` (once, via the existing `OnceLock` header pattern).
- `pub fn jwt_sign_eddsa(claims_json: &[u8], private_pkcs8: &[u8], ttl: Option<i64>, now: i64) -> Result<Vec<u8>>`
- `pub fn jwt_verify_eddsa(token: &[u8], public_spki: &[u8], now: i64) -> Result<Option<serde_json::Value>>` — constant-time sig check, `alg == "EdDSA"` allowlist, `exp/nbf/iat` checks (mirror `jwtVerify` HS256 semantics, incl. `IAT_LEEWAY`).

**NAPI entry points** (`napi_derive`, matching `jwt.rs`): `generateEd25519Keypair`, `jwtSignEdDsa`, `jwtVerifyEdDsa`.

**C-ABI symbols** in `rust/ffi.rs` (used by `bun:ffi`, ~10–20ns crossing):
- `castrum_ed25519_generate_keypair` (needed-size convention for variable output)
- `castrum_ed25519_sign` / `castrum_ed25519_verify`
- `castrum_jwt_eddsa_sign` (cstring return) / `castrum_jwt_eddsa_verify`

**Tests:** cargo unit tests in `ed25519.rs`/`jwt.rs` (RFC 8032 test vectors for Ed25519; sign→verify; tamper → verify fails; exp/nbf/iat). Add to the existing `cargo test --lib` (currently 509 pass) + clippy clean.

### 2.2 `@ignex/native` (`packages/native`)

- **`src/crypto.ts`**: `generateEd25519Keypair()` → `{ privateKey, publicKey }` (base64url); `jwtSignEdDsa(claims, privateKey, {ttlSeconds, nowSeconds})`; `jwtVerifyEdDsa(token, publicKey, {nowSeconds})`. Native-first via `nativeFor(...)`, else `*Fallback`:
  - Fallback uses Node `node:crypto`: `generateKeyPairSync("ed25519")` → PKCS#8/SPKI DER, `createSign("ed25519")`/`createVerify("ed25519")`.
- **`src/selection.ts`**: extend `OpName` with `generateEd25519Keypair`, `jwtSignEdDsa`, `jwtVerifyEdDsa`.
- **`src/vendor/castrum.d.ts`**: add the three NAPI declarations.
- **`src/ffi.ts`**: extend `FfiSurface` + raw bindings; bind-time self-test asserts FFI === NAPI for the new ops (existing pattern).
- **Tests:** `native.test.ts` parity vectors (fallback vs native sign→verify round trip; forged signature rejected; claims expiry). Extend `scripts/verify-native-ffi.ts`.

### 2.3 `@ignex/core` (`packages/core/src/security/crypto.ts`)

- `createEd25519Jwt({ privateKey, publicKey, ttlSeconds?, issuer?, audience? })` → `{ sign(claims), verify(token) }`, mirroring `createJwt`.
- Optional: `createJwt` gains `alg?: "HS256" | "EdDSA"` for one-liner migration.

---

## 3. Phase 1 — Auth module with `.env` key bootstrap

**New files: `packages/core/src/security/auth-module.ts` + `packages/core/src/plugins/auth-module.ts`** (thin `hookToPlugin` adapter, mirroring `plugins/auth.ts`).

### API sketch

```ts
interface AuthModuleOptions {
  mode: "role" | "permission" | "both";      // JWT claim shape (default "both")
  algorithm?: "EdDSA" | "HS256";             // default EdDSA
  issuer?: string; audience?: string | string[];
  ttlSeconds?: number;                       // default 3600
  /** Resolve roles for a principal at issue time (DB-backed). Optional. */
  loadRoles?: (user: AuthUser) => MaybePromise<string[]>;
  /** Resolve permissions for a principal at issue time. Optional. */
  loadPermissions?: (user: AuthUser) => MaybePromise<string[]>;
  /** role → permissions map for mode "permission"/"both" expansion. */
  rolePermissions?: Record<string, string[]>;
  secret?: string;                           // only for algorithm HS256
  env?: { privateKey?: string; publicKey?: string }; // key names in .env
}

const auth = createAuthModule(options);      // returns an IgnexPlugin
const rbac = createRbac(options);            // Phase 2
```

### Behavior

1. **`init()`** (idempotent, safe):
   - `loadEnv()` (existing `@ignex/core` helper) → read `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` from env.
   - If missing → `generateEd25519Keypair()` via `@ignex/native` FFI (fallback pure-TS) → append `JWT_PRIVATE_KEY=…` and `JWT_PUBLIC_KEY=…` to `.env` (new tiny dotenv-writer util, never overwrites existing vars; warn + continue if `.env` is unwritable). Also sets `process.env` so the running process uses them.
   - Constructs the EdDSA `JwtService` bound to the keys.
2. **`issueToken(user, { roles?, permissions? })`** — embeds claims by mode:
   - `role` → `{ sub, roles }`
   - `permission` → `{ sub, permissions }` where `permissions = union(direct, rolePermissions[role]...)`
   - `both` → `{ sub, roles, permissions }`
   - Uses `loadRoles`/`loadPermissions` when provided.
3. **`onRequest`** — optional: verify `Authorization: Bearer` EdDSA JWT (native FFI), `setUser(ctx, claims)`. Expose both `authGuard` (require) and `optionalAuth` variants. Composability note: the module only resolves the user; **guards are Phase 2**.

### Wiring

- Interpreted: `createApp({ plugins: [auth] })`.
- AOT: `app.config.ts` → `export const plugins = [authModule({ mode: "both" })]`.
- Export `createAuthModule` from `@ignex/core` barrel (`security` + `plugins`).

---

## 4. Phase 2 — RBAC plugin

**New files: `packages/core/src/security/rbac.ts` (logic) + `packages/core/src/plugins/rbac.ts` (plugin adapter).**

### 4.1 Guard primitives (return `HookFn`s, matching the existing hook engine)

```ts
type Guard = "role" | "permission";
interface GuardOptions {
  mode?: "role" | "permission" | "both";   // which claims to trust
  loadUser?: (ctx) => MaybePromise<AuthUser | null>; // override; default reads ctx.state.user
}

/** Require the authenticated user to hold ANY of the given roles. */
hasRole(...roles: string[]): HookFn
/** Require the authenticated user to hold ALL/ANY of the given permissions. */
can(...permissions: string[]): HookFn            // any-of semantics; see `canAll`
canAll(...permissions: string[]): HookFn          // all-of
/** Require the route to be public-or-authenticated then apply guards. */
optionalGuard(...guards): HookFn
```

- Semantics:
  - **No user** on `ctx.state` → `haltHook(unauthorized())` (401, `WWW-Authenticate: Bearer`).
  - **User present but lacks role/permission** → `haltHook(forbidden())` (403 JSON `{ error: "Forbidden" }`).
- Permission matching supports:
  - exact `products:write`
  - wildcard `*` (matches anything) and `products:*` (namespace wildcard)
  - optional `mode`-aware resolution (claims already carry roles/permissions from Phase 1).

### 4.2 Plugin

```ts
const rbac = createRbac({ mode, loadUser? });
```
- `onRequest`: normalize `ctx.state.user` claims onto `ctx.state` (`roles`, `permissions`) so guards + handlers share one source of truth. Runs **after** the auth module in onion order (auth registered first).
- Exposes `authorize({ roles?, permissions? })` convenience.

### 4.3 Per-route guard ergonomics (two paths)

**Primary — runtime wrapper (works in interpreted + AOT, NO compiler change):**

```ts
// src/routes/api/products/index.post.ts
import { withGuards } from "@ignex/core";
import { post } from "@ignex/core/http";

export default withGuards(
  post(async (ctx) => { /* create product */ }),
  { roles: ["admin"], permissions: ["products:write"] },   // any-of within each group
);
```
`withGuards(handler, { roles?, permissions?, mode? })` returns a new handler that runs the guard chain (as `beforeHandle` hooks) before invoking the inner handler. Because it is a plain handler wrapper it flows through both the interpreted router and the AOT compiler (the compiler analyzes it as a handler; note: response-schema AOT optimization still applies to the inner handler).

Also exported: `requireAuth(handler)` alias of `withGuards(handler, {})` for the common "authenticated only" case.

**Follow-up (Phase 2b) — compiler-native guards** (keeps AOT constant-hoisting happy for guarded routes):

```ts
export const config = {
  hooks: ["require-auth"],
  guards: [{ can: "products:write" }, { hasRole: "admin" }],
};
```
- Compiler change: extend hook resolution (`phases/analysis`, `phases/codegen/routes/handler.ts` emit) to accept `{ can: arg }` / `{ hasRole: arg }` entries, imported from `@ignex/core`, emitting the guard chain in the route prelude (mirrors the existing `require-auth` hook emission). Marked separately so Phase 2 ships without touching the compiler.

### 4.4 Error taxonomy

- Reuse `unauthorized()` (401) from `security/auth.ts`.
- Add `forbidden()` (403) helper to `security/auth.ts` (or `rbac.ts`).

---

## 5. Phase 3 — CLI scaffolding for models + resource CRUD (ninox)

### 5.1 New commands (`packages/cli/src/commands/` + `registry.ts`)

| Command | What it does |
| --- | --- |
| `ignex model <Name> [--fields name:string,age:integer,...]` | Scaffold `src/models/<name>.ts` (ninox `s.*` DSL + `defineCollection` + `InferDoc`); interactive field prompts when `--fields` omitted |
| `ignex resource <Name> [--fields ...] [--rbac] [--auth] [--scopes products]` | `model` + full CRUD route set under `src/routes/api/<name>/` + optional guard pre-wiring |
| `ignex db:init` / `db:sync` / `db:migrate` | Boot toolkit, provision validators/indexes (`service.makeConnections()` + `db.createSchema`), run ninox migrations (`toolkit.migrations.up()`) |
| `ignex auth:keys` | (Re)generate the Ed25519 keypair into `.env` (wraps Phase 1 bootstrap; useful standalone) |

### 5.2 Generated model (`src/models/user.ts`)

```ts
import { defineCollection, s, type InferDoc } from "@ignex/ninox";

export const userSchema = s.object(
  {
    _id: s.objectId(),
    email: s.string({ format: "email" }),
    name: s.string().optional(),
    role: s.enum(["admin", "editor", "viewer"] as const),
    createdAt: s.date(),
  },
  { name: "users" },
);
export type User = InferDoc<typeof userSchema>;

export const users = defineCollection("users", userSchema, {
  indexes: [{ key: { email: 1 }, options: { unique: true } }],
});
```

### 5.3 Generated resource CRUD (`src/routes/api/users/*`)

| File | Method | Ninox call | Notes |
| --- | --- | --- | --- |
| `index.get.ts` | GET `/api/users` | `db.query("users").where(filter).page(page, limit)` → `paginateFlexible` | query filters from `ctx.query` |
| `[id].get.ts` | GET `/api/users/:id` | `db.getOneOrFail("users", { _id })` | 404 via `DomainError NOT_FOUND` |
| `index.post.ts` | POST `/api/users` | `db.insertOne("users", body)` | 201, validation via route schema |
| `[id].patch.ts` | PATCH `/api/users/:id` | `db.updateOne("users", { _id }, body)` | |
| `[id].del.ts` | DELETE `/api/users/:id` | `db.deleteOne("users", { _id })` | |

Each generated route:
- Imports the model (for `InferDoc` typing) and a shared `db` accessor.
- Uses `@ignex/core/http` method helpers + TypeBox/ninox-derived route schemas (params/query/body/response).
- Maps ninox errors to HTTP: `try { … } catch (e) { return ctx.json(errorToResponse(e), { status: httpStatusForError(e) }) }` (or a small `handleDbError` helper).
- With `--rbac`/`--auth`: wraps with `withGuards(..., { permissions: ["<resource>:read|write"] })` / `config.hooks = ["require-auth"]`; the `:read`/`:write` convention is auto-derived from the resource name unless `--scopes` overrides.

### 5.4 DB bootstrap (generated once per project)

- `src/db.ts` — `createMongoToolkit({ primary: { name, collections: defineCollections(users, …) } }, { cacheWatch: true })` singleton.
- `src/plugins/db.ts` — an `IgnexPlugin` (`init`: `makeConnections()` + `createSchema` for each collection; `close`: `closeConnections()`), registered in `app.config.ts` plugins. (Core could ship a generic `dbPlugin(ninoxToolkit)` helper — see Open Questions.)

### 5.5 CLI internals

- New `packages/cli/src/generators/{model,resource,db,auth-keys}.ts` + `templates/{model,resource,crud,db}.ts` (reuse `prompt.ts`, `fs.ts`, `logger.ts`, `parseRouteInput`).
- Field-DSL parser: `name:string, age:integer(min 0), role:enum(admin,editor)` → ninox `s.*` calls.
- Register commands in `commands/registry.ts`; add `model`/`resource`/`db:*`/`auth:keys` to `FEATURE_NAMES`? (No — those are **commands**, not `create` features; instead add `orm` and `rbac` as `create` features.)
- **`ignex create --features orm,rbac`**: scaffolds ninox dep (`@ignex/ninox`, `mongodb`), `src/db.ts`, the db plugin, the auth module + rbac plugin wiring in `app.config.ts`, `.env` placeholders, and an example `src/models/user.ts` + `/api/users` CRUD.
- **MCP parity**: expose `model`/`resource` as `ignex-mcp` tools (mirror existing `route` tool in `tools.ts`/`server.ts`).

---

## 6. Phase 4 — Tests, verification, docs

| Area | Tests |
| --- | --- |
| Native parity | `native.test.ts` ed25519 vectors; `verify-native-ffi.ts` additions (FFI === NAPI === Fallback) |
| Rust | cargo unit tests (RFC 8032 vectors, EdDSA JWT round trip, tamper, expiry) |
| Auth module | env bootstrap (tmp dir `.env` write, idempotency, no-overwrite); claim shape per mode (`role`/`permission`/`both`); role→permission expansion; `loadRoles/loadPermissions` |
| RBAC | `can`/`hasRole`/`canAll` unit (401 vs 403, wildcards, namespaces); `withGuards` wrapper; onion ordering auth→rbac; `forbidden()` shape |
| CLI | `model`/`resource` scaffold output + idempotency (`--force`); generated routes **compile** (fixture build via `@ignex/compiler`); `db:sync` dry-run |
| E2E smoke | seed user w/ roles+permissions → `POST /auth/login` → EdDSA JWT → hit guarded routes (200/401/403) |

**Docs:** `docs/architecture.md`, `docs/native-acceleration.md` (new FFI ops), a new `docs/rbac.md`, `docs/adding-a-feature.md` (generator pattern), README.

---

## 7. File-by-file change list

### castrum (`/home/adeel/poc/bun-rust-runtime-bench`)
- `rust/crypto/ed25519.rs` — **new** (keypair/sign/verify, pure-Rust + napi entries)
- `rust/crypto/jwt.rs` — EdDSA sign/verify, shared assembly reuse
- `rust/crypto/mod.rs` — `pub mod ed25519`
- `rust/ffi.rs` — 5 new C-ABI symbols + needed-size convention
- `rust/lib.rs` — register exports
- `src/native/ffi.ts` / `src/index.d.ts` (castrum's own surface) — new bindings

### @ignex/native (`packages/native`)
- `src/crypto.ts` — `generateEd25519Keypair`, `jwtSignEdDsa`, `jwtVerifyEdDsa` + fallbacks
- `src/selection.ts` — OpName additions
- `src/vendor/castrum.d.ts` — 3 declarations
- `src/ffi.ts` — FfiSurface + raw bindings + self-test
- `src/index.ts` — re-exports
- `test/native.test.ts` — parity

### @ignex/core (`packages/core`)
- `src/security/crypto.ts` — `createEd25519Jwt`, optional `createJwt alg`
- `src/security/auth-module.ts` — **new** (`createAuthModule`, env bootstrap, `issueToken`)
- `src/security/rbac.ts` — **new** (`hasRole`, `can`, `canAll`, `forbidden`)
- `src/plugins/auth-module.ts` — **new** (plugin adapter)
- `src/plugins/rbac.ts` — **new** (`createRbac`, `withGuards`)
- `src/security/auth.ts` — add `forbidden()`
- `src/index.ts` — barrel exports
- `test/` — auth-module, rbac, crypto ed25519
- `src/platform/env.ts` — small dotenv-writer util (`writeEnvKeys`)

### @ignex/compiler (`packages/compiler`) — Phase 2b only
- `src/ir/*`, `src/phases/analysis/*`, `src/phases/codegen/routes/handler.ts` — `config.guards` support + hook prelude emission
- `src/types.ts` — route `config` shape

### @ignex/cli (`packages/cli`)
- `src/commands/{model,resource,db,auth-keys}.ts` — **new**
- `src/commands/registry.ts` — register
- `src/generators/{model,resource,db,auth-keys}.ts` — **new**
- `src/templates/{model,resource,crud,db}.ts` — **new**
- `src/templates/project.ts` / `routes.ts` — `orm`/`rbac` create features
- `src/types.ts` — `FEATURE_NAMES` += `orm`, `rbac`

### @ignex/mcp (`packages/mcp`)
- `src/tools.ts` / `src/server.ts` — `model`/`resource`/`auth:keys` tools

---

## 8. Sequencing / milestones

1. **M1 (native core):** castrum ed25519 + EdDSA JWT (Rust + C-ABI + NAPI), `@ignex/native` wrappers + fallback, parity tests. *Independent; unblocks everything.*
2. **M2 (auth module):** `createAuthModule` with `.env` bootstrap + EdDSA `JwtService` + claim shaping. Core tests.
3. **M3 (RBAC):** `hasRole`/`can`/`canAll`, `createRbac`, `withGuards`, `forbidden()`; core tests + e2e smoke.
4. **M4 (CLI):** `model`/`resource`/`db:*`/`auth:keys` commands + templates + create features + MCP parity; scaffold→compile tests.
5. **M5 (follow-ups):** compiler-native `config.guards`; docs; bench of EdDSA FFI sign/verify vs HS256 (add to `scripts/select-native.ts` / `bench-native-route.ts` methodology).

Each milestone is independently shippable; M1–M3 are prerequisite for M4's `--auth`/`--rbac` flags but not for plain model/resource CRUD.

---

## 9. Open questions (confirm before coding)

1. **Ed25519 key format in `.env`** — propose PKCS#8 DER (private) + SPKI DER (public), base64, matching Node `crypto` (so the pure-TS fallback and any non-Bun consumer interoperate). Alternative: raw 32-byte seed + 32-byte public. *Default: PKCS#8/SPKI base64.*
2. **Permission naming convention** — `resource:action` (`users:read`, `users:write`) with `*` and `resource:*` wildcards. OK?
3. **Guard ergonomics default** — `withGuards(handler, {...})` runtime wrapper as the primary path (ships in M3, no compiler change), `config.guards` as M5. OK?
4. **Role/permission sources** — embedded in the JWT at issue time (stateless, recommended) with optional `loadRoles`/`loadPermissions` callbacks for DB-backed roles. OK?
5. **`both` mode** — include roles + permissions in one token (enables `hasRole` and `can` together). Include by default?
6. **Default `.env` var names** — `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (+ `JWT_ALG=EdDSA`). Confirm.
7. **DB plugin location** — ship a generic `dbPlugin(toolkit)` helper in `@ignex/core` (requires ninox as an optional peer) vs. generate a project-local `src/plugins/db.ts`. *Default: project-local (keeps core decoupled from ninox).*

---

## 10. Risks & mitigations

- **FFI round-trip cost** — per prior findings (`per-route-native-stack.md`), string round trips lose to Bun built-ins. EdDSA sign (~µs of Rust work) is expensive enough that the FFI win holds, but **bench first** (M1) before promoting to `FFI_WINS`; keep NAPI/pure-TS fallbacks byte-identical.
- **`.env` write races / idempotency** — auth module key bootstrap must be atomic (write temp + rename) and never overwrite existing keys; document manual rotation flow (`ignex auth:keys --rotate`).
- **Compiler + guarded handlers** — `withGuards` wrapping may reduce AOT constant-hoisting for those routes; mitigation is M5 compiler-native `config.guards`.
- **Ninox coupling** — core stays ORM-agnostic; all ninox specifics live in generated project code + CLI templates, so `@ignex/core` never depends on `@ignex/ninox`.
