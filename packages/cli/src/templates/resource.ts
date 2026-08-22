/**
 * Resource CRUD route templates (`ignex resource <Name>`).
 *
 * Generates a REST resource under `src/routes/api/<plural>/` wired to the
 * ninox `db` manager (see `src/db.ts`), with optional auth/RBAC guards:
 *   - `--auth`  → `config.hooks = ["require-auth"]` (AOT named hook)
 *   - `--rbac`  → `withGuards(handler, { permissions: ["<plural>:read|write"] })`
 *                (compiler emits the guard chain)
 *
 * Generated routes are kept deliberately minimal and AOT-friendly:
 *   - one method import per file, top-level imports only (no `await import`)
 *   - schema-validated `:id` params (TypeBox regex, 422 on malformed) + canonical
 *     ninox `InsertInput`/`UpdateInput` body types — no hand-rolled helpers
 *   - thrown `NotFoundError` (404) / framework error mapping — no `ctx.json` shims
 *   - correct status semantics (422 invalid id / 404 not found / 201 created)
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
    // The guard template is app boilerplate (src/lib/guards.ts) — generated
    // by `ignex resource --rbac` — so users own and can extend the business
    // rules. The compiler still statically resolves the `withGuards` wrapper
    // (the RBAC optimization) regardless of which module it comes from.
    imports.push('import { withGuards } from "../../../lib/guards.js";');
  }
  const wrap = opts.rbac
    ? (expr: string): string => `withGuards(${expr}, { permissions: ["${plural}:${action}"] })`
    : (expr: string): string => expr;

  return { imports, config, wrap };
};

/** The relative import path from `src/routes/api/<plural>/` to `src/db.ts`. */
const DB_IMPORT = "../../../db.js";
/** The relative import path from a route to its model. */
const modelImport = (plural: string): string => `../../../models/${plural}.js`;

/**
 * The inline handler expression for a resource kind (no export prefix).
 *
 * `:id` routes attach a TypeBox `params` schema as the second argument, so the
 * router validates the 24-hex ObjectId (422 on malformed input) and types
 * `ctx.params.id` as `string` — the `new ObjectId(...)` after it cannot throw.
 */
const ID_PARAMS = 'Type.Object({ id: Type.String({ pattern: "^[0-9a-fA-F]{24}$" }) })';

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
  const _id = new ObjectId(ctx.params.id);
  const doc = await db.getOne("${plural}", { _id });
  if (!doc) throw new NotFoundError();
  return ctx.json(doc);
}, {
  params: ${ID_PARAMS},
})`;
    case "create":
      return `post(async (ctx) => {
  const input = await ctx.body.json<${Type}Input>();
  const { insertedId } = await db.insertOne("${plural}", input);
  return ctx.json({ id: insertedId }, { status: 201 });
})`;
    case "update":
      return `patch(async (ctx) => {
  const _id = new ObjectId(ctx.params.id);
  const body = await ctx.body.json<${Type}Update>();
  const result = await db.updateOne("${plural}", { _id }, body);
  if (result.modifiedCount === 0) throw new NotFoundError();
  return ctx.json({ updated: true });
}, {
  params: ${ID_PARAMS},
})`;
    case "delete":
      return `del(async (ctx) => {
  const _id = new ObjectId(ctx.params.id);
  const result = await db.deleteOne("${plural}", { _id });
  if (result.deletedCount === 0) throw new NotFoundError();
  return ctx.json({ deleted: true });
}, {
  params: ${ID_PARAMS},
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
    helperImports.push('import { NotFoundError } from "@ignex/core";');
    helperImports.push('import { Type } from "typebox";');
    helperImports.push('import { ObjectId } from "mongodb";');
  }
  if (kind === "create") {
    helperImports.push('import type { InsertInput } from "@ignex/ninox";');
  }
  if (kind === "update") {
    helperImports.push('import type { UpdateInput } from "@ignex/ninox";');
  }
  if (kind === "create" || kind === "update") {
    helperImports.push(`import type { ${Type} } from "${modelImport(plural)}";`);
  }

  const typeAlias: string[] = [];
  if (kind === "create") {
    typeAlias.push(`type ${Type}Input = InsertInput<${Type}>;`);
  }
  if (kind === "update") {
    typeAlias.push(`type ${Type}Update = UpdateInput<${Type}>;`);
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

\`:id\` params are schema-validated (malformed ids → 422) and missing docs throw a
404. Edit \`src/models/${plural}.ts\` to change the schema, then run:
\`\`\`sh
bunx ignex db:sync
\`\`\`
`;
};

export type { ModelField };

/**
 * The RBAC guard boilerplate (`src/lib/guards.ts`) — the APP-owned
 * `withGuards` template. Route files wrap handlers with it; the wrapper
 * attaches the route-local `before` chain onto `handler.config`, which the
 * interpreted router and the AOT compiler both read. Users extend this file
 * with their own business guards freely (it is never regenerated once
 * present).
 */
export const guardsTemplate = (): string => `/**
 * Route guard boilerplate — the app-owned \`withGuards\` guard factory.
 *
 * \`withGuards(guards?)\` returns a route-local \`before\` guard (a
 * HookFn) to chain in a route's \`before\` array alongside any other
 * guards:
 *
 *   export default post(handler, {
 *     body: CreateBody,
 *     before: [withGuards({ permissions: ["things:write"] }), otherGuard()],
 *   });
 *
 * The compiler resolves the conventional \`withGuards\` name: literal
 * guards in the \`before\` array are extracted at build time (RBAC
 * optimization) and guarded routes are never hoisted. Extend this file with
 * your own business guards freely.
 */
import {
  can,
  canAll,
  composeGuards,
  guardChain,
  hasRole,
  requireAuthenticated,
} from "@ignex/core";
import type { HookFn } from "@ignex/core";

/** Guard requirements for a route (role/permission groups, any-of by default). */
export interface RouteGuards {
  roles?: string[];
  permissions?: string[];
  /** Require ALL listed permissions instead of any. */
  all?: boolean;
  /** Require an authenticated user only (default when no roles/permissions). */
  authenticated?: boolean;
}

/** Build a route-local before-guard from RBAC requirements. */
export const withGuards = (guards: RouteGuards = {}): HookFn =>
  composeGuards(...guardChain(guards));

export { requireAuthenticated };
`;
