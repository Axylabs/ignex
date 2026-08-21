/**
 * Drizzle (`--db sql`) scaffolding — model + db client + config + CRUD routes.
 *
 * The generated code is validated end-to-end against a real in-memory SQLite
 * via `bun:sqlite` + drizzle-orm in `scripts/verify-drizzle-resource.ts`; these
 * unit tests lock the template SHAPE (column mapping, imports, route paths).
 */
import { describe, expect, it } from "vitest";
import {
  drizzleColumn,
  drizzleConfigTemplate,
  drizzleDbTemplate,
  drizzleModelTemplate,
  sqlColumnName,
} from "../src/templates/drizzle.js";
import {
  drizzleResourceTemplates,
  drizzleRoutePath,
  drizzleRouteTemplate,
} from "../src/templates/drizzle-resource.js";
import { parseModelFields } from "../src/templates/model.js";

describe("sqlColumnName", () => {
  it("converts camelCase/kebab to snake_case", () => {
    expect(sqlColumnName("email")).toBe("email");
    expect(sqlColumnName("firstName")).toBe("first_name");
    expect(sqlColumnName("role")).toBe("role");
    expect(sqlColumnName("is-active")).toBe("is_active");
  });
});

describe("drizzleColumn", () => {
  it("maps each field DSL type to a drizzle sqlite column", () => {
    expect(drizzleColumn(parseModelFields("s:string")[0]!)).toBe('s: text("s"),');
    expect(drizzleColumn(parseModelFields("n:integer")[0]!)).toBe('n: integer("n"),');
    expect(drizzleColumn(parseModelFields("r:number")[0]!)).toBe('r: real("r"),');
    expect(drizzleColumn(parseModelFields("b:boolean")[0]!)).toBe(
      'b: integer("b", { mode: "boolean" }),',
    );
    expect(drizzleColumn(parseModelFields("d:date")[0]!)).toBe(
      'd: integer("d", { mode: "timestamp_ms" }),',
    );
    expect(drizzleColumn(parseModelFields("e:enum(a,b)")[0]!)).toBe('e: text("e"),');
    expect(drizzleColumn(parseModelFields("t:array(string)")[0]!)).toBe('t: text("t"),');
  });
});

describe("drizzleModelTemplate", () => {
  it("emits a sqlite table with id PK + timestamps", () => {
    const code = drizzleModelTemplate("User", parseModelFields("email:string,age:integer"));
    expect(code).toContain('sqliteTable("users"');
    expect(code).toContain('id: integer("id").primaryKey({ autoIncrement: true })');
    expect(code).toContain('createdAt: integer("created_at", { mode: "timestamp_ms" })');
    expect(code).toContain("export type User = typeof users.$inferSelect");
  });
});

describe("drizzleDbTemplate / drizzleConfigTemplate", () => {
  it("emits the bun-sqlite client and drizzle-kit config", () => {
    const db = drizzleDbTemplate();
    expect(db).toContain('from "drizzle-orm/bun-sqlite"');
    expect(db).toContain("new Database(");
    expect(db).toContain("PRAGMA journal_mode = WAL");

    const cfg = drizzleConfigTemplate();
    expect(cfg).toContain('from "drizzle-kit"');
    expect(cfg).toContain('dialect: "sqlite"');
    expect(cfg).toContain('"./src/models/*.ts"');
  });
});

describe("drizzleResourceTemplates", () => {
  it("emits all 5 CRUD routes under api/<plural>/", () => {
    const files = drizzleResourceTemplates("User", ["email", "age"]);
    expect(files.map((f) => f.path)).toEqual([
      "api/users/index.get.ts",
      "api/users/[id].get.ts",
      "api/users/index.post.ts",
      "api/users/[id].patch.ts",
      "api/users/[id].del.ts",
    ]);
  });

  it("uses drizzle queries (select/insert/update/delete + eq)", () => {
    const list = drizzleRouteTemplate("User", "list");
    expect(list).toContain("db.select().from(users).all()");

    const create = drizzleRouteTemplate("User", "create", ["email"]);
    expect(create).toContain(".insert(users)");
    expect(create).toContain('import { db, users } from "../../db-sql.js";');

    const getOne = drizzleRouteTemplate("User", "getOne");
    expect(getOne).toContain("eq(users.id, id)");

    const del = drizzleRouteTemplate("User", "delete");
    expect(del).toContain(".delete(users)");
  });
});
