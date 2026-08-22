/**
 * File-based migration runner — `createMongoMigrationRunner`. Orchestrates the
 * two sub-systems:
 *
 *   - `./files.ts`   — discover / load / scaffold `NNN_name.ts` files
 *   - `./journal.ts` — claim-based `_migrations` journal (atomic, crash-safe)
 *
 * `up()` applies pending migrations in numeric order with an atomic claim;
 * `down()` rolls back applied migrations in reverse order; `status()` reports
 * applied/pending; `create()` scaffolds a new file.
 */

import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LoggerLike } from "../utils/logger.ts";
import {
  ensureMigrationDir,
  listMigrationFiles,
  loadMigration,
  migrationNameOf,
  nextMigrationNumber,
} from "./files.ts";
import { createMigrationJournal } from "./journal.ts";
import type { JournalManager, MongoMigrationRunner, MongoMigrationRunnerOptions } from "./types.ts";

/** The `service` shape the runner needs (one connected manager + config/logger). */
interface MigrationService {
  db: Record<string, unknown>;
  logger: LoggerLike;
  config?: { migrationDir?: string };
}

export const createMongoMigrationRunner = (
  service: MigrationService,
  options: MongoMigrationRunnerOptions = {},
): MongoMigrationRunner => {
  const migrationDir = options.migrationDir ?? service.config?.migrationDir ?? "./migrations";
  const logger = options.logger ?? service.logger;

  const manager = (): JournalManager => {
    const key = Object.keys(service.db)[0];
    const db = key ? (service.db[key] as JournalManager) : undefined;
    if (!db) throw new Error("No database client connected — call service.makeConnections() first");
    return db;
  };

  const up = async (): Promise<void> => {
    await ensureMigrationDir(migrationDir);
    const journal = createMigrationJournal(manager());
    // Recover a claim left `running` by a hard crash: if it's older than a
    // minute it was never marked `applied`, so it can be re-run safely.
    await journal.cleanupStale();

    const files = await listMigrationFiles(migrationDir);
    const applied = await journal.appliedNames();
    const pending = files.filter((file) => !applied.has(migrationNameOf(file)));

    for (const file of pending) {
      const migration = await loadMigration(migrationDir, file);
      logger.info({ name: migration.name }, "running migration up");
      // `status` flips to `applied` only AFTER `up()` succeeds, so a mid-flight
      // crash leaves a `running` row that `appliedNames()` does NOT count as
      // applied (the stale-row cleanup above re-runs it).
      if (!(await journal.claim(migration.name, basename(file)))) {
        logger.info({ name: migration.name }, "migration already applied, skipping");
        continue;
      }
      try {
        await migration.up({ service, logger, name: migration.name });
        await journal.markApplied(migration.name);
      } catch (err) {
        await journal.removeRunning(migration.name);
        throw err;
      }
      logger.info({ name: migration.name }, "migration applied");
    }
  };

  const down = async (targetName?: string): Promise<void> => {
    const files = await listMigrationFiles(migrationDir);
    const journal = createMigrationJournal(manager());
    const applied = await journal.appliedNames();
    const appliedFiles = files.filter((file) => applied.has(migrationNameOf(file))).reverse();

    for (const file of appliedFiles) {
      const migration = await loadMigration(migrationDir, file);
      logger.info({ name: migration.name }, "running migration down");
      await migration.down({ service, logger, name: migration.name });
      await journal.unrecord(migration.name);
      logger.info({ name: migration.name }, "migration rolled back");
      if (targetName && migration.name === targetName) break;
    }
  };

  const status = async (): Promise<{ applied: string[]; pending: string[] }> => {
    const files = await listMigrationFiles(migrationDir);
    const applied = await createMigrationJournal(manager()).appliedNames();
    const all = files.map(migrationNameOf);
    return {
      applied: all.filter((name) => applied.has(name)),
      pending: all.filter((name) => !applied.has(name)),
    };
  };

  const create = async (name: string): Promise<string> => {
    await ensureMigrationDir(migrationDir);
    const next = await nextMigrationNumber(migrationDir);
    const padded = String(next).padStart(3, "0");
    const fileName = `${padded}_${name}.ts`;
    const filePath = join(migrationDir, fileName);
    const template = `import type { MigrationContext } from '@ignex/ninox';

export const up = async (ctx: MigrationContext): Promise<void> => {
  // const users = ctx.service.db.primaryClient;
  // await users.createSchema('users');
};

export const down = async (ctx: MigrationContext): Promise<void> => {
  // const users = ctx.service.db.primaryClient;
  // await users.client.dropCollection('users');
};
`;
    await writeFile(filePath, template, "utf8");
    logger.info({ name, file: fileName }, "migration scaffolded");
    return filePath;
  };

  return { up, down, status, create };
};

// Re-export the public migration types so the folder barrel matches the old
// single-module exports.
export type {
  MigrationContext,
  MigrationModule,
  MongoMigrationRunner,
  MongoMigrationRunnerOptions,
} from "./types.ts";
