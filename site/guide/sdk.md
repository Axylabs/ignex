# Typed SDK generation

Every `ignex build` emits an OpenAPI document and a typed client. `ignex
sdk` goes further: it turns your routes into a **standalone, installable
npm package** — a zero-dependency typed client your frontend teams can
`npm install` for full type safety, generated from the same artifacts the
running server was built from. **The SDK can't drift from the API.**

```
app routes ── ignex build ──► manifest.json + openapi.json ── ignex sdk ──► SDK package
                                                                      │
                                                      ┌───────────────┼────────────────┐
                                                      ▼               ▼                ▼
                                                git tag sdk-vX.Y.Z  npm publish   GitHub release
```

## Generate it

```sh
ignex sdk --root . --name @acme/api-sdk --version 0.1.0
```

Or from the repo-level scripts the scaffold provides:

```sh
bun run sdk           # build + generate + pack (no distribution)
bun run sdk:push      # + git tag sdk-v<version> and push
bun run sdk:publish   # + npm publish (private registries supported)
bun run sdk:release   # + GitHub release with the .tgz attached
```

Add `--dry-run` to generate everything and print the distribution plan
without touching git/npm/GitHub.

## Use it

```ts
import { createApiClient, ApiClientError } from "@acme/api-sdk";

const api = createApiClient({ baseUrl: "https://api.example.com" });

const order = await api["/api/orders"].post({
  // body fully typed
  orderId: "ord_123",
  quantity: 2,
  totalCents: 4900,
});

const report = await api["/api/reports/:id"].get({ id: "42" });

try {
  await api["/auth/login"].post({ email, password });
} catch (err) {
  if (err instanceof ApiClientError && err.status === 401) {
    console.error(err.body);
  }
}
```

The call shape follows the route's declared inputs —
`params+body → (params, body, init?)`, `params → (params, init?)`, and so
on. Request and response types are inferred from the route schemas at
generation time; hovering a call shows exactly what to send.

<ClientPlayground />

## What's inside the package

```
acme-api-sdk/
├── package.json        # name/version/exports/types, sideEffects: false
├── README.md           # install + usage
├── openapi.json        # canonical OpenAPI 3.1 document (for your own tooling)
└── dist/
    ├── client.js       # self-contained fetch client — zero imports
    ├── routes.d.ts     # the IgnexRoutes map + client contract
    └── types.d.ts      # concrete Body_/Params_/Query_/Response_ types
```

**Zero runtime dependencies** — plain `fetch` ESM, no `@ignex/*` imports.
Runs in browsers, Node ≥ 18, and Bun.

## Platforms

One generator, multiple packages from the same routes:

| Platform | Package | Contents |
| --- | --- | --- |
| `typescript` (default) | `<name>-sdk` | The typed client + types + openapi.json |
| `openapi` | `<name>-api-spec` | Just the versioned `openapi.json` — feed your own codegen |
| `realtime` | `<name>-realtime-client` | Typed nova client from the realtime contract |

```sh
ignex sdk --platform typescript,openapi,realtime
```

Custom platforms and pure transform hooks (`transformPackageJson`,
`transformFiles`) are supported via `ignex.config.ts`:

```ts
import { defineConfig } from "@ignex/cli/config";

export default defineConfig({
  sdk: {
    name: "@acme/api-sdk",
    platforms: ["typescript", "openapi"],
    hooks: {
      transformPackageJson(pkg, ctx) {
        return { ...pkg, keywords: [ctx.serviceName, ctx.platform] };
      },
    },
  },
});
```

## Distribution models

- **Git tag** (`--push`) — tags `sdk-v<version>` and pushes: a permanent,
  fetchable marker of the SDK for an API version.
- **npm** (`--publish`) — honors your npm auth; private registries via
  `--registry https://registry.yourcorp.example`.
- **GitHub release** (`--release`) — attaches the packed `.tgz`, so
  frontend clients install straight from GitHub with no npm auth:
  ```sh
  npm install https://github.com/acme/api/releases/download/sdk-v1.2.3/acme-api-sdk-1.2.3.tgz
  ```

No repo yet? The CLI prints a **static install path** —
`npm install /abs/path/to/sdk` — so frontend devs can start today and
re-distribute later without changes.

## When to regenerate

Whenever the API changes. Keep the SDK version aligned with the API
version (the default `--version` comes from your `package.json`), so
frontend teams can pin `@acme/api-sdk@1.2.3` to API `1.2.3` and upgrade on
their own cadence.
