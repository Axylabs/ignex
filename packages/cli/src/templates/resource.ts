/**
 * Resource CRUD route templates (`ignex resource <Name>`).
 *
 * Generates a REST resource under `src/routes/api/<plural>/` wired to the
 * ninox `db` manager (see `src/db.ts`) plus shared helpers in `src/lib/http.ts`,
 * with optional auth/RBAC guards:
 *   - `--auth`  → `config.hooks = ["require-auth"]` (AOT named hook)
 *   - `--rbac`  → `withGuards(handler, { permissions: ["<plural>:read|write"] })`
 *                (compiler emits the guard chain)
 *
 * Generated routes are kept deliberately minimal and AOT-friendly:
 *   - one method import per file, top-level imports only (no `await import`)
 *   - shared `toObjectId`/`errorResponse` helpers instead of per-route boilerplate
 *   - typed request bodies (`<Type>Input`/`<Type>Update`) — no `as any`
 *   - correct status semantics (400 invalid id / 404 not found / 201 created)
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

/** The HTTP method helper per resource kind. */
const METHOD_FOR: Record<ResourceKind, string> = {
  list: "get",
  getOne: "get",
  create: "post",
  update: "patch",
  delete: "del",
};

/**
 * Header lines (imports/config) plus an export wrapper for guards.
 *
 * `wrap(expr)` returns `expr` unchanged, or `withGuards(expr, { permissions })`
 * when `--rbac` is set — wrapping the inline handler so the compiler can still
 * extract the guard chain (`withGuards(innerHandler, guards)` is recognized).
 */
const guardsPrelude = (
  plural: string,
  kind: ResourceKind,
  opts: { auth?: boolean; rbac?: boolean },
): { imports: string[]; config: string[]; wrap: (expr: string) => string } => {
  const imports: string[] = [];
  const config: string[] = [];
  const action = kind === "list" || kind === "getOne" ? "read" : "write";

  if (opts.auth) {
    config.push('export const config = { hooks: ["require-auth"] };');
  }
  if (opts.rbac) {
    imports.push('import { withGuards } from "@ignex/core";');
  }
  const wrap = opts.rbac
    ? (expr: string): string => `withGuards(${expr}, { permissions: ["${plural}:${action}"] })`
    : (expr: string): string => expr;

  return { imports, config, wrap };
};

/** The relative import path from `src/routes/api/<plural>/` to `src/db.ts`. */
const DB_IMPORT = "../../../db.js";
/** The relative import path from a route to the shared `src/lib/http.ts` helpers. */
const LIB_IMPORT = "../../../lib/http.js";
/** The relative import path from a route to its model. */
const modelImport = (plural: string): string => `../../../models/${plural}.js`;

/** The inline handler expression for a resource kind (no export prefix). */
const resourceHandler = (kind: ResourceKind, plural: string, Type: string): string => {
  switch (kind) {
    case "list":
      return `get(async (ctx) => {
  const page = Math.max(1, Number(ctx.query.get("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, Number(ctx.query.get("limit") ?? "20")));
  const result = await db.paginateFlexible("${plural}", {}, { page, limit, sort: { createdAt: -1 } });
  return ctx.json(result);
})`;
    case "getOne":
      return `get(async (ctx) => {
  const _id = toObjectId(ctx.params.id);
  if (!_id) return ctx.json({ error: "Invalid id" }, { status: 400 });
  const doc = await db.getOne("${plural}", { _id });
  if (!doc) return ctx.json({ error: "Not Found" }, { status: 404 });
  return ctx.json(doc);
})`;
    case "create":
      return `post(async (ctx) => {
  const input = await ctx.body.json<${Type}Input>();
  try {
    const { insertedId } = await db.insertOne("${plural}", input);
    return ctx.json({ id: insertedId }, { status: 201 });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return ctx.json(body, { status });
  }
})`;
    case "update":
      return `patch(async (ctx) => {
  const _id = toObjectId(ctx.params.id);
  if (!_id) return ctx.json({ error: "Invalid id" }, { status: 400 });
  const body = await ctx.body.json<${Type}Update>();
  const result = await db.updateOne("${plural}", { _id }, body);
  if (result.modifiedCount === 0) return ctx.json({ error: "Not Found" }, { status: 404 });
  return ctx.json({ updated: true });
})`;
    case "delete":
      return `del(async (ctx) => {
  const _id = toObjectId(ctx.params.id);
  if (!_id) return ctx.json({ error: "Invalid id" }, { status: 400 });
  const result = await db.deleteOne("${plural}", { _id });
  if (result.deletedCount === 0) return ctx.json({ error: "Not Found" }, { status: 404 });
  return ctx.json({ deleted: true });
})`;
  }
};

