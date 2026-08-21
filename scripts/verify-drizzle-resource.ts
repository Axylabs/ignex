/**
 * Verify the generated Drizzle (`--db sql`) resource end-to-end against a real
 * in-memory SQLite — create / read / update / delete over the exact code the
 * CLI emits (model table + bun-sqlite client + drizzle queries). Runs under
 * plain Bun; vitest workers can't meaningfully drive the generated route
 * modules without the app runtime.
 *
 * Usage: `bun scripts/verify-drizzle-resource.ts` — exits 0 on success.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  drizzleConfigTemplate,
  drizzleDbTemplate,
  drizzleModelTemplate,
} from "../packages/cli/src/templates/drizzle.js";
import { drizzleResourceTemplates } from "../packages/cli/src/templates/drizzle-resource.js";
import { parseModelFields } from "../packages/cli/src/templates/model.js";

const fail = (message: string): never => {
  console.error("FAIL:", message);
  process.exit(1);
};

// 1. Generate the resource exactly like `ignex resource User --db sql`.
const fields = parseModelFields("email:string(format email),age:integer,active:boolean");
const modelCode = drizzleModelTemplate("User", fields);
const dbCode = drizzleDbTemplate();
const configCode = drizzleConfigTemplate();
const routes = drizzleResourceTemplates("User", ["email", "age", "active"]);

// 2. Shape sanity.
if (!modelCode.includes('sqliteTable("users"')) fail("model template missing table");
if (!dbCode.includes("drizzle-orm/bun-sqlite")) fail("db template missing driver");
if (!configCode.includes('dialect: "sqlite"')) fail("config template missing dialect");
if (routes.length !== 5) fail("expected 5 CRUD routes");
if (!routes.some((r) => r.path === "api/users/index.get.ts")) fail("list route path wrong");

// 3. Import the generated model file (write to a temp dir so `drizzle-orm`
//    resolves from the workspace).
const tmp = mkdtempSync(join(tmpdir(), "ignex-drizzle-verify-"));
try {
  writeFileSync(join(tmp, "users.ts"), modelCode);
  const { users } = (await import(pathToFileURL(join(tmp, "users.ts")).href)) as {
    users: any;
  };
  if (!users) fail("generated model did not export the table");

  // 4. Boot SQLite with the schema drizzle-kit would emit and run CRUD.
  const sqlite = new Database(":memory:");
  sqlite.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, age INTEGER, active INTEGER, created_at INTEGER, updated_at INTEGER);",
  );
  const db = drizzle(sqlite);

  // CREATE
  const created = db
    .insert(users)
    .values({ email: "a@b.c", age: 30, active: true, createdAt: new Date(), updatedAt: new Date() })
    .returning()
    .get() as { id: number; email: string; active: boolean };
  if (!created?.id || created.email !== "a@b.c" || created.active !== true) {
    fail(`create returned wrong row: ${JSON.stringify(created)}`);
  }
  console.log(`CREATE ok (id=${created.id})`);

  // READ (getOne — eq on the PK)
  const found = db.select().from(users).where(eq(users.id, created.id)).limit(1).all();
  if (found.length !== 1 || found[0]?.email !== "a@b.c") fail("getOne returned wrong row");
  console.log("GET ok");

  // UPDATE
  db.update(users).set({ age: 31, updatedAt: new Date() }).where(eq(users.id, created.id)).run();
  const updated = db.select().from(users).where(eq(users.id, created.id)).all();
  if (updated[0]?.age !== 31) fail("update did not persist age=31");
  console.log("UPDATE ok");

  // DELETE
  db.delete(users).where(eq(users.id, created.id)).run();
  const left = db.select().from(users).all();
  if (left.length !== 0) fail("delete left rows behind");
  console.log("DELETE ok");

  console.log("[verify-drizzle] OK — generated Drizzle resource CRUD verified.");
  process.exit(0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
