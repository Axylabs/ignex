/**
 * Drizzle CRUD route templates — the `--db sql` resource routes.
 *
 * Same route contract as the ninox path (list/getOne/create/update/delete)
 * but backed by drizzle queries over the generated sqlite table:
 *
 *   GET    /api/<plural>        → db.select().from(table)
 *   GET    /api/<plural>/:id    → db.select().from(table).where(eq(id))
 *   POST   /api/<plural>        → db.insert(table).values(...)
 *   PATCH  /api/<plural>/:id    → db.update(table).set(...).where(...)
 *   DELETE /api/<plural>/:id    → db.delete(table).where(...)
 *
 * The routes validate with TypeBox (same as the Mongo path) and treat the
 * `:id` as a numeric primary key (SQLite autoincrement).
 */
import { pluralize } from "./model.js";

/** HTTP method for each resource kind (matches the ninox resource path). */
const METHOD: Record<string, string> = {
  list: "get",
  getOne: "get",
  create: "post",
  update: "patch",
  delete: "del",
};

/** File path for a drizzle resource route. */
export const drizzleRoutePath = (plural: string, kind: string): string => {
  switch (kind) {
    case "list":
      return `api/${plural}/index.get.ts`;
    case "getOne":
      return `api/${plural}/[id].get.ts`;
    case "create":
      return `api/${plural}/index.post.ts`;
    case "update":
      return `api/${plural}/[id].patch.ts`;
    case "delete":
      return `api/${plural}/[id].del.ts`;
  }
  return `api/${plural}/index.get.ts`;
};

/** Body-schema snippet for create/update (validated, not persisted raw). */
const bodySchema = (fields: string[]): string =>
  fields.length > 0
    ? fields.map((f) => `    ${f}: Type.Optional(Type.Unknown()),`).join("\n")
    : "    // add fields via --fields";

/**
 * Render one drizzle CRUD route.
 *
 * @param name   PascalCase model name (e.g. User)
 * @param kind   list | getOne | create | update | delete
 * @param fields field names used to build the TypeBox body schema
 */
export const drizzleRouteTemplate = (name: string, kind: string, fields: string[] = []): string => {
  const plural = pluralize(name);
  const method = METHOD[kind] ?? "get";

  const imports = [
    `import { ${method} } from "@ignex/core/http";`,
    `import { db, ${plural} } from "../../db-sql.js";`,
    `import { eq } from "drizzle-orm";`,
    `import { Type } from "typebox";`,
  ].join("\n");

  let body = "";
  switch (kind) {
    case "list":
      body = `export default ${method}(async (ctx) => {
  const rows = db.select().from(${plural}).all();
  return ctx.json(rows);
});`;
      break;
    case "getOne":
      body = `export default ${method}(async (ctx) => {
  const id = Number(ctx.params.id);
  if (Number.isNaN(id)) return ctx.json({ error: "invalid_id" }, 400);
  const rows = db.select().from(${plural}).where(eq(${plural}.id, id)).limit(1).all();
  const row = rows[0];
  if (!row) return ctx.json({ error: "not_found" }, 404);
  return ctx.json(row);
});`;
      break;
    case "create":
      body = `const CreateBody = Type.Object({
${bodySchema(fields)}
});
export default ${method}(
  async (ctx) => {
    const input = await ctx.body.json();
    const row = db
      .insert(${plural})
      .values({ ...input, createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return ctx.json(row, { status: 201 });
  },
  { body: CreateBody },
);`;
      break;
    case "update":
      body = `const UpdateBody = Type.Object({
${bodySchema(fields)}
});
export default ${method}(
  async (ctx) => {
    const id = Number(ctx.params.id);
    if (Number.isNaN(id)) return ctx.json({ error: "invalid_id" }, 400);
    const input = await ctx.body.json();
    const row = db
      .update(${plural})
      .set({ ...input, updatedAt: new Date() })
      .where(eq(${plural}.id, id))
      .returning()
      .get();
    if (!row) return ctx.json({ error: "not_found" }, 404);
    return ctx.json(row);
  },
  { body: UpdateBody },
);`;
      break;
    case "delete":
      body = `export default ${method}(async (ctx) => {
  const id = Number(ctx.params.id);
  if (Number.isNaN(id)) return ctx.json({ error: "invalid_id" }, 400);
  const row = db
    .delete(${plural})
    .where(eq(${plural}.id, id))
    .returning()
    .get();
  if (!row) return ctx.json({ error: "not_found" }, 404);
  return ctx.json({ deleted: true });
});`;
      break;
  }

  return `${imports}

${body}`;
};

/** All CRUD routes for a `--db sql` resource. */
export const drizzleResourceTemplates = (
  name: string,
  fields: string[] = [],
): Array<{ path: string; content: string }> => {
  const plural = pluralize(name);
  const kinds = ["list", "getOne", "create", "update", "delete"];
  return kinds.map((kind) => ({
    path: drizzleRoutePath(plural, kind),
    content: drizzleRouteTemplate(name, kind, fields),
  }));
};
