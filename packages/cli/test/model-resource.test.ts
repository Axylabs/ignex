/**
 * Generator tests for `ignex model` / `ignex resource` (ninox ORM integration).
 *
 * Covers the field DSL parser, naming helpers, the model template, and the
 * pregenerated CRUD route set (with auth/RBAC guard pre-wiring).
 */
import { expect, test } from "vitest";
import { modelTemplate, parseModelFields, pascalCase, pluralize } from "../src/templates/model.js";
import { resourceRouteTemplate, resourceRouteTemplates } from "../src/templates/resource.js";

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
  expect(getOne).toContain('db.getOneOrFail("users"');
  expect(getOne).toContain("status: 404");
});

test("--rbac pre-wires withGuards with <collection>:read|write permissions", () => {
  const list = resourceRouteTemplate("User", "list", { rbac: true });
  expect(list).toContain('import { withGuards } from "@ignex/core";');
  expect(list).toContain('withGuards(handler, { permissions: ["users:read"] })');

  const create = resourceRouteTemplate("User", "create", { rbac: true });
  expect(create).toContain('withGuards(handler, { permissions: ["users:write"] })');
});

test("--auth pre-wires the require-auth named hook", () => {
  const del = resourceRouteTemplate("User", "delete", { auth: true });
  expect(del).toContain('export const config = { hooks: ["require-auth"] };');
});
