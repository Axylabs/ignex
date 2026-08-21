/**
 * @fileoverview `ignex seed` — run (or scaffold) the project's DB seed script.
 *
 *   ignex seed            → run the existing src/seed.ts
 *   ignex seed --create   → scaffold src/seed.ts (if missing), then run it
 *
 * The seed script imports the generated `src/db.ts` wiring (`db`, `initDb`,
 * `service`) so it shares the project's collections and MONGO_URL. Scaffolding
 * is a pure file write — it works without a running database; running the seed
 * needs MongoDB reachable.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { exists, writeFileEnsuringDir } from "../utils/fs.js";
import { error, step, success } from "../utils/logger.js";

/** Seed script body — imports the generated db wiring and inserts example data. */
export const seedTemplate = (): string => `import { db, initDb, service } from "./db.js";

// Example seed — replace with your own initial data. Run with: \`ignex seed\`.
await initDb();

// const first = await db.insertOne("gigs", { title: "Launch day", active: true });
// console.log("[seed] inserted:", first);

console.log("[seed] done");

await service.closeConnections();
`;

/** Run `ignex seed`. */
export async function runSeed(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    create: { type: "boolean" },
  });

  // The optional `create` positional is a flag-like action, never the root.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });
  const wantsCreate = Boolean(values.create) || positionals[0] === "create";

  const seedPath = join(root, "src", "seed.ts");
  if (!(await exists(seedPath))) {
    if (!wantsCreate) {
      error("No src/seed.ts found — run `ignex seed --create` to scaffold one.");
      process.exitCode = 1;
      return;
    }
    if (!(await exists(join(root, "src", "db.ts")))) {
      error(
        "No src/db.ts found — scaffold a model first with `ignex resource <Name>` (or `ignex hotroute <Name>`).",
      );
      process.exitCode = 1;
      return;
    }
    await writeFileEnsuringDir(seedPath, seedTemplate());
    success("Created src/seed.ts — edit it to insert your own data, then run `ignex seed`.");
    return;
  }

  step("Running seed");
  try {
    await import(pathToFileURL(seedPath).href);
    success("Seed complete");
  } catch (err) {
    error(`Seed failed: ${err instanceof Error ? err.message : String(err)}`);
    error("Is MongoDB reachable? The seed connects at import time (MONGO_URL).");
    process.exitCode = 1;
  }
}
