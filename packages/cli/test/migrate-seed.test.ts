/**
 * Tests for `ignex migrate` / `ignex seed` — the ninox migration runner CLI
 * and the seed script scaffolder.
 *
 * Only the offline paths are exercised here (scaffold + directory resolution +
 * error paths): actually running migrations/seed requires a live MongoDB, so
 * those delegate to the project's `src/db.ts` runner instead of being unit
 * tested.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createMigration,
  migrationTemplate,
  resolveMigrationDir,
  runMigrate,
} from "../src/commands/migrate.js";
import { findCommand } from "../src/commands/registry.js";
import { runSeed, seedTemplate } from "../src/commands/seed.js";

/** Create a throwaway project root with a minimal (stub) src/db.ts. */
function tmpProject(withDb = true): string {
  const dir = mkdtempSync(join(tmpdir(), "ignex-cli-migrate-"));
  if (withDb) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src/db.ts"),
      'export const { service, migrations } = createMongoToolkit({ primary: { name: "app", collections: {} } }, { migrationDir: "src/migrations" });\n',
      "utf8",
    );
  }
  return dir;
}

describe("resolveMigrationDir", () => {
  test("reads the migrationDir option from src/db.ts", () => {
    expect(resolveMigrationDir('migrationDir: "src/migrations",')).toBe("src/migrations");
    expect(resolveMigrationDir('migrationDir: "db/migrations"')).toBe("db/migrations");
  });

  test("falls back to the ninox default when unset", () => {
    expect(resolveMigrationDir("export const x = 1;")).toBe("src/migrations");
  });
});

describe("migrationTemplate", () => {
  test("emits up/down migration hooks", () => {
    const code = migrationTemplate();
    expect(code).toContain('import type { MigrationContext } from "@ignex/ninox";');
    expect(code).toContain("export const up = async (ctx: MigrationContext)");
    expect(code).toContain("export const down = async (ctx: MigrationContext)");
  });
});

describe("createMigration", () => {
  test("writes NNN_name.ts into the configured migration dir", async () => {
    const dir = tmpProject();
    try {
      const file = await createMigration(dir, "add-slug");
      expect(file).toBe(join(dir, "src/migrations/001_add-slug.ts"));
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("export const up");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("increments the migration number", async () => {
    const dir = tmpProject();
    try {
      await createMigration(dir, "first");
      const second = await createMigration(dir, "second");
      expect(second).toBe(join(dir, "src/migrations/002_second.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ignex migrate (command wiring)", () => {
  test("creates a migration file via `migrate create <name>`", async () => {
    const dir = tmpProject();
    try {
      await runMigrate(["create", "add-indexes", "--root", dir]);
      expect(existsSync(join(dir, "src/migrations/001_add-indexes.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("errors when src/db.ts is missing", async () => {
    const dir = tmpProject(false);
    const originalExitCode = process.exitCode;
    try {
      await runMigrate(["up", "--root", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an unknown action", async () => {
    const dir = tmpProject();
    const originalExitCode = process.exitCode;
    try {
      await runMigrate(["frobnicate", "--root", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires a name for `create`", async () => {
    const dir = tmpProject();
    const originalExitCode = process.exitCode;
    try {
      await runMigrate(["create", "--root", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is registered in the command registry", () => {
    const cmd = findCommand("migrate");
    expect(cmd).toBeDefined();
    expect(cmd?.aliases).toContain("mg");
  });
});

describe("ignex seed (command wiring)", () => {
  test("scaffolds src/seed.ts with --create", async () => {
    const dir = tmpProject();
    try {
      await runSeed(["create", "--root", dir]);
      const seed = readFileSync(join(dir, "src/seed.ts"), "utf8");
      expect(seed).toContain('import { db, initDb, service } from "./db.js";');
      expect(seed).toContain("await initDb();");
      expect(seed).toContain("await service.closeConnections();");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("errors when src/db.ts is missing", async () => {
    const dir = tmpProject(false);
    const originalExitCode = process.exitCode;
    try {
      await runSeed(["create", "--root", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("errors when run without an existing seed file", async () => {
    const dir = tmpProject();
    const originalExitCode = process.exitCode;
    try {
      await runSeed(["--root", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("seedTemplate wires the generated db handle", () => {
    const code = seedTemplate();
    expect(code).toContain("db.insertOne");
    expect(code).toContain("service.closeConnections()");
  });

  test("is registered in the command registry", () => {
    const cmd = findCommand("seed");
    expect(cmd).toBeDefined();
    expect(cmd?.aliases).toContain("seed-db");
  });
});
