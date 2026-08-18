/**
 * Ninox ORM model + resource CRUD templates.
 *
 * These generate `@ignex/ninox` schema-first models and resource route
 * handlers (pregenerated CRUD wired to the toolkit's `db` manager), with
 * optional auth/RBAC guard pre-wiring that works in BOTH the interpreted
 * runtime and the AOT compiler (`config.hooks` for auth, `withGuards` for
 * RBAC — the compiler emits guard hooks).
 */

export interface ModelField {
  /** The field line rendered for the schema body, e.g. `email: s.string(),`. */
  readonly line: string;
  /** The TS type name for OpenAPI/type purposes (informational). */
  readonly type: string;
}

/**
 * Split a comma-separated field DSL, respecting parentheses so enum/array
 * values containing commas (`role:enum(admin,editor)`) stay intact.
 */
const splitFields = (input: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
};

/**
 * Parse a comma-separated field DSL into ninox `s.*` schema lines.
 *
 * Supported forms:
 *   name:string        name:string? (optional)
 *   email:string(format email)
 *   age:integer  qty:number  active:boolean  at:date  user:objectId
 *   tags:array(string)  role:enum(admin,editor)  anything:any
 */
export const parseModelFields = (input: string | undefined): ModelField[] => {
  if (!input?.trim()) return [{ line: "name: s.string(),", type: "string" }];

  const out: ModelField[] = [];
  for (const raw of splitFields(input)) {
    const part = raw.trim();
    if (!part) continue;

    const optional = part.endsWith("?");
    const clean = optional ? part.slice(0, -1) : part;
    // Split on the FIRST colon only — the spec may contain colons (enum(a:b)).
    const colon = clean.indexOf(":");
    const name = (colon < 0 ? clean : clean.slice(0, colon)).trim();
    const spec = (colon < 0 ? "" : clean.slice(colon + 1)).trim();
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

    const field = renderField(name, spec, optional);
    if (field) out.push(field);
  }
  return out;
};

/** Render one field spec → `name: s.xxx(...)…,` line. */
const renderField = (name: string, spec: string, optional: boolean): ModelField | null => {
  const suffix = optional ? ".optional()" : "";

  const literal = (expr: string, type: string): ModelField => ({
    line: `${name}: ${expr}${suffix},`,
    type,
  });

  if (!spec || spec === "string") return literal("s.string()", "string");

  // string(format email) / string(min 1)
  const stringMatch = /^string(?:\s*\(\s*(.+?)\s*\))?$/.exec(spec);
  if (stringMatch) {
    const opts = stringMatch[1]?.trim();
    if (opts) {
      const pieces = opts.split(/\s+/);
      const attrs = pieces
        .map((p) => {
          if (p === "email") return 'format: "email"';
          if (p === "uuid") return 'format: "uuid"';
          const m = /^(min|max)(\d+)$/.exec(p);
          return m ? `${m[1]}Length: ${m[2]}` : null;
        })
        .filter(Boolean)
        .join(", ");
      return literal(attrs ? `s.string({ ${attrs} })` : "s.string()", "string");
    }
    return literal("s.string()", "string");
  }

  if (spec === "integer") return literal("s.integer()", "number");
  if (spec === "number") return literal("s.number()", "number");
  if (spec === "boolean") return literal("s.boolean()", "boolean");
  if (spec === "date") return literal("s.date()", "Date");
  if (spec === "objectId") return literal("s.objectId()", "ObjectId");
  if (spec === "any") return literal("s.any()", "unknown");

  // array(string) / array(integer)
  const arrayMatch = /^array\(\s*([a-z]+)\s*\)$/.exec(spec);
  if (arrayMatch) {
    const item = arrayMatch[1] ?? "string";
    const itemExpr: Record<string, string> = {
      string: "s.string()",
      integer: "s.integer()",
      number: "s.number()",
      boolean: "s.boolean()",
      date: "s.date()",
      objectId: "s.objectId()",
    };
    const expr = itemExpr[item] ?? "s.string()";
    return literal(`s.array(${expr})`, `Array<${item}>`);
  }

  // enum(a,b,c)
  const enumMatch = /^enum\(\s*([^)]+)\s*\)$/.exec(spec);
  if (enumMatch) {
    const values = (enumMatch[1] ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => `"${v}"`)
      .join(", ");
    return literal(`s.enum([${values}] as const)`, "string");
  }

  return null;
};

/** Naive pluralizer (users/orders/categories/boxes). */
export const pluralize = (name: string): string => {
  const lower = name.toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
};

/** PascalCase for the type name. */
export const pascalCase = (name: string): string =>
  name
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/** camelCase for the schema const name. */
export const camelCase = (name: string): string => {
  const p = pascalCase(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/** The model file (`src/models/<plural>.ts`). */
export const modelTemplate = (name: string, fields: readonly ModelField[]): string => {
  const Type = pascalCase(name);
  const schema = camelCase(name);
  const plural = pluralize(name);
  const fieldLines = fields.map((f) => `    ${f.line}`).join("\n");

  return `import { defineCollection, s, type InferDoc } from "@ignex/ninox";

export const ${schema}Schema = s.object(
  {
    _id: s.objectId(),
${fieldLines}
    createdAt: s.date().optional(),
    updatedAt: s.date().optional(),
  },
  { name: "${plural}" },
);
export type ${Type} = InferDoc<typeof ${schema}Schema>;

export const ${plural} = defineCollection("${plural}", ${schema}Schema, {
  timestamps: true,
  // indexes: [{ key: { createdAt: -1 } }],
});
`;
};

/** The DB bootstrap module (`src/db.ts`) — generated once per project. */
export const dbTemplate = (name: string): string => {
  const plural = pluralize(name);
  return `import { createMongoToolkit, defineCollections } from "@ignex/ninox";
import { ${plural} } from "./models/${plural}.js";

// Toolkit = service (connections, CRUD manager, cache, migrations). Extend the
// collections map as you scaffold more models (ignex resource <Name>).
export const { service, migrations } = createMongoToolkit(
  { primary: { name: "app", collections: defineCollections(${plural}) } },
  { cacheWatch: true },
);

// The typed CRUD manager used by the generated resource routes.
export const db = service.db.primaryClient;

// Boot convenience: connect + provision validators/indexes + run migrations.
export const initDb = async (): Promise<void> => {
  await service.makeConnections();
  await db.createSchema("${plural}");
};
`;
};
