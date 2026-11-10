# Typed client

Build once, ship an SDK: your routes become an npm-installable typed client
for frontend teams. The SDK is generated from the same artifacts the server
was built from — it cannot drift from the API.

**You'll need**: a project with a few routes (the [CRUD example](/examples/crud-api)
is ideal).

<a id="client-playground"></a>

## What the calls look like

Pick a route, see the generated call — these are the real shapes, from the
reference app's SDK:

<ClientPlayground />

## Generate the SDK

```sh
ignex sdk --name @acme/api-sdk --version 0.1.0
# builds your app, then emits the package

bun run sdk           # the scaffolded script: build + generate + pack
bun run sdk:push      # + git tag sdk-v0.1.0 and push
bun run sdk:release   # + GitHub release with the .tgz attached
```

With no repo or registry yet, the CLI prints a **static install path** —
`npm install /abs/path/to/sdk` — so frontend work starts immediately.

## Consume it

```sh
npm install @acme/api-sdk     # or from the GitHub release tarball
```

```ts
import { createApiClient, ApiClientError } from "@acme/api-sdk";

const api = createApiClient({ baseUrl: "https://api.example.com" });

// body fully typed — hover to see the payload shape from your TypeBox schema
const order = await api["/api/orders"].post({
  orderId: "ord_123",
  quantity: 2,
  totalCents: 4900,
});

// params + typed query
const page = await api["/products"].get({ query: { page: 2, pageSize: 50 } });

// every non-2xx is a typed error
try {
  await api["/auth/login"].post({ email, password });
} catch (err) {
  if (err instanceof ApiClientError && err.status === 401) {
    console.error(err.body); // the same envelope your API returns
  }
}
```

## What's inside

```
acme-api-sdk/
├── package.json      # zero runtime deps, sideEffects: false
├── openapi.json      # the canonical OpenAPI 3.1 document — for your own tooling
└── dist/
    ├── client.js     # plain fetch, ESM — browsers, Node ≥ 18, Bun
    ├── routes.d.ts   # the typed route map
    └── types.d.ts    # Body_/Params_/Query_/Response_ types
```

- **Zero dependencies** — the generated client is self-contained `fetch`.
- **Runtime-agnostic** — browsers, Node ≥ 18, and Bun.
- **OpenAPI ships inside the package** — feed it to your own codegen, mocks,
  or docs pipeline.

## Variants

| Need | Command |
| --- | --- |
| Spec only, for external codegen | `ignex sdk --platform openapi` |
| Typed realtime client (nova) | `ignex sdk --platform realtime` |
| Private npm registry | `ignex sdk --publish --registry https://registry.yourcorp.example` |
| Preview without distributing | `--dry-run` |

Defaults live in `ignex.config.ts` (`sdk: { name, platforms, hooks }`) so
CI runs one command. See the [SDK guide](../guide/sdk) for the full option
reference.

## When to regenerate

Whenever the API changes — new routes or schema edits change the generated
types. Keep SDK version = API version (the default) so frontend teams pin
`@acme/api-sdk@1.2.3` to API `1.2.3` and upgrade on their own cadence.

::: tip The in-repo client
Don't need a separate package? Every build already emits `client.ts` next
to the server — usable directly with `createClient` from `@ignex/core`.
The SDK is the same contract, packaged for people who *don't* run your
repo.
:::
