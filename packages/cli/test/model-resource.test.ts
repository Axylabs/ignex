/**
 * Generator tests for `ignex model` / `ignex resource` (ninox ORM integration).
 *
 * Covers the field DSL parser, naming helpers, the model template, and the
 * pregenerated CRUD route set (with auth/RBAC guard pre-wiring).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runResource } from "../src/commands/resource.js";
import {
  dbTemplate,
  modelTemplate,
  parseModelFields,
  pascalCase,
  pluralize,
} from "../src/templates/model.js";
import {
  guardsTemplate,
  resourceRouteTemplate,
  resourceRouteTemplates,
} from "../src/templates/resource.js";

test("pluralize handles regular, -y, and -s endings", () => {
  expect(pluralize("User")).toBe("users");
  expect(pluralize("Category")).toBe("categories");
  expect(pluralize("Box")).toBe("boxes");
  expect(pluralize("Status")).toBe("statuses");
});

test("pascalCase normalizes kebab/snake names", () => {
  expect(pascalCase("user")).toBe("User");
  expect(pascalCase("blog_post")).toBe("BlogPost");
  expect(pascalCase("api-key")).toBe("ApiKey");
});

test("parseModelFields renders s.* schema lines", () => {
  const fields = parseModelFields(
    "email:string(format email), age:integer, active:boolean, role:enum(admin,editor), tags:array(string), bio:string?, owner:objectId",
  );
  const lines = fields.map((f) => f.line);
  expect(lines).toContain('email: s.string({ format: "email" }),');
  expect(lines).toContain("age: s.integer(),");
  expect(lines).toContain("active: s.boolean(),");
  expect(lines).toContain('role: s.enum(["admin", "editor"] as const),');
  expect(lines).toContain("tags: s.array(s.string()),");
  expect(lines).toContain("bio: s.string().optional(),");
  expect(lines).toContain("owner: s.objectId(),");
});

test("parseModelFields defaults to a single name field when empty", () => {
  const fields = parseModelFields(undefined);
  expect(fields).toHaveLength(1);
  const [field] = fields;
  expect(field?.line).toBe("name: s.string(),");
});

test("parseModelFields fails loud on malformed specs (no silent drop)", () => {
  // A bad field name must not be silently dropped.
  expect(() => parseModelFields("1bad:string")).toThrow(/Invalid model field/);
  expect(() => parseModelFields("valid:string, ")).not.toThrow();

  // An unknown type must not be silently skipped.
  expect(() => parseModelFields("age:integer, weight:kilograms")).toThrow(
    /Unsupported model field type/,
  );

  // An unknown array item type must not degrade to s.string().
  expect(() => parseModelFields("tags:array(blob)")).toThrow(/Unsupported array item type/);

  // An empty enum must not emit an invalid schema (either error is fine —
  // the key is that it fails loud instead of emitting `s.enum([])`).
  expect(() => parseModelFields("role:enum()")).toThrow();
  expect(() => parseModelFields("role:enum( )")).toThrow(/Invalid enum/);
});

test("dbTemplate emits a live db handle + dbPlugin (connects lazily at boot)", () => {
  const code = dbTemplate("Gig");
  expect(code).toContain("export const { service, migrations } = createMongoToolkit(");
  // Versioned migrations are pinned to src/migrations (`ignex migrate up`).
  expect(code).toContain('migrationDir: "src/migrations"');
  // Connections open LAZILY via dbPlugin().init() at server boot, NOT at module
  // load: the AOT compiler imports route modules to extract schemas, and an
  // eager top-level connect would leave Mongo sockets open after the build.
  expect(code).not.toContain("await service.makeConnections();\n\nexport const db");
  expect(code).toContain("export const db: typeof service.db.primaryClient = new Proxy(");
  expect(code).toContain("value.bind(manager)");
  expect(code).toContain("export const dbPlugin = (): IgnexPlugin => ({");
  expect(code).toContain('name: "db"');
  // dbPlugin.init() owns the connection lifecycle (idempotent).
  expect(code).toContain("await service.makeConnections();");
  expect(code).toContain('await db.createSchema("gigs");');
  expect(code).toContain("await service.closeConnections();");
  expect(code).not.toContain("export const db = service.db.primaryClient;");
});

test("modelTemplate emits a schema-first ninox model", () => {
  const code = modelTemplate("User", parseModelFields("email:string, role:enum(admin,user)"));
  expect(code).toContain('import { defineCollection, s, type InferDoc } from "@ignex/ninox";');
  expect(code).toContain("export const userSchema = s.object(");
  expect(code).toContain('name: "users"');
  expect(code).toContain("export type User = InferDoc<typeof userSchema>;");
  expect(code).toContain('export const users = defineCollection("users", userSchema,');
  expect(code).toContain("_id: s.objectId(),");
  expect(code).toContain("createdAt: s.date().optional(),");
  expect(code).toContain("updatedAt: s.date().optional(),");
  expect(code).toContain("timestamps: true,");
});

test("resourceRouteTemplates generates the 5 CRUD routes under api/<plural>/", () => {
  const files = resourceRouteTemplates("User", {});
  const paths = files.map((f) => f.path);
  expect(paths).toEqual([
    "users/index.get.ts",
    "users/[id].get.ts",
    "users/index.post.ts",
    "users/[id].patch.ts",
    "users/[id].del.ts",
  ]);
});

test("resource routes import the db manager and call ninox ops", () => {
  const list = resourceRouteTemplate("User", "list", {});
  expect(list).toContain('import { db } from "../../../db.js";');
  expect(list).toContain('db.paginateFlexible("users"');

  const create = resourceRouteTemplate("User", "create", {});
  expect(create).toContain('db.insertOne("users"');

  const getOne = resourceRouteTemplate("User", "getOne", {});
  expect(getOne).toContain('db.getOne("users"');
  expect(getOne).toContain("throw new NotFoundError()");
});

test("each route imports only the HTTP method it uses", () => {
  expect(resourceRouteTemplate("User", "list", {})).toContain(
    'import { get } from "@ignex/core/http";',
  );
  expect(resourceRouteTemplate("User", "getOne", {})).toContain(
    'import { get } from "@ignex/core/http";',
  );
  expect(resourceRouteTemplate("User", "create", {})).toContain(
    'import { post } from "@ignex/core/http";',
  );
  expect(resourceRouteTemplate("User", "update", {})).toContain(
    'import { patch } from "@ignex/core/http";',
  );
  expect(resourceRouteTemplate("User", "delete", {})).toContain(
    'import { del } from "@ignex/core/http";',
  );
});

test("routes stay static-import + type-safe (no await import, no as any)", () => {
  const getOne = resourceRouteTemplate("User", "getOne", {});
  expect(getOne).not.toContain("await import(");
  expect(getOne).toContain('import { ObjectId } from "mongodb";');
  expect(getOne).toContain('from "typebox"');
  expect(getOne).toContain("new ObjectId(ctx.params.id)");
  expect(getOne).toContain('Type.String({ pattern: "^[0-9a-fA-F]{24}$" })');

  const create = resourceRouteTemplate("User", "create", {});
  expect(create).not.toContain("as any");
  expect(create).toContain("type UserInput = InsertInput<User>;");
  expect(create).toContain('import type { User } from "../../../models/users.js";');

  const update = resourceRouteTemplate("User", "update", {});
  // Regression: the old template used `Partial<User>` in the handler WITHOUT
  // importing the model type — the generated file referenced an undefined `User`.
  expect(update).toContain('import type { User } from "../../../models/users.js";');
  expect(update).toContain("type UserUpdate = UpdateInput<User>;");
  expect(update).toContain("ctx.body.json<UserUpdate>()");
  expect(update).not.toContain("as any");
});

test("generated routes use framework errors + schemas, not hand-rolled helpers", () => {
  const getOne = resourceRouteTemplate("User", "getOne", {});
  expect(getOne).not.toContain("toObjectId");
  expect(getOne).not.toContain("errorResponse");
  expect(getOne).toContain("throw new NotFoundError()");
  expect(getOne).toContain("Type.Object({ id: Type.String");

  const create = resourceRouteTemplate("User", "create", {});
  expect(create).not.toContain("errorResponse");
  expect(create).toContain("InsertInput<User>");

  const update = resourceRouteTemplate("User", "update", {});
  expect(update).not.toContain("errorResponse");
  expect(update).toContain("UpdateInput<User>");
});

test("--rbac pre-wires withGuards (app boilerplate) + the guards template", () => {
  const list = resourceRouteTemplate("User", "list", { rbac: true });
  // withGuards is APP boilerplate (src/lib/guards.ts), not a framework export.
  expect(list).toContain('import { withGuards } from "../../../lib/guards.js";');
  expect(list).toContain("withGuards(get(");
  expect(list).toContain('permissions: ["users:read"]');

  const create = resourceRouteTemplate("User", "create", { rbac: true });
  expect(create).toContain("withGuards(post(");
  expect(create).toContain('permissions: ["users:write"]');

  // The generated boilerplate defines the guard template itself.
  const guards = guardsTemplate();
  expect(guards).toContain("export const withGuards");
  expect(guards).toContain('from "@ignex/core"');
  expect(guards).toContain("composeGuards");
  expect(guards).toContain("guardChain");
  expect(guards).toContain("composeGuards(...guardChain(guards))");
  expect(guards).toContain("before: [withGuards");
});

test("--auth pre-wires the require-auth named hook", () => {
  const del = resourceRouteTemplate("User", "delete", { auth: true });
  expect(del).toContain('export const config = { hooks: ["require-auth"] };');
});

describe("runResource target layout", () => {
  let dir: string;
  let cwd: string;

  beforeAll(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ignex-cli-resource-"));
    process.chdir(dir);
  });

  afterAll(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("scaffolds under src/ — never a gig/ subfolder (root is not the name)", async () => {
    await runResource(["gig"]);

    const route = join(dir, "src", "routes", "api", "gigs");
    expect(existsSync(join(route, "index.get.ts"))).toBe(true);
    expect(existsSync(join(route, "[id].get.ts"))).toBe(true);
    expect(existsSync(join(route, "index.post.ts"))).toBe(true);
    expect(existsSync(join(route, "[id].patch.ts"))).toBe(true);
    expect(existsSync(join(route, "[id].del.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "models", "gigs.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "db.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "lib", "http.ts"))).toBe(false);

    // The pre-fix behaviour wrote everything under ./gig/src — must not happen.
    expect(existsSync(join(dir, "gig", "src"))).toBe(false);
  });

  test("registers dbPlugin() into an existing generated app.config.ts (idempotent)", async () => {
    const appConfig = join(dir, "src", "app.config.ts");
    writeFileSync(
      appConfig,
      `import { compression, cors, openapi, security, session } from "@ignex/core";
import { env } from "./config/env.js";

export const plugins = [
  cors(),
  compression(),
  security(),
  session({ secret: env.SESSION_SECRET ?? "dev-secret-change-me", createIfMissing: true }),
  openapi()
];

export const server = {
  port: env.PORT,
  https: true
};
`,
    );
    // A scaffolded package.json missing the ORM deps.
    writeFileSync(
      join(dir, "package.json"),
      '{\n  "name": "app",\n  "private": true,\n  "type": "module",\n  "dependencies": { "@ignex/core": "latest" }\n}\n',
    );

    await runResource(["post"]);
    const wired = readFileSync(appConfig, "utf8");
    expect(wired).toContain('import { dbPlugin } from "./db.js";');
    expect(wired).toContain("  dbPlugin(),");
    expect(wired.match(/dbPlugin\(\)/g)).toHaveLength(1);

    // The ninox toolkit + typebox get added to dependencies.
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@ignex/ninox"]).toBe("latest");
    expect(pkg.dependencies.typebox).toBe("latest");

    // Running a second resource must not duplicate the plugin/import or deps.
    await runResource(["comment"]);
    const again = readFileSync(appConfig, "utf8");
    expect(again.match(/dbPlugin\(\)/g)).toHaveLength(1);
    expect(again.match(/from ".\/db.js"/g)).toHaveLength(1);
    const pkg2 = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg2.dependencies["@ignex/ninox"]).toBe("latest");
  });
});
