/**
 * Drizzle CRUD route templates with validated, persisted field semantics.
 */
import { type ModelField, pluralize } from "./model.js";

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

type FieldInput = string | ModelField;

const fieldName = (field: FieldInput): string =>
  typeof field === "string" ? field : (field.line.split(":")[0]?.trim() ?? "field");
const fieldSpec = (field: FieldInput): string =>
  typeof field === "string" ? "string" : field.spec || "string";
const optionalField = (field: FieldInput): boolean =>
  typeof field === "string" ? false : field.optional;

const schemaFor = (field: FieldInput, patch: boolean): string => {
  const spec = fieldSpec(field);
  let schema: string;
  if (spec.startsWith("array(")) {
    const inner = spec.slice(6, -1);
    const item =
      inner === "integer" || inner === "number"
        ? "Type.Number()"
        : inner === "boolean"
          ? "Type.Boolean()"
          : inner === "date"
            ? "Type.Union([Type.String(), Type.Number()])"
            : "Type.String()";
    schema = `Type.Array(${item})`;
  } else if (spec.startsWith("enum(")) {
    const values = spec
      .slice(5, -1)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => `Type.Literal(${JSON.stringify(value)})`);
    schema = `Type.Union([${values.join(", ")}])`;
  } else if (spec === "integer" || spec === "number") {
    schema = "Type.Number()";
  } else if (spec === "boolean") {
    schema = "Type.Boolean()";
  } else if (spec === "date") {
    schema = "Type.Union([Type.String(), Type.Number()])";
  } else if (spec === "any") {
    schema = "Type.Unknown()";
  } else {
    schema = "Type.String()";
  }
  return patch || optionalField(field) ? `Type.Optional(${schema})` : schema;
};

const bodySchema = (fields: readonly FieldInput[], patch: boolean): string =>
  fields.length > 0
    ? fields
        .map((field) => `    ${JSON.stringify(fieldName(field))}: ${schemaFor(field, patch)},`)
        .join("\n")
    : "    // add fields via --fields";

const helpersFor = (fields: readonly FieldInput[]): string => {
  if (fields.length === 0) return "";
  const types = Object.fromEntries(fields.map((field) => [fieldName(field), fieldSpec(field)]));
  return `const FIELD_TYPES: Record<string, string> = ${JSON.stringify(types, null, 2)};
const toSql = (key: string, value: unknown): unknown => {
  const spec = FIELD_TYPES[key];
  if (value === undefined) return undefined;
  if (spec?.startsWith("array(") || spec === "any") return JSON.stringify(value);
  if (spec === "date") return new Date(value as string | number);
  return value;
};
const fromSql = (key: string, value: unknown): unknown => {
  const spec = FIELD_TYPES[key];
  if (typeof value !== "string") return value;
  if (spec?.startsWith("array(") || spec === "any") return JSON.parse(value);
  return value;
};
const toSqlRecord = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).map(([key, value]) => [key, toSql(key, value)]));
const fromSqlRecord = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, fromSql(key, value)]));`;
};

/** Render one drizzle CRUD route. */
export const drizzleRouteTemplate = (
  name: string,
  kind: string,
  fields: readonly FieldInput[] = [],
  opts: { auth?: boolean; rbac?: boolean } = {},
): string => {
  const plural = pluralize(name);
  const method = METHOD[kind] ?? "get";
  const action = kind === "list" || kind === "getOne" ? "read" : "write";
  const imports = [
    `import { ${method} } from "@ignex/core/http";`,
    `import { db, ${plural} } from "../../db-sql.js";`,
    `import { eq } from "drizzle-orm";`,
    `import { Type } from "typebox";`,
  ];
  if (opts.rbac) imports.push(`import { withGuards } from "../../../lib/guards.js";`);
  const config = opts.auth ? ['export const config = { hooks: ["require-auth"] };'] : [];
  const helpers = helpersFor(fields);
  const idParams = 'Type.Object({ id: Type.String({ pattern: "^[0-9]+$" }) })';
  const body = (() => {
    switch (kind) {
      case "list":
        return `get(async (ctx) => {
  const page = Math.max(1, Number(ctx.query.get("page") ?? "1") || 1);
  const limit = Math.min(100, Math.max(1, Number(ctx.query.get("limit") ?? "20") || 20));
  const rows = await db.select().from(${plural}).limit(limit).offset((page - 1) * limit);
  return ctx.json({ data: rows.map(fromSqlRecord), page, limit });
});`;
      case "getOne":
        return `get(async (ctx) => {
  const id = Number(ctx.params.id);
  if (Number.isNaN(id)) return ctx.json({ error: "invalid_id" }, { status: 400 });
  const rows = await db.select().from(${plural}).where(eq(${plural}.id, id)).limit(1);
  const row = rows[0];
  if (!row) return ctx.json({ error: "not_found" }, { status: 404 });
  return ctx.json(fromSqlRecord(row));
}, { params: ${idParams} })`;
      case "create":
        return `post(async (ctx) => {
  const input = toSqlRecord(await ctx.body.json());
  const rows = await db
    .insert(${plural})
    .values({ ...input, createdAt: new Date(), updatedAt: new Date() })
    .returning();
  const row = rows[0];
  if (!row) return ctx.json({ error: "insert_failed" }, { status: 500 });
  return ctx.json(fromSqlRecord(row), { status: 201 });
}, { body: CreateBody })`;
      case "update":
        return `patch(async (ctx) => {
  const id = Number(ctx.params.id);
  if (Number.isNaN(id)) return ctx.json({ error: "invalid_id" }, { status: 400 });
  const input = toSqlRecord(await ctx.body.json());
  const rows = await db
    .update(${plural})
    .set({ ...input, updatedAt: new Date() })
    .where(eq(${plural}.id, id))
    .returning();
  const row = rows[0];
  if (!row) return ctx.json({ error: "not_found" }, { status: 404 });
  return ctx.json(fromSqlRecord(row));
}, { params: ${idParams}, body: UpdateBody })`;
      case "delete":
        return `del(async (ctx) => {
  const id = Number(ctx.params.id);
  if (Number.isNaN(id)) return ctx.json({ error: "invalid_id" }, { status: 400 });
  const rows = await db
    .delete(${plural})
    .where(eq(${plural}.id, id))
    .returning();
  if (!rows[0]) return ctx.json({ error: "not_found" }, { status: 404 });
  return ctx.json({ deleted: true });
}, { params: ${idParams} })`;
      default:
        return "";
    }
  })();
  const schema = kind === "create" ? "CreateBody" : kind === "update" ? "UpdateBody" : "";
  const schemaDecl = schema
    ? `const ${schema} = Type.Object({\n${bodySchema(fields, kind === "update")}\n});`
    : "";
  const wrapped = opts.rbac
    ? `withGuards(${body}, { permissions: ["${plural}:${action}"] })`
    : body;
  return `${imports.join("\n")}

${config.join("\n")}
${schemaDecl}
${helpers}
export default ${wrapped};
`;
};

/** All CRUD routes for a `--db sql` resource. */
export const drizzleResourceTemplates = (
  name: string,
  fields: readonly FieldInput[] = [],
  opts: { auth?: boolean; rbac?: boolean } = {},
): Array<{ path: string; content: string }> => {
  const plural = pluralize(name);
  const kinds = ["list", "getOne", "create", "update", "delete"];
  return kinds.map((kind) => ({
    path: drizzleRoutePath(plural, kind),
    content: drizzleRouteTemplate(name, kind, fields, opts),
  }));
};
