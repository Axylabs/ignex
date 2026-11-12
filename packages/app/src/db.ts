import { createConnection } from "node:net";
import type { IgnexPlugin } from "@ignex/core";
import { debugQuery, instrumentMongoClient } from "@ignex/core/debug";
import { createMongoToolkit, defineCollections } from "@ignex/ninox";
import { env } from "./config/env.js";
import { gigs } from "./models/gigs.js";

// Toolkit = service (connections, CRUD manager, cache, migrations). Extend the
// collections map as you scaffold more models (ignex resource <Name>).
//
// The connection URL is read from MONGO_URL (ninox's default — see
// .env.example), or set dbUrl on the primary definition to override.
export const { service, migrations } = createMongoToolkit(
  {
    primary: {
      name: "app",
      collections: defineCollections(gigs),
      monitorCommands: env.DEBUG,
    },
  },
  {
    cacheWatch: false,
    debugQuery,
    // Versioned schema migrations live in src/migrations (ignex migrate up).
    migrationDir: "src/migrations",
  },
);

// NOTE: connections are intentionally NOT opened at module load. The ignex
// compiler imports route modules at build time to extract schemas; an eager
// `await service.makeConnections()` here would open Mongo sockets that keep the
// build process alive after compilation finishes. The connection is opened
// lazily by dbPlugin().init() at server boot (idempotent) — routes only touch
// `db` inside request handlers, which always run after init().

// The typed CRUD manager used by the generated resource routes.
//
// service.db.primaryClient is populated by makeConnections() (called lazily by
// dbPlugin().init() at server boot). A plain module-scope snapshot would stay
// undefined until then, so db is a proxy that resolves the live manager on
// each access — routes can safely call db.insertOne(...) after boot.
//
// Ninox owns logical DB spans through the injected debugQuery hook. The db
// plugin adds nested wire-level spans through Mongo command monitoring, so no
// second proxy-level query wrapper is needed here.

export const db: typeof service.db.primaryClient = new Proxy(
  {} as typeof service.db.primaryClient,
  {
    get(_target, prop) {
      const manager = service.db.primaryClient;
      if (!manager) {
        throw new Error("[ignex] MongoDB is not connected — failed to connect at boot");
      }
      const value = Reflect.get(manager, prop, manager);
      return typeof value === "function" ? value.bind(manager) : value;
    },
  },
);

/** Parse the `host`/`port` out of a `mongodb://` URI (null for `+srv`/others). */
const mongoHostPort = (rawUrl: string): { host: string; port: number } | null => {
  const base = rawUrl.split("?")[0] ?? "";
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^/:]+)(?::(\d+))?/.exec(base);
  if (!match) return null;
  const host = match[1] ?? "127.0.0.1";
  return {
    host: host === "localhost" ? "127.0.0.1" : host,
    port: match[2] ? Number(match[2]) : 27017,
  };
};

/** Fast TCP reachability probe (mirrors the app test's `hasLocalMongo`). */
const probeMongo = (host: string, port: number, timeoutMs = 800): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

/**
 * Ignex plugin: provision validators/indexes at boot, close at shutdown.
 * Register it in src/app.config.ts (plugins: [..., dbPlugin()]).
 *
 * MongoDB is OPTIONAL for this reference app. A full driver connect blocks boot
 * for the ~10s server-selection timeout when nothing is listening, so init()
 * first does a fast TCP probe of the configured URL (or the default
 * localhost:27017):
 *  - reachable → connect + provision schema (idempotent) as usual;
 *  - unreachable and no URL was configured (fresh checkout, CI runners with no
 *    Mongo service) → warn and keep booting — every non-DB route works, and DB
 *    resource routes fail with a clear error (see the `db` proxy above);
 *  - unreachable and a URL WAS configured → fail fast (the operator asked for
 *    a database).
 */
export const dbPlugin = (): IgnexPlugin => {
  const configuredUrl = process.env.DB_PRIMARY ?? process.env.MONGO_URL;
  const target = mongoHostPort(configuredUrl ?? "mongodb://localhost:27017/");
  let disposeWireMonitoring: (() => void) | undefined;
  return {
    name: "db",
    async init() {
      if (target && !(await probeMongo(target.host, target.port))) {
        if (configuredUrl) {
          throw new Error(
            `MongoDB not reachable at ${target.host}:${target.port} (${configuredUrl})`,
          );
        }
        console.warn(
          `[ignex] MongoDB not reachable at ${target.host}:${target.port} — continuing without DB (set DB_PRIMARY or MONGO_URL to enable)`,
        );
        return;
      }
      try {
        await service.makeConnections();
        if (env.DEBUG && disposeWireMonitoring === undefined) {
          const monitored = instrumentMongoClient(db.mongoClient);
          disposeWireMonitoring = () => monitored.dispose();
        }
        await db.createSchema("gigs");
      } catch (err) {
        if (configuredUrl) throw err;
        console.warn(
          `[ignex] MongoDB unavailable at boot — continuing without DB (${(err as Error).message})`,
        );
      }
    },
    async close() {
      disposeWireMonitoring?.();
      disposeWireMonitoring = undefined;
      await service.closeConnections();
    },
  };
};

// Boot convenience: connect + provision validators/indexes (scripts/tests).
export const initDb = async (): Promise<void> => {
  await service.makeConnections();
  await db.createSchema("gigs");
};
