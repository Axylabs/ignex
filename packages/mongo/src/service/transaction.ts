import type { ClientSession, Db, MongoClient, TransactionOptions } from "mongodb";
import { mapMongoDriverError } from "../errors/index.ts";
import type { LoggerLike } from "../utils/logger.ts";

export interface TransactionOpsOptions {
  migrationCollectionPhysical: string;
  /** Map driver errors to typed DomainError/InfraError before rethrowing. */
  wrapMongoErrors?: boolean;
}

/**
 * Transaction + idempotent-migration ops for one database handle.
 */
export const makeTransactionOps = (
  client: MongoClient,
  handle: Db,
  logger: LoggerLike,
  _config: Record<string, unknown>,
  opts: TransactionOpsOptions,
) => {
  /**
   * Run `fn(session)` inside a transaction. On standalone servers where
   * transactions are unsupported (error code 20 / message sniff), falls back
   * to running `fn(null)`.
   */
  const transaction = async <T>(
    fn: (session: ClientSession | null) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> => {
    const session = client.startSession();
    try {
      return await session.withTransaction(async () => fn(session), options);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      const code = (err as { code?: unknown })?.code;
      // Standalone (and deployments without retryable writes) can't run
      // transactions; fall back to running `fn(null)` non-transactionally.
      const unsupported =
        code === 20 ||
        /Transaction numbers are only allowed/i.test(message) ||
        /does not support retryable writes/i.test(message);
      if (unsupported) {
        logger.warn?.({ code }, "transactions unsupported, falling back to non-transactional");
        return fn(null);
      }
      if (opts.wrapMongoErrors) {
        throw mapMongoDriverError(err, { db: handle.databaseName, op: "transaction" });
      }
      throw err;
    } finally {
      await session.endSession();
    }
  };

  /**
   * Idempotent migration claim: `findOneAndUpdate({ name }, $setOnInsert, upsert)`
   * returns null when we won the claim. On failure the claim is deleted so the
   * migration can be retried.
   */
  const migrate = async (
    name: string,
    fn: (session: ClientSession | null) => Promise<void>,
    filePath?: string,
  ): Promise<void> => {
    const journal = handle.collection<{ name: string; appliedAt: Date; file?: string }>(
      opts.migrationCollectionPhysical,
    );
    await transaction(async (session) => {
      const sessionOpts = session ? { session } : {};
      const claim = await journal.findOneAndUpdate(
        { name },
        {
          $setOnInsert: {
            name,
            appliedAt: new Date(),
            ...(filePath ? { file: filePath } : {}),
          },
        },
        { upsert: true, returnDocument: "before", ...sessionOpts },
      );
      if (claim) {
        logger.info({ name }, "migration already applied, skipping");
        return;
      }
      try {
        await fn(session);
      } catch (err) {
        await journal.deleteOne({ name }, sessionOpts).catch(() => {});
        throw err;
      }
    });
  };

  return { transaction, migrate };
};
