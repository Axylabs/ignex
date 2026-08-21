# SDK Generation & Distribution

`ignex sdk` generates a **standalone, installable SDK** from your compiled app —
a typed API client your frontend teams can `npm install` for type safety and
rapid development, with zero runtime dependencies. It can then push the SDK to
GitHub (tag + release with the tarball) and/or publish it to a (private) npm
registry.

```
app routes ── ignex build ──► manifest.json + openapi.json ── ignex sdk ──► SDK package
                                                                    │
                                                    ┌───────────────┼────────────────┐
                                                    ▼               ▼                ▼
                                              git tag sdk-vX.Y.Z  npm publish   GitHub release
                                              (+ push to origin)  (private or   (tarball asset
                                                                   public)       for download)
```

## Why

Frontend clients talking to an ignex API get:

- **Type-safe calls** — request bodies, path/query params and responses typed
  from the API's real schemas. Hovering a call shows exactly what to send.
- **Zero runtime dependencies** — the generated client is plain `fetch` ESM,
  no `@ignex/*` imports, works in browsers, Node ≥ 18 and Bun.
- **Rapid development** — route list + payload shapes are discoverable from the
  package types; the OpenAPI document ships inside the package for your own
  tooling (codegen, mocks, docs).

## Quick start

```sh
# Generate the SDK for your app (builds first, then emits the package)
ignex sdk --root packages/app --name @acme/api-sdk --version 0.1.7

# Distribute it
ignex sdk --root packages/app --push        # git tag sdk-v0.1.7 + push to origin
ignex sdk --root packages/app --publish     # npm publish (registry configurable)
ignex sdk --root packages/app --release     # GitHub release with the .tgz attached
```

Or via the repo-level npm scripts (example app layout):

```sh
bun run sdk           # build + generate + pack (no distribution)
bun run sdk:push      # + git tag sdk-v<version> and push
bun run sdk:publish   # + npm publish
bun run sdk:release   # + GitHub release with tarball
```

`--dry-run` generates everything and prints the distribution plan without
touching git/npm/GitHub.

## CLI

```
ignex sdk [options]

  --platform <ts|openapi|all>   Platforms to generate (default: typescript)
  --name <name>                 npm package name (default: <serviceName>-sdk)
  --scope <scope>               npm scope for the default name (e.g. @acme)
  --version <semver>            SDK version (default: nearest package.json version)
  --out <dir>                   SDK output dir (default: <outDir>/sdk)
  --tag-prefix <prefix>         Git tag prefix (default: sdk-v)
  --push                        Git-tag sdk-v<version> and push to origin
  --publish                     npm publish (--registry / SDK_NPM_REGISTRY)
  --registry <url>              npm registry URL for --publish (private registries)
  --access <public|restricted>  npm access level (default: public)
  --dist-tag <tag>              npm dist-tag (default: latest)
  --release                     GitHub release with the packed tarball (gh CLI or token)
  --repo <owner/repo>           GitHub repo for --release (default: origin remote)
  --token <token>               GitHub token (default: GITHUB_TOKEN / GH_TOKEN)
  --no-build                    Skip the pre-build (use existing compiled artifacts)
  --dry-run                     Generate + print the plan; distribute nothing
```

Environment variables: `SDK_NAME`, `SDK_SCOPE`, `SDK_VERSION`,
`SDK_NPM_REGISTRY`, `SDK_REPO_URL`, `GITHUB_TOKEN`/`GH_TOKEN`.

## Testing before the repo exists

If the project has no GitHub repo yet (no `origin` remote / no `--repo`), the
generated SDK still works for local testing: the CLI prints a **static install
path** and the package README carries a *"Local testing (before it is
published)"* section:

```sh
# after `ignex sdk`:
npm install /abs/path/to/outDir/sdk            # install from the package folder
npm install /abs/path/to/outDir/sdk/acme-api-sdk-0.1.7.tgz   # or from the tarball
```

Frontend devs can install straight from their device — full type safety, no
deployment needed. Once the repo exists, re-run with `--push`/`--release` (or
`--publish`) and the README switches to the GitHub/npm install command. The
GitHub release URL is derived automatically from the `origin` remote (override
with `SDK_REPO_URL`).

## Multi-platform

The generator is platform-based: every platform emits its own package from the
same generation context (routes + OpenAPI document).

| Platform | Package | Contents |
| --- | --- | --- |
| `typescript` (default) | `<serviceName>-sdk` | Zero-dep ESM typed client, `.d.ts` types, `openapi.json`, README |
| `openapi` | `<serviceName>-api-spec` | Just the versioned `openapi.json` — feed it to your own codegen |

