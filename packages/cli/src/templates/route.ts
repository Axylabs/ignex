import type { ParsedRoute } from "../utils/route.js";

/** Conventional named-export identifiers per HTTP method (`httpGet`, ...). */
const HTTP_EXPORT_NAMES: Record<string, string> = {
  get: "httpGet",
  post: "httpPost",
  put: "httpPut",
  patch: "httpPatch",
  del: "httpDelete",
  all: "httpAll",
};

/**
 * The named export identifier for a method, e.g. `httpGet`. Falls back to a
 * conventional `http<Method>` shape for unknown methods.
 */
export const httpExportName = (method: string): string =>
  HTTP_EXPORT_NAMES[method] ?? `http${method.charAt(0).toUpperCase()}${method.slice(1)}`;

export function routeFileTemplate(
  route: ParsedRoute,
  options: { schema?: boolean; named?: boolean } = {},
): string {
  const fn = route.method;
  const hasBody = route.method === "post" || route.method === "put" || route.method === "patch";
  const params = route.paramNames;
  const named = Boolean(options.named);

  const exportLine = (expr: string): string =>
    named ? `export const ${httpExportName(route.method)} = ${expr};` : `export default ${expr};`;

  if (options.schema) {
    const schemaParts: string[] = [];

    if (params.length > 0) {
      schemaParts.push(
        `  params: Type.Object({ ${params
          .map((param) => `${param}: Type.String()`)
          .join(", ")} }),`,
      );
    }

    if (hasBody) {
      schemaParts.push(`  body: Type.Object({ name: Type.String() }),`);
    }

    schemaParts.push(`  response: Type.Object({ ok: Type.Boolean() }),`);

    const usesCtx = params.length > 0 || hasBody;

    const handlerLines: string[] = [];

    if (params.length > 0) {
      handlerLines.push(`  const { ${params.join(", ")} } = ctx.params;`);
    }

    if (hasBody) {
      handlerLines.push(`  await ctx.body.json();`);
    }

    handlerLines.push(`  return ctx.json({ ok: true });`);

    const handler = usesCtx
      ? `async (ctx) => {\n${handlerLines.join("\n")}\n}`
      : `(ctx) => ctx.json({ ok: true })`;

    return `import { Type } from "typebox";
import { ${fn} } from "@ignex/core/http";

export const schema = {
${schemaParts.join("\n")}
};

${exportLine(`${fn}(${handler}, schema)`)}
`;
  }

  if (params.length > 0) {
    const json = params.map((param) => `${param}: String(${param})`).join(", ");

    return `import { ${fn} } from "@ignex/core/http";

${exportLine(`${fn}((ctx) => {
  const { ${params.join(", ")} } = ctx.params;

  return ctx.json({ ${json} });
})`)}
`;
  }

  if (hasBody) {
    return `import { ${fn} } from "@ignex/core/http";

${exportLine(`${fn}(async (ctx) => {
  const body = await ctx.body.json();

  return ctx.json({ received: body }, { status: 201 });
})`)}
`;
  }

  if (route.method === "all") {
    return `import { all } from "@ignex/core/http";

${exportLine(`all((ctx) => ctx.text("OK"))`)}
`;
  }

  return `import { ${fn} } from "@ignex/core/http";

${exportLine(`${fn}((ctx) => ctx.text("OK"))`)}
`;
}
