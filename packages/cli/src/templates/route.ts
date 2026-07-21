import type { ParsedRoute } from "../utils/route.js";

export function routeFileTemplate(
  route: ParsedRoute,
  options: { schema?: boolean } = {},
): string {
  const fn = route.method;
  const hasBody = route.method === "post" || route.method === "put" || route.method === "patch";
  const params = route.paramNames;

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

    handlerLines.push(`  return Response.json({ ok: true });`);

    const handler = usesCtx
      ? `async (ctx) => {\n${handlerLines.join("\n")}\n}`
      : `() => Response.json({ ok: true })`;

    return `import { Type } from "@sinclair/typebox";
import { ${fn} } from "@flux/core/http";

export const schema = {
${schemaParts.join("\n")}
};

export default ${fn}(${handler}, schema);
`;
  }

  if (params.length > 0) {
    const json = params.map((param) => `${param}: String(${param})`).join(", ");

    return `import { ${fn} } from "@flux/core/http";

export default ${fn}((ctx) => {
  const { ${params.join(", ")} } = ctx.params;

  return Response.json({ ${json} });
});
`;
  }

  if (hasBody) {
    return `import { ${fn} } from "@flux/core/http";

export default ${fn}(async (ctx) => {
  const body = await ctx.body.json();

  return Response.json({ received: body }, { status: 201 });
});
`;
  }

  if (route.method === "all") {
    return `import { all } from "@flux/core/http";

export default all(() => new Response("OK"));
`;
  }

  return `import { ${fn} } from "@flux/core/http";

export default ${fn}(() => new Response("OK"));
`;
}