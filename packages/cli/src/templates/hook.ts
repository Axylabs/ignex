/** Templates for `ignex hook <name>` (named per-route hooks + global hooks). */

export function namedHookTemplate(name: string): string {
  return `import { continueHook, type HookFn } from "@ignex/core";

// Named hook "${name}" — reference it from a route via:
//   export const config = { hooks: ["${name}"] };
// Return \`continueHook(ctx)\` to proceed or \`haltHook(response)\` to halt.
export default ((ctx) => {
  return continueHook(ctx);
}) as HookFn;
`;
}

export function globalHookTemplate(name: string): string {
  return `import { continueHook, type HookFn } from "@ignex/core";

// Global lifecycle hook "${name}" — registered on the \`beforeHandle\` stage
// in src/app.config.ts via:
//   export const lifecycle = { beforeHandle: [${name}] };
// Runs on every request before the handler. Return \`haltHook(response)\` to
// short-circuit the request.
export const ${name} = ((ctx) => {
  return continueHook(ctx);
}) as HookFn;
`;
}
