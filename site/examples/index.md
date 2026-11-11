# Examples

Complete mini-apps, each one a handful of files you can copy into a real
project.
(New here? The [toolchain tour](../guide/tour) shows how the CLI and the
debugbar produce these flows in the first place.) Every snippet is verified against the current API — most of them
mirror what the [reference app](https://github.com/Axylabs/ignex/tree/main/packages/app/src/routes)
and the scaffold generate.

<div class="ignex-strip" style="margin: 20px 0;">

<div class="ignex-strip-item">**[Hello, world](/examples/hello-world)**<br/>The smallest possible API — one file, one route, then a params + schema upgrade. <em>Start here.</em></div>

<div class="ignex-strip-item">**[CRUD API](/examples/crud-api)**<br/>List / detail / create / update / delete with validation, pagination, and typed errors.</div>

<div class="ignex-strip-item">**[Auth API](/examples/auth-api)**<br/>Register, login, me — tokens, a guard hook, and role checks with <code>ignex add auth</code>.</div>

<div class="ignex-strip-item">**[Realtime chat](/examples/realtime-chat)**<br/>SSE stream plus a nova typed chat bus with per-user delivery.</div>

<div class="ignex-strip-item">**[File upload](/examples/file-upload)**<br/>Multipart upload with safe-name sanitization and a static download route.</div>

<div class="ignex-strip-item">**[Typed client](/examples/typed-client)**<br/>Generate an SDK from your routes and consume it with full type safety.</div>

</div>

## Set up once, try them all

```sh
bun create ignex my-api --features auth,openapi,examples
cd my-api
bash setup.sh      # installs Bun if missing, provisions everything
bun run dev
```

Each example page tells you which files to create under `src/routes/` — the
dev server picks up every change and recompiles automatically.

<a id="api-explorer"></a>

## API explorer

Curious what a full example app's generated API looks like? This is the
**real OpenAPI document from the reference app** — expand an endpoint to
see its parameters, request body, and responses, all derived from TypeBox
schemas at build time:

<ApiExplorer />
