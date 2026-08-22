---
name: ignex-sdk-openapi
description: Work with SDK generation and the OpenAPI pipeline — `ignex sdk`, scripts/generate-sdk.ts, scripts/generate-openapi-client.ts, the OpenAPI 3.1 spec generator, and the typed client. Use when touching SDK distribution or OpenAPI output.
---

# ignex: SDK & OpenAPI

`ignex sdk` generates a **standalone, installable SDK** from a compiled app —
a typed API client with zero runtime dependencies that frontend teams can
`npm install`, push to GitHub (tag + release), and/or publish to a (private)
npm registry. `docs/sdk.md` is the full reference.

## The pipeline

```
app routes ── ignex build ──► manifest.json + openapi.json ── ignex sdk ──► SDK package
```

- `scripts/generate-sdk.ts` — the `sdk` script (flags: `--push`, `--publish`,
  `--release` via `bun run sdk*`).
- `scripts/generate-openapi-client.ts` — `openapi:client` script.
- `packages/core/src/openapi.ts` — the OpenAPI **3.1** spec generator
  (runtime side; derive from the same route schemas as the router).
- `packages/compiler/src/sdk/` — compiler-side SDK generation support.
- `packages/shared/src/openapi/` — shared OpenAPI types/helpers.

## Conventions

- **Single source of schemas**: route DSL schemas (`@ignex/core/http`),
  the OpenAPI spec, the typed client, and validation must all derive from the
  same route definitions — keep them in sync (this is part of the AOT
  contract; `docs/architecture.md`).
- **Never hand-edit generated SDK output** — regenerate via `ignex sdk`;
  bump the SDK version through the `sdk:release` flow.
- The SDK must stay **zero-runtime-dependency** (`docs/sdk.md`).
- OpenAPI output is a compiler/runtime artifact — changes to
  `packages/core/src/openapi.ts` need regeneration of the app's
  `openapi.json` and re-running `smoke` (the smoke test exercises the spec).

## Verify

- `bun run openapi:client` regenerates the client; diff it to see spec drift.
- `bun run sdk` (or `sdk:push` / `sdk:publish` / `sdk:release` for
  distribution) — dry-run first with `--dry-run` if supported.
- `bun run smoke` after OpenAPI/router changes.
