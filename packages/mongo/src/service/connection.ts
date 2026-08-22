import { MongoClient } from "mongodb";
import type { DbClientsDefinition } from "../types.ts";
import { normalizeMongoUrl } from "./connection-uri.ts";

export interface CoreConfigLike {
  defaultDb: string;
}

/**
 * Resolve the connection string for a client key:
 *   1. `dbClients[key].dbUrl` (normalized)
 *   2. env `DB_<CONSTANT_CASE_KEY>`
 *   3. `config.defaultDb`
 */
export const makeGetDbUrl =
  (dbClients: DbClientsDefinition, config: CoreConfigLike) =>
  (name: string): string => {
    const clientConfig = dbClients[name];
    if (clientConfig?.dbUrl) return normalizeMongoUrl(clientConfig.dbUrl);
    const envName = `DB_${name.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
    const envUrl = process.env[envName];
    if (envUrl) return normalizeMongoUrl(envUrl);
    return normalizeMongoUrl(config.defaultDb);
  };

/**
 * Open one MongoClient per unique URL (clients sharing a URL share a pool),
 * then build a manager for each logical client. On any failure every client
 * opened *in this call* is closed and rolled back so no partial state remains.
 */
export const makeConnectionFactory = <TClients extends DbClientsDefinition>(
  dbClients: TClients,
  db: Record<string, unknown>,
  getDbUrl: (name: string) => string,
  buildManager: (dbKey: string, dbName: string, client: MongoClient) => unknown,
  openedClients: Map<string, MongoClient> = new Map(),
) => {
  return async (names?: (keyof TClients & string)[]): Promise<void> => {
    const keys = (names && names.length > 0 ? names : Object.keys(dbClients)) as Array<
      keyof TClients & string
    >;
    const openedThisCall: Array<{ url: string; client: MongoClient }> = [];
    const assignedThisCall: string[] = [];

    try {
      for (const key of keys) {
        const definition = dbClients[key]!;
        const dbUrl = getDbUrl(key);
        let client = openedClients.get(dbUrl);
        if (!client) {
          client = new MongoClient(dbUrl, {
            connectTimeoutMS: definition.connectTimeoutMs ?? 10_000,
            serverSelectionTimeoutMS: definition.connectTimeoutMs ?? 10_000,
            ...(definition.readPreference && { readPreference: definition.readPreference }),
            ...(definition.readConcern && { readConcern: definition.readConcern }),
            ...(definition.writeConcern && { writeConcern: definition.writeConcern }),
          });
          // Swallow driver-level 'error' events (e.g. connection interruption
          // during close) so they never surface as unhandled rejections.
          client.on("error", () => {});
          openedClients.set(dbUrl, client);
          openedThisCall.push({ url: dbUrl, client });
          await client.connect();
        }
        const dbKey = `${key}Client`;
        db[dbKey] = buildManager(key, definition.name, client);
        assignedThisCall.push(dbKey);
      }
    } catch (err) {
      await Promise.allSettled(openedThisCall.map(({ client }) => client.close()));
      for (const { url } of openedThisCall) openedClients.delete(url);
      // Remove managers assigned earlier in this call so `db` never holds a
      // handle whose MongoClient was just closed (dangling manager on partial
      // failure — the next makeConnections overwrites them anyway).
      for (const dbKey of assignedThisCall) delete db[dbKey];
      throw err;
    }
  };
};

/** Close every pooled client and clear the pool. Never throws — each close is
 * guarded against both sync throws and rejections (the driver can throw a
 * `MongoClientClosedError` when a connection is still checked out at close). */
export const closeConnections = async (openedClients: Map<string, MongoClient>): Promise<void> => {
  const closes = [...openedClients.values()].map((client) => {
    try {
      return Promise.resolve(client.close()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  });
  await Promise.allSettled(closes);
  openedClients.clear();
};
