# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities. Instead,
report privately so we can fix and release before disclosure.

**Email: <adeel.asd.aa@gmail.com>** (subject prefix `[ignex-security]`), or open
a **private security advisory** on GitHub:
<https://github.com/Axylabs/ignex/security/advisories/new>.

The address above is the same contact published on the npm packages — every
published manifest carries `repository`, `homepage` and `bugs` — so the
reporting channel is reachable from the registry alone.

Include as much detail as possible:

- Affected package(s) and version(s)
- A minimal reproduction (route/plugin/hook code)
- Impact and any suggested mitigation

What to expect:

| Stage | Target |
| --- | --- |
| Acknowledgement | 3 business days |
| Initial assessment (severity, affected range, plan) | 10 business days |
| Fix for a confirmed high/critical issue in a supported minor | best effort, coordinated with the reporter |
| Public disclosure | after a fix ships, or 90 days from the report, whichever is first |

We will credit the reporter in the advisory unless asked not to. There is **no
bug bounty** — the project is pre-1.0 and unfunded, and we would rather say so
than imply a payment that does not exist.

### Safe harbour

We will not pursue or support legal action against researchers who act in good
faith: testing against their own deployment, avoiding privacy violations,
service degradation and data destruction, and giving us reasonable time to fix
before disclosure. If in doubt, ask first by email.

### Scope

In scope: everything in this repository (`@ignex/core`, `@ignex/compiler`,
`@ignex/cli`, `@ignex/native`, `@ignex/shared`, `@ignex/mcp`, `create-ignex`)
and the `castrum` addon **as consumed through `@ignex/native`**.

Out of scope: vulnerabilities in a consuming application's own route code, and
schema-less input handling — validation is opt-in, so unvalidated input is the
application's responsibility (see [Security model](#security-model)).

## Security model

`ignex` compiles user route code into a Bun server. The framework supplies the
primitives and the guards below, but it is **not** a sandbox: your handlers run
with full process privileges.

- **Input validation is opt-in.** Untrusted input should be validated with a
  schema (`TypeBox`/Standard Schema) on every affected route.
- **`ctx.set`/cookies/headers are applied verbatim.** Avoid echoing unvalidated
  user input into headers without sanitizing (header injection).
- **Path traversal** is guarded by `safeJoin` in `@ignex/core` — use `ctx.sendFile`
  rather than manual `fs` reads.
- **Native primitives** fall back to pure-TS implementations when the `castrum`
  addon is unavailable; both paths are covered by the parity test suite.

### Threat model

Assets: request/response integrity, credentials (JWT secrets, session cookies,
datastore credentials), tenant data, and process availability.

Trust boundaries and the guards that sit on them. Every module named here is
covered by a pinning test — see [docs/stability.md](docs/stability.md) §1.1.

