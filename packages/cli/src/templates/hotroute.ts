/**
 * @fileoverview `ignex hotroute` templates — a ninox resource split into thin
 * route files (HTTP layer) + `src/modules/<plural>/` logic (per-op files and a
 * shared HotCache), for a structure that scales as the project grows.
 *
 * Why modules: generated `resource` routes inline the DB/cache calls in the
 * route file, which gets noisy once you add caching or reuse logic. This
 * variant moves the logic into `src/modules/<plural>/{get,list,post,patch,del}`
 * plus a shared `<plural>.cache.ts` (HotCache read-through for the get-one
 * path) and keeps route files as thin HTTP layers (params/query/status codes).
 *
 * Framework constraint: the AOT compiler only follows a route module's own
 * exports (a pure re-export is dropped), so route files MUST contain the
 * handler inline — modules export plain functions the handler calls.
 */

import { camelCase, pascalCase, pluralize } from "./model";

/** TypeBox params schema shared by every `:id` route. */
const ID_PARAMS = 'Type.Object({ id: Type.String({ pattern: "^[0-9a-fA-F]{24}$" }) })';

const ROUTES_IMPORT = (plural: string, file: string): string =>
  `../../../modules/${plural}/${file}.js`;

/** src/modules/<plural>/<plural>.cache.ts — shared HotCache for read-through. */
export const hotCacheTemplate = (name: string): string => {
  const plural = pluralize(name);
  const cache = `${camelCase(plural)}Cache`; // gigsCache
  const accessor = plural; // gigs
  return `import { createHotCache } from "@ignex/ninox";
import type { ObjectId } from "mongodb";
import { db } from "../../db.js";

/**
 * Shared hot cache for the ${plural} collection.
 *
 * Reads go through the cache; writes invalidate it via the change stream on
 * db.client (replica set). Module handlers import ${accessor} and call
 * await ${accessor}.get(...) — they never touch createHotCache() themselves.
 */
export const ${cache} = createHotCache();

export const ${accessor} = ${cache}.register("${plural}", {
  loader: (_id: ObjectId) => db.getOne("${plural}", { _id }),
  watch: [{ collection: "${plural}", db: db.client }],
});

// Idempotent — probes replica support and opens watchers (or falls back to
// the standalone ticker). Safe at module load; db is already connected.
${cache}.start();
`;
};

/** src/modules/<plural>/get.ts — read-one logic (through the hot cache). */
export const hotGetTemplate = (name: string): string => {
  const plural = pluralize(name);
  const Type = pascalCase(name);
  const accessor = plural;
  const fn = `get${Type}`;
  return `import type { ObjectId } from "mongodb";
import type { ${Type} } from "../../models/${plural}.js";
import { ${accessor} } from "./${plural}.cache.js";

/** Read one ${plural.toLowerCase()} by id, through the hot cache. Null when missing. */
export const ${fn} = (id: ObjectId): Promise<${Type} | null> => ${accessor}.get(id);
`;
};

/** src/modules/<plural>/list.ts — paginated list logic. */
export const hotListTemplate = (name: string): string => {
  const plural = pluralize(name);
  const fn = `list${pascalCase(plural)}`;
  return `import { db } from "../../db.js";

/** List ${plural} with page/limit pagination (newest first). */
export const ${fn} = (page: number, limit: number) =>
  db.paginateFlexible("${plural}", {}, { page, limit, sort: { createdAt: -1 } });
`;
};

/** src/modules/<plural>/post.ts — create logic. */
export const hotPostTemplate = (name: string): string => {
  const plural = pluralize(name);
  const Type = pascalCase(name);
  const fn = `create${Type}`;
  return `import type { InsertInput } from "@ignex/ninox";
import { db } from "../../db.js";
import type { ${Type} } from "../../models/${plural}.js";

/** Create a ${name.toLowerCase()}. */
export const ${fn} = (input: InsertInput<${Type}>) => db.insertOne("${plural}", input);
`;
};

/** src/modules/<plural>/patch.ts — partial-update logic. */
export const hotPatchTemplate = (name: string): string => {
  const plural = pluralize(name);
  const Type = pascalCase(name);
  const fn = `update${Type}`;
  return `import type { ObjectId } from "mongodb";
import type { UpdateInput } from "@ignex/ninox";
import { db } from "../../db.js";
import type { ${Type} } from "../../models/${plural}.js";

/** Update a ${name.toLowerCase()} by id (partial update). */
export const ${fn} = (id: ObjectId, body: UpdateInput<${Type}>) =>
  db.updateOne("${plural}", { _id: id }, body);
`;
};

/** src/modules/<plural>/del.ts — delete logic. */
export const hotDelTemplate = (name: string): string => {
  const plural = pluralize(name);
  const fn = `delete${pascalCase(name)}`;
  return `import type { ObjectId } from "mongodb";
import { db } from "../../db.js";

/** Delete a ${name.toLowerCase()} by id. */
export const ${fn} = (id: ObjectId) => db.deleteOne("${plural}", { _id: id });
`;
};

/** All module files (relative to `src/`) for a hot resource. */
export const hotModuleTemplates = (name: string): Array<{ path: string; content: string }> => {
  const plural = pluralize(name);
  return [
    { path: `modules/${plural}/${plural}.cache.ts`, content: hotCacheTemplate(name) },
    { path: `modules/${plural}/get.ts`, content: hotGetTemplate(name) },
    { path: `modules/${plural}/list.ts`, content: hotListTemplate(name) },
    { path: `modules/${plural}/post.ts`, content: hotPostTemplate(name) },
    { path: `modules/${plural}/patch.ts`, content: hotPatchTemplate(name) },
    { path: `modules/${plural}/del.ts`, content: hotDelTemplate(name) },
  ];
};

