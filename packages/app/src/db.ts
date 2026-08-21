import type { IgnexPlugin } from "@ignex/core";
import { createMongoToolkit, defineCollections } from "@ignex/ninox";
import { gigs } from "./models/gigs.js";

// Toolkit = service (connections, CRUD manager, cache, migrations). Extend the
// collections map as you scaffold more models (ignex resource <Name>).
//
// The connection URL is read from MONGO_URL (ninox's default — see
// .env.example), or set dbUrl on the primary definition to override.
export const { service, migrations } = createMongoToolkit(
  { primary: { name: "app", collections: defineCollections(gigs) } },
  {
    cacheWatch: true,
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

/**
 * Ignex plugin: provision validators/indexes at boot, close at shutdown.
 * Register it in src/app.config.ts (plugins: [..., dbPlugin()]).
 */
export const dbPlugin = (): IgnexPlugin => ({
  name: "db",
  async init() {
    await service.makeConnections(); // idempotent — reuses the client opened above
    await db.createSchema("gigs");
  },
  async close() {
    await service.closeConnections();
  },
});

// Boot convenience: connect + provision validators/indexes (scripts/tests).
export const initDb = async (): Promise<void> => {
  await service.makeConnections();
  await db.createSchema("gigs");
};
