# @ignex/mcp

Model Context Protocol server for Ignex — agent tooling for
build / dev / route / info / openapi / doctor, plus the debugbar's
debugger tools. Exposes the same surface an AI agent (or the `ignex mcp`
CLI command) drives over stdio.

## Surface

- `createMcpServer()` / `startMcpServer()` (stdio transport) — `src/index.ts`.
- `MCP_SERVER_NAME = "ignex"`, `MCP_SERVER_VERSION` — `src/index.ts`.
- Bin entry: `bin/ignex-mcp.js`.

### Core tools (`src/server.ts`)

`build`, `route`, `info`, `list-routes`, `doctor`, `openapi`, `dev`,
`devStop` — the CLI operations an agent can drive without a shell.

### Debugger tools (`src/debugger.ts`)

`debug-summary`, `debug-requests`, `debug-request`, `debug-replay`,
`debug-events`, `debug-event-publish`, `debug-system`, `debug-clients`,
`debug-kt` — powered by the debugbar, driven by
`IGNEX_DEBUGBAR_URL` / `IGNEX_DEBUGBAR_TOKEN` (see `docs/debugbar.md`).

## Development

```sh
bun run --cwd packages/mcp test
bun run --cwd packages/mcp typecheck
```

Source-only package (`main`/`types` → `src/index.ts`); depends on
`@ignex/cli`, `@ignex/compiler`, `@ignex/native` (workspace `*`),
`@modelcontextprotocol/sdk` and `zod`.