/** Thin route file bodies wired to the module logic. */
const hotRouteContent = (name: string, kind: "get" | "list" | "post" | "patch" | "del"): string => {
  const plural = pluralize(name);
  const Type = pascalCase(name);
  switch (kind) {
    case "get": {
      const fn = `get${Type}`;
      return `import { get } from "@ignex/core/http";
import { NotFoundError } from "@ignex/core";
import { Type } from "typebox";
import { ObjectId } from "mongodb";
import { ${fn} } from "${ROUTES_IMPORT(plural, "get")}";

export default get(async (ctx) => {
  const _id = new ObjectId(ctx.params.id);
  const doc = await ${fn}(_id);
  if (!doc) throw new NotFoundError();
  return ctx.json(doc);
}, {
  params: ${ID_PARAMS},
});`;
    }
    case "list": {
      const fn = `list${pascalCase(plural)}`;
      return `import { get } from "@ignex/core/http";
import { ${fn} } from "${ROUTES_IMPORT(plural, "list")}";

export default get(async (ctx) => {
  const page = Math.max(1, Number(ctx.query.get("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, Number(ctx.query.get("limit") ?? "20")));
  const result = await ${fn}(page, limit);
  return ctx.json(result);
});`;
    }
    case "post": {
      const fn = `create${Type}`;
      return `import { post } from "@ignex/core/http";
import type { InsertInput } from "@ignex/ninox";
import type { ${Type} } from "../../../models/${plural}.js";
import { ${fn} } from "${ROUTES_IMPORT(plural, "post")}";

type ${Type}Input = InsertInput<${Type}>;

export default post(async (ctx) => {
  const input = await ctx.body.json<${Type}Input>();
  const { insertedId } = await ${fn}(input);
  return ctx.json({ id: insertedId }, { status: 201 });
});`;
    }
    case "patch": {
      const fn = `update${Type}`;
      return `import { patch } from "@ignex/core/http";
import { NotFoundError } from "@ignex/core";
import { Type } from "typebox";
import { ObjectId } from "mongodb";
import type { UpdateInput } from "@ignex/ninox";
import type { ${Type} } from "../../../models/${plural}.js";
import { ${fn} } from "${ROUTES_IMPORT(plural, "patch")}";

type ${Type}Update = UpdateInput<${Type}>;

export default patch(async (ctx) => {
  const _id = new ObjectId(ctx.params.id);
  const body = await ctx.body.json<${Type}Update>();
  const result = await ${fn}(_id, body);
  if (result.modifiedCount === 0) throw new NotFoundError();
  return ctx.json({ updated: true });
}, {
  params: ${ID_PARAMS},
});`;
    }
    case "del": {
      const fn = `delete${Type}`;
      return `import { del } from "@ignex/core/http";
import { NotFoundError } from "@ignex/core";
import { Type } from "typebox";
import { ObjectId } from "mongodb";
import { ${fn} } from "${ROUTES_IMPORT(plural, "del")}";

export default del(async (ctx) => {
  const _id = new ObjectId(ctx.params.id);
  const result = await ${fn}(_id);
  if (result.deletedCount === 0) throw new NotFoundError();
  return ctx.json({ deleted: true });
}, {
  params: ${ID_PARAMS},
});`;
    }
  }
};

/** Thin route files (relative to `src/routes/`) for a hot resource. */
export const hotRouteTemplates = (name: string): Array<{ path: string; content: string }> => {
  const plural = pluralize(name);
  return [
    { path: `api/${plural}/[id].get.ts`, content: hotRouteContent(name, "get") },
    { path: `api/${plural}/[id].patch.ts`, content: hotRouteContent(name, "patch") },
    { path: `api/${plural}/[id].del.ts`, content: hotRouteContent(name, "del") },
    { path: `api/${plural}/index.get.ts`, content: hotRouteContent(name, "list") },
    { path: `api/${plural}/index.post.ts`, content: hotRouteContent(name, "post") },
  ];
};

/** README describing the module layout. */
export const hotResourceReadmeTemplate = (name: string): string => {
  const plural = pluralize(name);
  const Type = pascalCase(name);
  return `# ${Type} resource (hot)

Generated by \`ignex hotroute ${name}\`. CRUD routes under \`/api/${plural}\`:

- \`GET    /api/${plural}\`        — list (paginateFlexible, \`page\`/\`limit\` query)
- \`GET    /api/${plural}/:id\`    — read one via HotCache (change-stream invalidated)
- \`POST   /api/${plural}\`        — create (insertOne)
- \`PATCH  /api/${plural}/:id\`    — update (updateOne)
- \`DELETE /api/${plural}/:id\`    — delete (deleteOne)

## Structure

- \`src/modules/${plural}/\` — business logic, one file per operation:
  - \`${plural}.cache.ts\` — the shared HotCache (createHotCache + register)
  - \`get.ts\` / \`list.ts\` / \`post.ts\` / \`patch.ts\` / \`del.ts\`
- \`src/routes/api/${plural}/\` — thin HTTP layers (params/query/status) calling the modules

Handlers must stay in the route files (the AOT compiler only follows a route
module's own exports); the modules export plain functions.

Edit \`src/models/${plural}.ts\` to change the schema, then run:
\`\`\`sh
bunx ignex db:sync
\`\`\`
`;
};