/** Render one CRUD route file for the resource. */
export const resourceRouteTemplate = (
  name: string,
  kind: ResourceKind,
  opts: { auth?: boolean; rbac?: boolean },
): string => {
  const plural = pluralize(name);
  const Type = pascalCase(name);
  const { imports, config, wrap } = guardsPrelude(plural, kind, opts);

  // Import only what this route actually uses.
  const helperImports: string[] = [];
  if (kind === "getOne" || kind === "update" || kind === "delete") {
    helperImports.push(`import { toObjectId } from "${LIB_IMPORT}";`);
  }
  if (kind === "create") {
    helperImports.push(`import { errorResponse } from "${LIB_IMPORT}";`);
  }
  if (kind === "create" || kind === "update") {
    helperImports.push(`import type { ${Type} } from "${modelImport(plural)}";`);
  }

  const typeAlias: string[] = [];
  if (kind === "create") {
    typeAlias.push(`type ${Type}Input = Omit<${Type}, "_id" | "createdAt" | "updatedAt">;`);
  }
  if (kind === "update") {
    typeAlias.push(
      `type ${Type}Update = Partial<Omit<${Type}, "_id" | "createdAt" | "updatedAt">>;`,
    );
  }

  // Group the file into blank-line-separated sections: imports, config
  // (auth hook), type aliases, then the exported handler.
  const groups: string[] = [];
  const header = [
    imports.join("\n"),
    `import { ${METHOD_FOR[kind]} } from "@ignex/core/http";`,
    `import { db } from "${DB_IMPORT}";`,
    ...helperImports,
  ]
    .filter(Boolean)
    .join("\n");
  groups.push(header);
  if (config.length > 0) groups.push(config.join("\n"));
  if (typeAlias.length > 0) groups.push(typeAlias.join("\n"));
  groups.push(`export default ${wrap(resourceHandler(kind, plural, Type))};`);
  return groups.join("\n\n");
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

/** The shared route helpers (`src/lib/http.ts`) — generated once per project. */
export const httpLibTemplate = (): string => `import { ObjectId } from "mongodb";

// Parse a route :id param into an ObjectId, or null when malformed.
export const toObjectId = (id: string): ObjectId | null => {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
};

// Map a thrown error (ninox errors carry .status) to a JSON body + status.
export const errorResponse = (
  error: unknown,
): { status: number; body: { error: string } } => {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status <= 599) {
    return { status, body: { error: (error as Error | null)?.message ?? "Request failed" } };
  }
  return { status: 500, body: { error: "Internal Server Error" } };
};
`;

/** A README describing the generated resource (optional). */
export const resourceReadmeTemplate = (name: string): string => {
  const plural = pluralize(name);
  const Type = pascalCase(name);
  return `# ${Type} resource

Generated by \`ignex resource ${name}\`. CRUD routes under \`/api/${plural}\`:

- \`GET    /api/${plural}\`        — list (paginateFlexible, \`page\`/\`limit\` query)
- \`GET    /api/${plural}/:id\`    — read one (getOne)
- \`POST   /api/${plural}\`        — create (insertOne)
- \`PATCH  /api/${plural}/:id\`    — update (updateOne)
- \`DELETE /api/${plural}/:id\`    — delete (deleteOne)

Shared helpers live in \`src/lib/http.ts\` (id parsing, error mapping). Edit
\`src/models/${plural}.ts\` to change the schema, then run:
\`\`\`sh
bunx ignex db:sync
\`\`\`
`;
};

export type { ModelField };
