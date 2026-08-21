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
 *
 * @throws A descriptive {@link Error} on a malformed spec (bad field name,
 * unknown type, unknown array item type, empty enum) — a silently-dropped
 * field would otherwise produce a schema missing data the user asked for.
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
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `Invalid model field "${part}": expected \`name:type\` where name is a valid identifier (e.g. \`email:string, age:integer\`).`,
      );
    }

    const field = renderField(name, spec, optional);
    if (!field) {
      throw new Error(
        `Unsupported model field type for "${name}" (spec: ${JSON.stringify(spec)}). ` +
          "Supported: string, string(format email|uuid), string(min/max N), integer, number, boolean, " +
          'date, objectId, any, array(<type>), enum(a,b,c) — and "?" for optional.',
      );
    }
    out.push(field);
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
    const item = arrayMatch[1] ?? "";
    const itemExpr: Record<string, string> = {
      string: "s.string()",
      integer: "s.integer()",
      number: "s.number()",
      boolean: "s.boolean()",
      date: "s.date()",
      objectId: "s.objectId()",
    };
    const expr = itemExpr[item];
    if (!expr) {
      throw new Error(
        `Unsupported array item type "${item}" for "${name}". Supported: string, integer, number, boolean, date, objectId.`,
      );
    }
    return literal(`s.array(${expr})`, `Array<${item}>`);
  }

  // enum(a,b,c)
  const enumMatch = /^enum\(\s*([^)]+)\s*\)$/.exec(spec);
  if (enumMatch) {
    const values = (enumMatch[1] ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length === 0) {
      throw new Error(
        `Invalid enum for "${name}": enum() needs at least one value (e.g. enum(admin,user)).`,
      );
    }
    return literal(`s.enum([${values.map((v) => `"${v}"`).join(", ")}] as const)`, "string");
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
import type { IgnexPlugin } from "@ignex/core";
import { ${plural} } from "./models/${plural}.js";

// Toolkit = service (connections, CRUD manager, cache, migrations). Extend the
// collections map as you scaffold more models (ignex resource <Name>).
//
// The connection URL is read from MONGO_URL (ninox's default — see
// .env.example), or set dbUrl on the primary definition to override.
export const { service, migrations } = createMongoToolkit(
  { primary: { name: "app", collections: defineCollections(${plural}) } },
  {
    cacheWatch: true,
    // Versioned schema migrations live in src/migrations (ignex migrate up).
    migrationDir: "src/migrations",
  },
);

// Connect eagerly at module load so db.* is usable from module top-level code
// (e.g. a HotCache watch ref that reads db.client). Every module that imports
// this file waits for the connection before its own top-level code runs —
// without this, top-level db.* access would hit an empty manager.
// makeConnections is idempotent, so dbPlugin().init() below can reuse it.
await service.makeConnections();

// The typed CRUD manager used by the generated resource routes.
//
// service.db.primaryClient is only populated after service.makeConnections()
// (done above at module load). A plain module-scope snapshot would stay
// undefined for every request, so db is a proxy that resolves the live
// manager on each access — routes can safely call db.insertOne(...).
export const db: typeof service.db.primaryClient = new Proxy(
  {} as typeof service.db.primaryClient,
  {
    get(_target, prop) {
      const manager = service.db.primaryClient;
      if (!manager) {
        throw new Error("[ignex] MongoDB is not connected — failed to connect at boot");
      }
      const value = Reflect.get(manager, prop, manager);
      return typeof value === "function" ? value.bind(manager) : value;
    },
  },
);

/**
 * Ignex plugin: provision validators/indexes at boot, close at shutdown.
 * Register it in src/app.config.ts (plugins: [..., dbPlugin()]).
 */
export const dbPlugin = (): IgnexPlugin => ({
  name: "db",
  async init() {
    await service.makeConnections(); // idempotent — reuses the client opened above
    await db.createSchema("${plural}");
  },
  async close() {
    await service.closeConnections();
  },
});

// Boot convenience: connect + provision validators/indexes (scripts/tests).
export const initDb = async (): Promise<void> => {
  await service.makeConnections();
  await db.createSchema("${plural}");
};
`;
};
