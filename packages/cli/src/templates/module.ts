/**
 * @fileoverview `ignex route` module templates — business logic lives in
 * `src/modules/<route>.ts`; route files stay thin HTTP layers that call the
 * module's `handle()` function.
 *
 * Framework constraint (see templates/hotroute.ts): the AOT compiler only
 * follows a route module's own exports, so the handler MUST stay inline in the
 * route file — modules export plain functions the handler calls.
 *
 * The module path mirrors the route file 1:1, so `products/[id].get` gets
 * `src/modules/products/[id].get.ts` — easy to find, one module per route.
 */

import type { ParsedRoute } from "../utils/route.js";
import { httpExportName } from "./route.js";

/** The module file path (relative to `src/`) for a parsed route. */
export const modulePathFor = (parsed: ParsedRoute): string => `modules/${parsed.file}`;

/**
 * Relative import (with `.js` extension, matching the runtime) from a route
 * file under `src/routes/` to its module under `src/modules/`. Both trees
 * share the same nesting depth, so the prefix is one `../` for the routes dir
 * plus one per nested path segment.
 */
export const moduleImportFor = (parsed: ParsedRoute): string => {
  const depth = parsed.file.split("/").length; // segments + 1 for the routes dir
  const up = "../".repeat(depth);
  return `${up}modules/${parsed.file.replace(/\.ts$/, ".js")}`;
};

/** Minimal structural request context passed to module handlers. */
const MODULE_CTX_TYPE = `interface ModuleContext {
  /** Path params, e.g. { id: "..." } for /products/:id. */
  params: Record<string, string>;
  /** Raw query string. */
  query: URLSearchParams;
  /** JSON body accessor (POST/PUT/PATCH). */
  body: { json<T = unknown>(): Promise<T> };
}`;

/** Business-logic module body for a parsed route. */
export function moduleFileTemplate(parsed: ParsedRoute): string {
  const hasBody = parsed.method === "post" || parsed.method === "put" || parsed.method === "patch";
  const params = parsed.paramNames;

  const lines: string[] = [];
  if (params.length > 0) {
    lines.push(`const { ${params.join(", ")} } = ctx.params;`);
  }
  if (hasBody) {
    lines.push("const body = await ctx.body.json();");
  }
  lines.push(
    parsed.method === "del"
      ? "return { deleted: true };"
      : params.length > 0 || hasBody
        ? `return { received: ${params.length > 0 ? `{ ${params.join(", ")} }` : "body"}, ok: true };`
        : "return { ok: true };",
  );

  return `/**
 * Business logic for ${parsed.method.toUpperCase()} ${parsed.routePath}.
 *
 * Route files are thin HTTP layers (see src/routes/${parsed.file.replace(/\.ts$/, "")}) —
 * implement the actual logic here and keep \`handle()\` as the single entry
 * point the route calls.
 */
${MODULE_CTX_TYPE}

/** Handle ${parsed.method.toUpperCase()} ${parsed.routePath}. */
export async function handle(ctx: ModuleContext) {
${lines.map((line) => `  ${line}`).join("\n")}
}
`;
}

/** Thin route file that delegates to the module's `handle()`. */
export function routeWithModuleTemplate(
  parsed: ParsedRoute,
  options: { schema?: boolean; named?: boolean } = {},
): string {
  const fn = parsed.method;
  const named = Boolean(options.named);
  const importPath = moduleImportFor(parsed);
  const hasBody = parsed.method === "post" || parsed.method === "put" || parsed.method === "patch";
  const params = parsed.paramNames;

  const exportLine = (expr: string): string =>
    named ? `export const ${httpExportName(parsed.method)} = ${expr};` : `export default ${expr};`;

  const schemaExport =
    options.schema && (params.length > 0 || hasBody)
      ? `import { Type } from "typebox";

export const schema = {
${
  params.length > 0
    ? `  params: Type.Object({ ${params.map((p) => `${p}: Type.String()`).join(", ")} }),`
    : ""
}${hasBody ? `  body: Type.Object({ name: Type.String() }),` : ""}
  response: Type.Object({ ok: Type.Boolean() }),
};

`
      : "";

  const status = hasBody ? `, { status: 201 }` : "";
  const extra = options.schema && (params.length > 0 || hasBody) ? `, schema` : "";

  return `${schemaExport}import { ${fn} } from "@ignex/core/http";
import { handle } from "${importPath}";

${exportLine(`${fn}(async (ctx) => {
  return ctx.json(await handle(ctx)${status});
})${extra}`)}
`;
}
