/**
 * DB connection-URL wiring for scaffold commands.
 *
 * When a scaffold FIRST creates `src/db.ts` (ninox/Mongo) or `src/db-sql.ts`
 * (Drizzle/SQLite) — e.g. `ignex resource User` or `ignex hotroute User` — the
 * connection URL becomes a first-class, validated entry in the project's env
 * config:
 *
 *   - `src/config/env.ts` gains `MONGO_URL` / `DATABASE_URL` (with a local-dev
 *     default) so the URL is typed + validated, not a raw `process.env` read;
 *   - `.env.example` gains a matching line (single source of truth);
 *   - if `src/config/env.ts` is missing it is scaffolded from the standard
 *     env template first, so the generated `db.ts`/`db-sql.ts` (which import
 *     `./config/env.js`) always resolve.
 *
 * `db.ts`/`db-sql.ts` read `env.MONGO_URL` / `env.DATABASE_URL` — mapped to the
 * env config instead of duplicated across files. Hand-edited env.ts files that
 * don't match the generated shape are left alone with a hint (never mangled).
 */

import { join } from "node:path";
import { envConfigTemplate, envExampleTemplate } from "../templates/env.js";
import { exists, readTextFile, writeFileEnsuringDir } from "./fs.js";
import { success, warn } from "./logger.js";

/** The two data layers that map a connection URL through the env config. */
export type DbKind = "mongo" | "sql";

/** The env schema entry + matching `.env.example` section per data layer. */
const DB_ENV_ENTRY: Record<DbKind, { readonly schema: string; readonly example: string }> = {
  mongo: {
    schema: '  MONGO_URL: Type.Optional(Type.String({ default: "mongodb://localhost:27017/" })),',
    example: `# OPTIONAL — MONGO_URL (default: mongodb://localhost:27017/)
MONGO_URL=mongodb://localhost:27017/`,
  },
  sql: {
    schema: '  DATABASE_URL: Type.String({ default: "./data/app.db" }),',
    example: `# OPTIONAL — DATABASE_URL (default: ./data/app.db)
DATABASE_URL=./data/app.db`,
  },
};

/** The env var a data layer maps (used for idempotency checks). */
export const DB_ENV_VAR: Record<DbKind, string> = {
  mongo: "MONGO_URL",
  sql: "DATABASE_URL",
};

/**
 * Insert a schema property into the generated `envSchema` `Type.Object({ … })`
 * block, just before its closing `});`. Returns the new source, or `null` when
 * the file doesn't match the generated shape (hand-edited) — callers then hint
 * instead of mangling it.
 */
const insertIntoEnvSchema = (envTs: string, entry: string): string | null => {
  const lines = envTs.split("\n");
  const openIdx = lines.findIndex(
    (line) => line.includes("export const envSchema") && line.includes("Type.Object({"),
  );
  if (openIdx === -1) return null;
  // The schema block is flat; the first `});` at column 0 after `Type.Object({`
  // is its closing brace.
  for (let i = openIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && /^\s*\}\);\s*$/.test(line)) {
      lines.splice(i, 0, entry);
      return lines.join("\n");
    }
  }
  return null;
};

/** Add the DB var to `src/config/env.ts` (creating it from the baseline
 *  template when missing). Idempotent. */
async function wireEnvSchema(root: string, kind: DbKind): Promise<void> {
  const path = join(root, "src", "config", "env.ts");
  const varName = DB_ENV_VAR[kind];
  const entry = DB_ENV_ENTRY[kind].schema;

  let src: string;
  if (!(await exists(path))) {
    src = envConfigTemplate();
  } else {
    src = await readTextFile(path);
    if (src.includes(`${varName}:`)) return; // already wired
  }

  const next = insertIntoEnvSchema(src, entry);
  if (next === null) {
    warn(`Could not auto-wire ${varName} into ${path} — add it to envSchema manually.`);
    return;
  }
  await writeFileEnsuringDir(path, next);
  success(`Added ${varName} to src/config/env.ts`);
}

/** Add the DB var to `.env.example` (creating it when missing). Idempotent. */
async function wireEnvExample(root: string, kind: DbKind): Promise<void> {
  const path = join(root, ".env.example");
  const varName = DB_ENV_VAR[kind];
  const section = DB_ENV_ENTRY[kind].example;

  let src: string;
  if (!(await exists(path))) {
    src = envExampleTemplate();
  } else {
    src = await readTextFile(path);
    if (src.includes(`${varName}=`)) return; // already wired
  }

  const next = `${src.trimEnd()}\n\n${section}\n`;
  await writeFileEnsuringDir(path, next);
  success(`Added ${varName} to .env.example`);
}

/**
 * Wire the connection URL for a data layer into the project's env config.
 *
 * Call only when the db bootstrap file is created for the FIRST time — the
 * project's own `.env`/env.ts edits are never overwritten, only supplemented.
 */
export async function wireDbEnv(root: string, kind: DbKind): Promise<void> {
  await wireEnvSchema(root, kind);
  await wireEnvExample(root, kind);
}
