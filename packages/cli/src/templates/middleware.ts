/** Templates for the `middleware` (global hooks) scaffold feature. */

export function middlewareIndexTemplate(): string {
  return `import { requestId } from "@ignex/core";

// Global plugins run for every request. Add application-owned plugins here.
export const middleware = [
  requestId()
];
`;
}

export function middlewareReadmeTemplate(): string {
  return `# Middleware (global hooks)

The built-in \`requestId()\` plugin correlates \`ctx.requestId\`, logs, errors,
and the \`x-request-id\` response header. Pass options to customize its header,
inbound-id policy, generator, or response echoing.

For application-owned middleware, export an \`IgnexPlugin\` with \`onRequest\`,
\`onResponse\`, \`onError\`, and optional \`init\`/\`close\` lifecycle methods.
Add it to the \`middleware\` array in \`index.ts\`.

For named lifecycle stages, register \`HookFn\`s through the \`lifecycle\` export
in \`src/app.config.ts\`. A hook returns \`continueHook(ctx)\` to proceed or
\`haltHook(response)\` to short-circuit (or replace) a response.

For **per-route** hooks, scaffold a named hook with \`ignex hook <name>\` and
reference it from a route via \`export const config = { hooks: ["<name>"] }\`.
`;
}
