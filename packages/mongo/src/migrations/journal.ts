/**
 * The `_migrations` journal — claim-based bookkeeping so concurrent runners
 * can't apply the same migration twice:
 *
 *   - `claim` atomically upserts a `running` row (`$setOnInsert`); the winner
 *     gets `null` back from `findOneAndUpdate` and proceeds.
 *   - `markApplied` flips `status` to `applied` AFTER `up()` succeeds.
 *   - `cleanupStale` re-runs `running` rows left by a hard crash (>60s old).
 *
 * All operations are best-effort where the original did `.catch(() => {})`.
 */
import { JOURNAL_COLLECTION, type JournalManager } from "./types.ts";

export interface MigrationJournal {
  /** Names considered applied (status `applied` or legacy rows with no status). */
  appliedNames(): Promise<Set<string>>;
  /** Recover `running` rows older than a minute (hard-crash recovery). */
  cleanupStale(): Promise<void>;
  /** Atomically claim a migration. Returns true only for the winning runner. */
  claim(name: string, file: string): Promise<boolean>;
  /** Flip a claimed migration to `applied` (after `up()` succeeded). */
  markApplied(name: string): Promise<void>;
  /** Remove a `running` row (on failure, so the migration can be re-run). */
  removeRunning(name: string): Promise<void>;
  /** Delete a migration's journal row (rollback). */
  unrecord(name: string): Promise<void>;
}

/** Build the journal operations over a `JournalManager` (a connected manager). */
export const createMigrationJournal = (manager: JournalManager): MigrationJournal => {
  const appliedNames = async (): Promise<Set<string>> => {
    const rows = await manager.findMany(JOURNAL_COLLECTION);
    return new Set(
      rows
        // `status` is absent on legacy (pre-status) rows — treat those as applied.
        .filter((row) => row.status === undefined || row.status === "applied")
        .map((row) => row.name as string),
    );
  };

  const cleanupStale = async (): Promise<void> => {
    await manager
      .deleteMany(JOURNAL_COLLECTION, {
        status: "running",
        appliedAt: { $lt: new Date(Date.now() - 60_000) },
      })
      .catch(() => {});
  };

  const claim = async (name: string, file: string): Promise<boolean> => {
    // An upsert `$setOnInsert` is exclusive at the document level — the winner
    // upserts a fresh `running` row (findOneAndUpdate returns null); any
    // concurrent runner matches the existing row and skips.
    const claimed = await manager.findOneAndUpdate(
      JOURNAL_COLLECTION,
      { name },
      {
        $setOnInsert: {
          name,
          appliedAt: new Date(),
          status: "running",
          file,
        },
      },
      { upsert: true, returnDocument: "before" },
    );
    return claimed === null;
  };

  const markApplied = async (name: string): Promise<void> => {
    await manager
      .updateOne(JOURNAL_COLLECTION, { name, status: "running" }, { $set: { status: "applied" } })
      .catch(async () => {
        // Marker was removed concurrently — restore an `applied` row.
        await manager
          .insertOne(JOURNAL_COLLECTION, {
            name,
            appliedAt: new Date(),
            status: "applied",
          })
          .catch(() => {});
      });
  };

  const removeRunning = async (name: string): Promise<void> => {
    await manager.deleteOne(JOURNAL_COLLECTION, { name, status: "running" }).catch(() => {});
  };

  const unrecord = async (name: string): Promise<void> => {
    await manager.deleteOne(JOURNAL_COLLECTION, { name });
  };

  return { appliedNames, cleanupStale, claim, markApplied, removeRunning, unrecord };
};