Select several with `--platform typescript,openapi` (or `--platform all`); each
gets its own directory and a distinct package name.

### Adding a platform

Implement the `SdkPlatform` interface (`packages/compiler/src/sdk/types.ts`)
and register it in `sdkPlatforms`
(`packages/compiler/src/sdk/index.ts`):

```ts
const pythonPlatform: SdkPlatform = {
  id: "python",
  label: "Python",
  description: "Typed Python client from the OpenAPI document.",
  generate(ctx) {
    // ctx.routes, ctx.openapi, ctx.options → return SdkFile[]
  },
};
```

## What the TypeScript SDK contains

```
<outDir>/sdk/
├── package.json        # name/version/exports/types, sideEffects: false
├── README.md           # install + usage (incl. GitHub tarball install line)
├── openapi.json        # canonical OpenAPI 3.1 document
└── dist/
    ├── index.js        # entry re-exports
    ├── index.d.ts
    ├── client.js       # self-contained fetch client (zero imports)
    ├── client.d.ts     # createApiClient + SdkClientOptions + ApiClientError
    ├── routes.d.ts     # IgnexRoutes map + IgnexClient contract
    └── types.d.ts      # concrete Body_/Params_/Query_/Response_ types
```

Frontend usage:

```ts
import { createApiClient, ApiClientError } from "@acme/api-sdk";

const api = createApiClient({ baseUrl: "https://api.example.com" });

const order = await api["/api/orders"].post({   // body fully typed
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

The call shape follows the route's inputs: `params+body → (params, body, init?)`,
`params → (params, init?)`, `body → (body, init?)`, neither → `(init?)`.

## Where the types come from

The SDK is generated from the compiled artifacts (`manifest.json` per-route
usage + `openapi.json` real schemas) — the same artifacts the running server
was built from, so the SDK can't drift from the API. Body/params/query/response
types are converted from JSON Schema at generation time; a route with a TypeBox
`schema` const (schema-first) gets concrete payload types, routes without keep
`unknown` for the parts they don't document.

> **Note:** schema-first routes (`export const schema = { body: … }`) get a
> typed, sendable body in the SDK even when the handler doesn't read
> `ctx.body` — the compiled server validates the body regardless, so the SDK
> lets callers send it.

## Distribution details

### Git tag (`--push`)

Creates `sdk-v<version>` (prefix configurable via `--tag-prefix`) and pushes it
to `origin` — a permanent, fetchable marker of the exact SDK for a given API
version. Skips with a notice if the tag already exists.

### npm publish (`--publish`)

`npm publish` in the package directory, honoring your npm auth
(`NODE_AUTH_TOKEN` or npm config / `.npmrc`). Point at a **private registry**
with `--registry https://registry.yourcorp.example` (or
`SDK_NPM_REGISTRY`); scope packages with `--scope @acme` and publish them
`--access restricted`.

### GitHub release (`--release`)

Creates a GitHub release for the tag and attaches the packed `.tgz`, so
frontend clients can install straight from GitHub without npm auth:

```sh
npm install https://github.com/<owner>/<repo>/releases/download/sdk-v1.2.3/acme-api-sdk-1.2.3.tgz
```

Uses the `gh` CLI when available; otherwise falls back to the GitHub REST API
with `--token` / `GITHUB_TOKEN`. The repo defaults to the `origin` remote —
override with `--repo owner/repo`.

## Library API

The pipeline is also exposed as a library from `@ignex/compiler`
(`packages/compiler/src/sdk/`):

- `generateSdk(options)` — pure: returns the package file lists (no writes).
- `writeSdk(options)` — generate + write packages to disk.
- `packSdk(dir)` — `npm pack` the package into a `.tgz`.
- `loadSdkInputs(outDir)` — read `manifest.json` + `openapi.json` into route
  inputs (throws with a clear message when artifacts are missing).
- `tagSdkVersion`, `publishSdkToNpm`, `createSdkGithubRelease` — the
  distribution steps (all honor `dryRun`).

```ts
import { writeSdk, packSdk } from "@ignex/compiler";

const result = await writeSdk({
  outDir: "dist",                 // compiled artifacts live here
  name: "@acme/api-sdk",
  version: "1.2.3",
  platforms: ["typescript", "openapi"],
});
const tarball = packSdk(result.packages[0].dir);
```

## When to regenerate

Regenerate + redistribute whenever the API changes (new routes, schema
changes). Keep the SDK version aligned with the API version (the default
`--version` comes from the nearest `package.json`), so frontend teams can pin
`@acme/api-sdk@1.2.3` to API `1.2.3` and upgrade on their own cadence.
