import type { Db, Document, MongoClient } from "mongodb";
import { withTimeout } from "./utils/timeout.ts";

/**
 * Transaction capability detection. MongoDB transactions require a replica set
 * (or mongos). The ORM probes once and caches the result so the transaction
 * wrapper can fall back to plain (non-transactional) execution on standalone
 * servers.
 */
export interface MongoCapabilities {
  probed: boolean;
  transactionsSupported: boolean;
}

export interface MongoCapabilitiesStore {
  get(): MongoCapabilities;
  set(capabilities: MongoCapabilities): void;
  reset(): void;
}

export const createMongoCapabilitiesStore = (): MongoCapabilitiesStore => {
  let state: MongoCapabilities = { probed: false, transactionsSupported: false };
  return {
    get: () => state,
    set: (capabilities) => {
      state = capabilities;
    },
    reset: () => {
      state = { probed: false, transactionsSupported: false };
    },
  };
};

/** `MONGO_USE_TRANSACTIONS=1|true|yes` forces transactions on/off. */
export const readMongoTransactionsEnvOverride = (): boolean | undefined => {
  const raw = process.env.MONGO_USE_TRANSACTIONS;
  if (raw === undefined) return undefined;
  return ["1", "true", "yes"].includes(raw.toLowerCase());
};

/** Probe a connected client/db via `hello`. */
export const probeMongoCapabilities = async (
  client: MongoClient | Db | null | undefined,
): Promise<MongoCapabilities> => {
  try {
    const db = client && "startSession" in client ? (client as MongoClient).db() : (client as Db);
    if (!db) return { probed: false, transactionsSupported: false };
    const hello = await withTimeout(
      db.admin().command({ hello: 1 } as Document),
      5_000,
      "probeMongoCapabilities: hello",
    );
    const isReplicaSet = typeof hello.setName === "string" && hello.setName.length > 0;
    const isMongos = hello.msg === "isdbgrid";
    return { probed: true, transactionsSupported: isReplicaSet || isMongos };
  } catch {
    return { probed: false, transactionsSupported: false };
  }
};

/** Effective transaction support: env override → probed value → URL heuristic. */
export const mongoTransactionsEnabled = (
  store: MongoCapabilitiesStore,
  options: { urlHint?: string; envOverride?: boolean } = {},
): boolean => {
  const env = options.envOverride ?? readMongoTransactionsEnvOverride();
  if (env !== undefined) return env;
  const state = store.get();
  if (state.probed) return state.transactionsSupported;
  if (options.urlHint) return /replicaSet=/.test(options.urlHint);
  return false;
};
