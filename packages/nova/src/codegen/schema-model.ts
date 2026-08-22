/**
 * Normalizes TypeBox schemas into a simple wire model shared by every emitter
 * (.fbs, Rust glue, TS registry). All emitters derive field order / naming from
 * this single model, so the Rust builder and the flatc-generated TS decoders
 * are wire-compatible by construction.
 */
import type { TSchema } from "@sinclair/typebox";

export type FieldKind =
  | "string"
  | "double"
  | "int64"
  | "bool"
  | "enum"
  | "table"
  | "vector-string"
  | "vector-double"
  | "vector-int64"
  | "vector-bool"
  | "vector-enum"
  | "vector-table";

export interface FieldDef {
  /** camelCase, matches the TypeBox/Events key */
  jsonName: string;
  /** snake_case, the wire (.fbs / flatc) field name */
  fbName: string;
  /** whether the field is required in the TypeBox schema */
  required: boolean;
  kind: FieldKind;
  enumName?: string;
  tableName?: string;
  /** int64 field decoded/encoded as `bigint` (Type.Integer({ bigint: true })) — exact beyond 2^53 */
  bigint?: boolean;
}

export interface TableDef {
  name: string;
  fields: FieldDef[];
}

export interface EnumDef {
  name: string;
  values: string[];
}

export interface EventDef {
  name: string;
  tableName: string;
  /** transport-internal event (hello/subscribe/ping/...); hidden from the public Events surface */
  control?: boolean;
}

export interface Model {
  enums: EnumDef[];
  tables: TableDef[];
  events: EventDef[];
}

/**
 * Codegen context shared by every emitter. In-repo generation (scripts/
 * generate.ts) leaves it empty and the generated files import the repo's own
 * modules with relative paths. User-mode generation (public/generate.ts) sets
 * `schemaImport: null` (the generated code emits self-contained local payload
 * types instead of importing the user's schema module) and `libraryImport` to
 * the package the internal helpers should come from.
 */
export interface EmitContext {
  /** import specifier for schema TYPE imports ("../schema" in-repo). null → local types. */
  schemaImport?: string | null;
  /** user mode: where internal runtime helpers (codec / int64-guard / pooledByteBuffer / assembleBindings) come from. */
  libraryImport?: string;
}

/** A table is "flat" when every field maps to a direct FFI arg (no tables/vectors). */
export function isFlatTable(t: TableDef): boolean {
  return t.fields.every(
    (f) =>
      f.kind === "string" ||
      f.kind === "double" ||
      f.kind === "int64" ||
      f.kind === "bool" ||
      f.kind === "enum",
  );
}

/**
 * A table is "directable" when every field is either a flat scalar/string/enum
 * OR a packed vector (scalars/strings/enums, or tables whose elements are flat).
 * Directable events serialize with ZERO allocations and NO JSON — vectors travel
 * as a packed binary blob (`read_packed_*` on the Rust side).
 */
export function isDirectableTable(m: Model, t: TableDef): boolean {
  return t.fields.every((f) => {
    switch (f.kind) {
      case "string":
      case "double":
      case "int64":
      case "bool":
      case "enum":
        return true;
      case "vector-table": {
        const elem = m.tables.find((e) => e.name === f.tableName);
        return elem ? isFlatTable(elem) : false;
      }
      case "vector-string":
      case "vector-double":
      case "vector-int64":
      case "vector-bool":
      case "vector-enum":
        return true;
      default:
        return false;
    }
  });
}

export function isDirectableEvent(m: Model, ev: EventDef): boolean {
  const t = m.tables.find((t) => t.name === ev.tableName);
  return !!t && t.fields.length > 0 && isDirectableTable(m, t);
}

export function toSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function toPascal(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c: string) => (c ? c.toUpperCase() : ""));
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

type AnySchema = Record<string, any>;

interface Ctx {
  named: Map<object, string>;
  used: Set<string>;
  enums: EnumDef[];
  tables: TableDef[];
  events: EventDef[];
  enumById: Map<object, string>;
  tableById: Map<object, string>;
}

function uniqueName(ctx: Ctx, base: string): string {
  let name = base;
  let i = 2;
  while (ctx.used.has(name)) {
    name = `${base}${i}`;
    i++;
  }
  ctx.used.add(name);
  return name;
}

function unionMembers(s: AnySchema): AnySchema[] {
  return (s.anyOf ?? s.oneOf ?? []) as AnySchema[];
}

const isStringLiteral = (m: AnySchema): boolean => typeof m?.const === "string";
const isNullMember = (m: AnySchema): boolean => m?.type === "null";
const isObjectLike = (m: AnySchema): boolean =>
  m?.type === "object" && typeof m?.properties === "object";

function registerEnum(ctx: Ctx, schema: AnySchema, values: string[], jsonName: string): string {
  const existing = ctx.enumById.get(schema);
  if (existing) return existing;
  const name = uniqueName(ctx, toPascal(jsonName));
  ctx.enums.push({ name, values });
  ctx.enumById.set(schema, name);
  return name;
}