| # | Boundary | Threats | Enforced by |
| --- | --- | --- | --- |
| 1 | Client → reverse proxy | Host-header poisoning, DNS rebinding, open redirect (`javascript:`/`data:`/protocol-relative/CR-LF forms) | `trustedHost()` (`http/trusted-host.ts`), `assertSafeRedirectTarget` (`http/redirect-guard.ts`) |
| 2 | Proxy → app server | HTTP request smuggling (CL+TE, duplicate `Content-Length`, non-chunked TE), header-flood DoS | `detectFramingConflict` (`http/framing-guard.ts`) → 400; `maxHeaderBytes` (`http/header-cap.ts`) → 431 |
| 3 | Client → handler input | Path traversal, malformed percent-encoding, cookie/query/form/WS-frame decoding, oversized bodies | `safeJoin`/`ctx.sendFile`, guarded decoders, wire-level body caps + `readBodyBounded`, plus the nightly `bun run fuzz:malformed` sweep |
| 4 | App code → runtime | Unhandled rejection killing the process; a throwing lifecycle hook demoting 404/405 into 500 | `installProcessGuards()`, `runHooks`/`finalizeFallback` guards |
| 5 | Runtime → native addon | A Rust panic unwinding across the `bun:ffi` C-ABI boundary → SIGABRT | **Open risk.** Mitigated by the bind-time parity self-test, `IGNEX_NATIVE=off` fallbacks and the v3-SIGILL loader guard; the `catch_unwind` hardening is owned by the Rust addon repo — see [docs/stability.md](docs/stability.md) §2 |
| 6 | App → datastore / cache | Credential leakage; per-replica state divergence letting one actor exhaust a shared budget | Validated env config, redacted log lines, `trustProxy`-aware rate-limit keying with an explicit warning when IP keying is unavailable, `createRedisRateLimitStore()` for cross-replica counting |
| 7 | Error path → client | Stack traces, driver objects and credentials reaching a response | `errorToResponse` (`platform/errors.ts`): a 5xx message/detail is never sent (canonical phrase + stable `code` instead), sanitized `cause` chain, fail-closed redaction |
| 8 | Dev tooling → production | Debugbar / observatory / source maps reachable in prod | Build-time elimination — `ignex build` is prod-shaped, `__IGNEX_PROD_BUILD` is baked in, `exposeErrorDetails` defaults to `false`; keep `--dev` artifacts out of production |
| 9 | Supply chain → build | Dependency compromise, leaked credentials, untraceable artifacts | `bun run scan:secrets`, OSV scan (SARIF), `bun audit --audit-level=high`, SPDX SBOM, SHA-pinned Actions + Dependabot, frozen `exports` surface |
| 10 | Context → view rendering | Stored/reflected XSS through template interpolation | HTML auto-escape ON by default in BOTH engines with the identical minijinja `AutoEscape::Html` table — native `createTemplate` (castrum ≥ 0.9.12) and the pure-TS fallback (`native/src/template.ts`); `| safe` opts a value out, `{ autoescape: false }` disables per renderer; byte-parity is the hard gate `bun run verify:native:template` |
| 11 | Browser → state-changing routes | Cross-site request forgery (token theft via subdomain, token replay across sessions) | Double-submit + HMAC (`security/csrf.ts`) NOW WITH default same-origin `Origin`/`Referer` enforcement, optional session binding (`bindSession`, HMAC(secret, sid)) and the `__Host-` cookie prefix (`hostPrefix`) — pinning tests in `csrf-origin.test.ts` |
| 12 | Credential lifecycle | Secret rotation invalidating every live token/session at once; weak secrets reaching production | Rotation rings (`SecretInput`, `security/keyring.ts`) on JWT/cookies/CSRF/session verify paths with per-entry strength gates; prod boot advisories (`lifecycle/advisories.ts`) for missing security headers / cookie sessions without CSRF; RFC 6265 cookie-name validation on write |

**Not covered by the framework.** Identity federation (OIDC/SAML) is not
implemented — the shipped auth suite is JWT (HS256/Ed25519), signed cookies and
sessions. There is no built-in audit trail, PII/retention policy, secret-manager
integration, RBAC persistence model or multi-tenancy isolation; those remain the
consuming application's responsibility today.

### Hardening checklist for deployments

1. Terminate TLS at the proxy; set `server.https: false` / `IGNEX_HTTPS=0` on
   the app (`ignex ops caddy` generates this).
2. Set `trustProxy: true` **only** behind a proxy you control that overwrites
   the `X-Forwarded-*` headers — otherwise rate limiting keys every client into
   one shared bucket.
3. Validate every route input with a schema; treat `ctx.params`, the query and
   the body as untrusted.
4. Externalize sessions, rate limits and the HTTP cache before running more than
   one replica.
5. Run `ignex build` for production (never ship `--dev` output) and keep
   `/metrics` and `/ready` behind the proxy or a token.
6. Rotate `JWT_SECRET`, session secrets and datastore credentials per
   environment; never reuse a development secret in production. Rotation is
   now zero-downtime: pass a RING (`secrets: [current, previous, ...]`) to
   `createJwt` / `createSessionManager` / `createCsrfGuard` /
   `createCookieSigner` — the first entry signs, every entry verifies — and
   drop the previous entry after your grace window (one deploy) elapses.
7. Check the boot log on first production deploy: the framework warns when it
   serves without the `security()` headers plugin or with cookie sessions and
   no CSRF guard (`IGNEX_SILENCE_ADVISORIES=1` mutes deliberate shapes).

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |

Only the **current minor** receives security fixes. This project is pre-1.0: it
releases often, and there are no backports to older minors and no long-term
support (LTS) branch yet. The full policy — release train, deprecation notice
period and the 1.0 LTS plan — lives in
[docs/release-process.md](docs/release-process.md#versioning-support--deprecation).

Because dependants declare semver ranges, upgrading within a supported minor is
usually a range bump; `CHANGELOG.md` records every breaking change.
