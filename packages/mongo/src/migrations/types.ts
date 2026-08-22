/**
 * Migration types + constants shared by `./files.ts` (discovery/scaffolding),
 * `./journal.ts` (the `_migrations` journal) and `./index.ts` (the runner).
 */
import type { Document } from "mongodb";
import type { LoggerLike } from "../utils/logger.ts";

export interface MigrationContext {
  service: unknown;
  logger: LoggerLike;
  name: string;
}

export interface MigrationModule {
  up: (ctx: MigrationContext) => void | Promise<void>;
  down: (ctx: MigrationContext) => void | Promise<void>;
}

/** Minimal manager surface the journaling uses (satisfied by `service.db.*Client`). */
export interface JournalManager {
  insertOne(collection: string, doc: Document): Promise<unknown>;
  findMany(collection: string, filter?: Document): Promise<Document[]>;
  deleteOne(collection: string, filter: Document): Promise<unknown>;
  deleteMany(collection: string, filter: Document): Promise<unknown>;
  updateOne(collection: string, filter: Document, update: Document): Promise<unknown>;
  findOneAndUpdate(
    collection: string,
    filter: Document,
    update: Document,
    options?: Record<string, unknown>,
  ): Promise<Document | null>;
}

export interface MongoMigrationRunner {
  /** Apply every not-yet-applied migration in numeric order. */
  up(): Promise<void>;
  /** Roll back applied migrations in reverse order (down to `targetName` when given). */
  down(targetName?: string): Promise<void>;
  status(): Promise<{ applied: string[]; pending: string[] }>;
  /** Scaffold a new `NNN_name.ts` migration file; returns its path. */
  create(name: string): Promise<string>;
}

export interface MongoMigrationRunnerOptions {
  migrationDir?: string;
  logger?: LoggerLike;
}

/** Matches `NNN_name.ts|js|mjs` — the numeric prefix drives ordering. */
export const MIGRATION_FILE = /^(\d+)_.+\.(ts|js|mjs)$/;

/** Collection name of the migration journal (reserved `_`-prefixed name). */
export const JOURNAL_COLLECTION = "_migrations";