function ensureTable(ctx: Ctx, schema: AnySchema, fallbackName: string): string {
  const existing = ctx.tableById.get(schema);
  if (existing) return existing;

  const name = ctx.named.get(schema) ?? uniqueName(ctx, fallbackName);
  if (!ctx.used.has(name)) ctx.used.add(name);
  ctx.tableById.set(schema, name);
  // placeholder first so recursive/self references terminate
  ctx.tables.push({ name, fields: [] });

  const props = (schema.properties ?? {}) as Record<string, AnySchema>;
  const required: string[] = schema.required ?? [];
  const fields: FieldDef[] = [];
  for (const [jsonName, propSchema] of Object.entries(props)) {
    const resolved = resolveFieldType(ctx, propSchema, jsonName, name);
    fields.push({
      jsonName,
      fbName: toSnake(jsonName),
      required: required.includes(jsonName),
      ...resolved,
    });
  }
  const table = ctx.tables.find((t) => t.name === name)!;
  table.fields = fields;
  return name;
}

function resolveFieldType(
  ctx: Ctx,
  schema: AnySchema,
  jsonName: string,
  parentName: string,
): { kind: FieldKind; enumName?: string; tableName?: string; bigint?: boolean } {
  const members = unionMembers(schema);
  if (members.length > 0) {
    if (members.every(isStringLiteral)) {
      const enumName = registerEnum(
        ctx,
        schema,
        members.map((m) => m.const as string),
        jsonName,
      );
      return { kind: "enum", enumName };
    }
    const tableMember = members.find(isObjectLike);
    if (tableMember && members.filter((m) => !isNullMember(m)).length === 1) {
      const tableName = ensureTable(ctx, tableMember, `${parentName}${toPascal(jsonName)}`);
      return { kind: "table", tableName };
    }
    return { kind: "string" };
  }

  switch (schema.type) {
    case "string": {
      if (typeof schema.const === "string") {
        const enumName = registerEnum(ctx, schema, [schema.const], jsonName);
        return { kind: "enum", enumName };
      }
      return { kind: "string" };
    }
    case "number":
      return { kind: "double" };
    case "integer":
      return { kind: "int64" };
    case "bigint":
      // Type.BigInt() → EXACT int64 (decoded/encoded as bigint, not number)
      return { kind: "int64", bigint: true };
    case "boolean":
      return { kind: "bool" };
    case "array": {
      const items = schema.items as AnySchema | undefined;
      if (!items) return { kind: "vector-double" };
      if (isObjectLike(items)) {
        const tableName = ensureTable(ctx, items, `${parentName}${toPascal(jsonName)}Item`);
        return { kind: "vector-table", tableName };
      }
      const itemMembers = unionMembers(items);
      if (itemMembers.length > 0 && itemMembers.every(isStringLiteral)) {
        const enumName = registerEnum(
          ctx,
          items,
          itemMembers.map((m) => m.const as string),
          jsonName,
        );
        return { kind: "vector-enum", enumName };
      }
      switch (items.type) {
        case "string":
          return { kind: "vector-string" };
        case "number":
          return { kind: "vector-double" };
        case "integer":
          return { kind: "vector-int64" };
        case "boolean":
          return { kind: "vector-bool" };
        default:
          return { kind: "vector-double" };
      }
    }
    case "object": {
      if (!isObjectLike(schema)) return { kind: "string" };
      const tableName = ensureTable(ctx, schema, `${parentName}${toPascal(jsonName)}`);
      return { kind: "table", tableName };
    }
    default:
      return { kind: "string" };
  }
}

/** TS type expression for a plain-object field (used by user-mode codegen). */
export function plainTsType(m: Model, f: FieldDef, suffix = "Payload"): string {
  switch (f.kind) {
    case "string":
      return f.required ? "string" : "string | undefined";
    case "double":
      return "number";
    case "int64":
      return f.bigint ? "bigint" : "number";
    case "bool":
      return "boolean";
    case "enum":
      return enumUnion(m, f);
    case "table":
      return f.required ? `${f.tableName}${suffix}` : `${f.tableName}${suffix} | undefined`;
    case "vector-string":
      return `string[]${f.required ? "" : " | undefined"}`;
    case "vector-double":
      return `number[]${f.required ? "" : " | undefined"}`;
    case "vector-int64":
      return `number[]${f.required ? "" : " | undefined"}`;
    case "vector-bool":
      return `boolean[]${f.required ? "" : " | undefined"}`;
    case "vector-enum":
      return `(${enumUnion(m, f)})[]${f.required ? "" : " | undefined"}`;
    case "vector-table":
      return `${f.tableName}${suffix}[]${f.required ? "" : " | undefined"}`;
    default:
      return "unknown";
  }
}

/** string literal union of the enum values, e.g. `"buy" | "sell"`. */
export function enumUnion(m: Model, f: FieldDef): string {
  const values = m.enums.find((e) => e.name === f.enumName)?.values ?? [];
  return values.map((v) => JSON.stringify(v)).join(" | ");
}

export function buildModel(
  namedSchemas: Record<string, TSchema>,
  eventSchemas: Record<string, TSchema>,
  controlEventSchemas: Record<string, TSchema> = {},
): Model {
  const ctx: Ctx = {
    named: new Map(),
    used: new Set(),
    enums: [],
    tables: [],
    events: [],
    enumById: new Map(),
    tableById: new Map(),
  };
  for (const [name, schema] of Object.entries(namedSchemas)) {
    ctx.named.set(schema as object, name);
  }
  for (const [name, schema] of Object.entries(eventSchemas)) {
    const tableName = ensureTable(ctx, schema as AnySchema, toPascal(name));
    ctx.events.push({ name, tableName });
  }
  for (const [name, schema] of Object.entries(controlEventSchemas)) {
    const tableName = ensureTable(ctx, schema as AnySchema, toPascal(name));
    ctx.events.push({ name, tableName, control: true });
  }
  return { enums: ctx.enums, tables: ctx.tables, events: ctx.events };
}
