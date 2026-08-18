/**
 * Generator tests for `ignex model` / `ignex resource` (ninox ORM integration).
 *
 * Covers the field DSL parser, naming helpers, the model template, and the
 * pregenerated CRUD route set (with auth/RBAC guard pre-wiring).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runResource } from "../src/commands/resource.js";
import { modelTemplate, parseModelFields, pascalCase, pluralize } from "../src/templates/model.js";
import {
  httpLibTemplate,
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

test("modelTemplate emits a schema-first ninox model", () => {
  const code = modelTemplate("User", parseModelFields("email:string, role:enum(admin,user)"));
  expect(code).toContain('import { defineCollection, s, type InferDoc } from "@ignex/ninox";');
  expect(code).toContain("export const userSchema = s.object(");
  expect(code).toContain('name: "users"');
  expect(code).toContain("export type User = InferDoc<typeof userSchema>;");
  expect(code).toContain('export const users = defineCollection("users", userSchema,');
  expect(code).toContain("_id: s.objectId(),");
  expect(code).toContain("createdAt: s.date(),");
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
  expect(getOne).toContain("status: 404");
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
  expect(getOne).not.toContain('from "mongodb"');
  expect(getOne).toContain("toObjectId(ctx.params.id)");

  const create = resourceRouteTemplate("User", "create", {});
  expect(create).not.toContain("as any");
  expect(create).toContain('type UserInput = Omit<User, "_id" | "createdAt" | "updatedAt">;');
  expect(create).toContain('import type { User } from "../../../models/users.js";');

  const update = resourceRouteTemplate("User", "update", {});
  // Regression: the old template used `Partial<User>` in the handler WITHOUT
  // importing the model type — the generated file referenced an undefined `User`.
  expect(update).toContain('import type { User } from "../../../models/users.js";');
  expect(update).toContain(
    'type UserUpdate = Partial<Omit<User, "_id" | "createdAt" | "updatedAt">>;',
  );
  expect(update).toContain("ctx.body.json<UserUpdate>()");
  expect(update).not.toContain("as any");
});

test("httpLibTemplate ships the shared toObjectId/errorResponse helpers", () => {
  const lib = httpLibTemplate();
  expect(lib).toContain('import { ObjectId } from "mongodb";');
  expect(lib).toContain("export const toObjectId");
  expect(lib).toContain("export const errorResponse");
});

test("--rbac pre-wires withGuards with <collection>:read|write permissions", () => {
  const list = resourceRouteTemplate("User", "list", { rbac: true });
  expect(list).toContain('import { withGuards } from "@ignex/core";');
  expect(list).toContain("withGuards(get(");
  expect(list).toContain('permissions: ["users:read"]');

  const create = resourceRouteTemplate("User", "create", { rbac: true });
  expect(create).toContain("withGuards(post(");
  expect(create).toContain('permissions: ["users:write"]');
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
    expect(existsSync(join(dir, "src", "lib", "http.ts"))).toBe(true);

    // The pre-fix behaviour wrote everything under ./gig/src — must not happen.
    expect(existsSync(join(dir, "gig", "src"))).toBe(false);
  });
});
