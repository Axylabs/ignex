/**
 * Resource CRUD route templates (`ignex resource <Name>`).
 *
 * Generates a REST resource under `src/routes/api/<plural>/` wired to the
 * ninox `db` manager (see `src/db.ts`), with optional auth/RBAC guards:
 *   - `--auth`  → `config.hooks = ["require-auth"]` (AOT named hook)
 *   - `--rbac`  → `withGuards(handler, { permissions: ["<plural>:read|write"] })`
 *                (compiler emits the guard chain)
 */

import { type ModelField, pascalCase, pluralize } from "./model";

/** The route file name for a method of the resource. */
export const resourceRoutePath = (plural: string, kind: ResourceKind): string => {
  switch (kind) {
    case "list":
      return `${plural}/index.get.ts`;
    case "getOne":
      return `${plural}/[id].get.ts`;
    case "create":
      return `${plural}/index.post.ts`;
    case "update":
      return `${plural}/[id].patch.ts`;
    case "delete":
      return `${plural}/[id].del.ts`;
  }
};

export type ResourceKind = "list" | "getOne" | "create" | "update" | "delete";

/** Header lines (config + guards) for a generated route. */
const guardsPrelude = (
  plural: string,
  kind: ResourceKind,
  opts: { auth?: boolean; rbac?: boolean },
): { imports: string[]; config: string[]; wrapper: string } => {
  const imports: string[] = [];
  const config: string[] = [];
  const action = kind === "list" || kind === "getOne" ? "read" : "write";

  if (opts.auth) {
    config.push('export const config = { hooks: ["require-auth"] };');
  }
  if (opts.rbac) {
    imports.push('import { withGuards } from "@ignex/core";');
  }
  const wrapper = opts.rbac
    ? `withGuards(handler, { permissions: ["${plural}:${action}"] })`
    : "handler";

  return { imports, config, wrapper };
};

/** The relative import path from `src/routes/api/<plural>/` to `src/db.ts`. */
const DB_IMPORT = "../../../db.js";

const LIST_HANDLER = `const handler = get(async (ctx) => {
  const page = Math.max(1, Number(ctx.query.get("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, Number(ctx.query.get("limit") ?? "20")));
  const result = await db.paginateFlexible("__PLURAL__", {}, { page, limit, sort: { createdAt: -1 } });
  return ctx.json(result);
});`;

/** Render one CRUD route file for the resource. */
export const resourceRouteTemplate = (
  name: string,
  kind: ResourceKind,
  opts: { auth?: boolean; rbac?: boolean },
): string => {
  const plural = pluralize(name);
  const Type = pascalCase(name);
  const { imports, config, wrapper } = guardsPrelude(plural, kind, opts);

  const parts: string[] = [];
  parts.push(imports.join("\n"));
  parts.push('import { get, post, patch, del } from "@ignex/core/http";');
  parts.push(`import { db } from "${DB_IMPORT}";`);
  parts.push("");
  parts.push(...config);

  let handler: string;
  switch (kind) {
    case "list":
      handler = LIST_HANDLER.replaceAll("__PLURAL__", plural);
      break;
    case "getOne":
      handler = `const handler = get(async (ctx) => {
  const { ObjectId } = await import("mongodb");
  const id = ctx.params.id;
  try {
    const doc = await db.getOneOrFail("${plural}", { _id: new ObjectId(id) });
    return ctx.json(doc);
  } catch {
    return ctx.json({ error: "Not Found" }, { status: 404 });
  }
});`;
      break;
    case "create":
      handler = `const handler = post(async (ctx) => {
  const body = await ctx.body.json<Partial<${Type}>>();
  const { insertedId } = await db.insertOne("${plural}", body as any);
  return ctx.json({ id: insertedId }, { status: 201 });
});`;
      break;
    case "update":
      handler = `const handler = patch(async (ctx) => {
  const { ObjectId } = await import("mongodb");
  const id = ctx.params.id;
  const body = await ctx.body.json<Partial<${Type}>>();
  const result = await db.updateOne("${plural}", { _id: new ObjectId(id) }, body as any);
  return result.modifiedCount > 0
    ? ctx.json({ updated: true })
    : ctx.json({ error: "Not Found" }, { status: 404 });
});`;
      break;
    case "delete":
      handler = `const handler = del(async (ctx) => {
  const { ObjectId } = await import("mongodb");
  const id = ctx.params.id;
  const result = await db.deleteOne("${plural}", { _id: new ObjectId(id) });
  return result.deletedCount > 0
    ? ctx.json({ deleted: true })
    : ctx.json({ error: "Not Found" }, { status: 404 });
});`;
      break;
  }

  parts.push(handler);
  parts.push("");
  parts.push(`export default ${wrapper};`);
  return parts.filter(Boolean).join("\n");
};

/** Render all CRUD route files for a resource. */
export const resourceRouteTemplates = (
  name: string,
  opts: { auth?: boolean; rbac?: boolean },
): Array<{ path: string; content: string }> => {
  const plural = pluralize(name);
  const kinds: ResourceKind[] = ["list", "getOne", "create", "update", "delete"];
  return kinds.map((kind) => ({
    path: resourceRoutePath(plural, kind),
    content: resourceRouteTemplate(name, kind, opts),
  }));
};

/** A README describing the generated resource (optional). */
export const resourceReadmeTemplate = (name: string): string => {
  const plural = pluralize(name);
  const Type = pascalCase(name);
  return `# ${Type} resource

Generated by \`ignex resource ${name}\`. CRUD routes under \`/api/${plural}\`:

- \`GET    /api/${plural}\`        — list (paginateFlexible, \`page\`/\`limit\` query)
- \`GET    /api/${plural}/:id\`    — read one (getOneOrFail)
- \`POST   /api/${plural}\`        — create (insertOne)
- \`PATCH  /api/${plural}/:id\`    — update (updateOne)
- \`DELETE /api/${plural}/:id\`    — delete (deleteOne)

Edit \`src/models/${plural}.ts\` to change the schema, then run:
\`\`\`sh
bunx ignex db:sync
\`\`\`
`;
};

export type { ModelField };
