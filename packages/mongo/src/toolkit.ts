import { createMongoMigrationRunner, type MongoMigrationRunner } from "./migrations/index.ts";
import type { MongoService, MongoServiceConfig } from "./service/index.ts";
import { createMongoService } from "./service/index.ts";
import type { DbClientsDefinition } from "./types.ts";

export interface MongoToolkitOptions extends MongoServiceConfig {}

/**
 * Convenience bundle: service + migration runner sharing one config.
 *
 *   const toolkit = createMongoToolkit({ primary: { name, collections } });
 *   await toolkit.service.makeConnections();
 *   await toolkit.migrations.up();
 */
export const createMongoToolkit = <TClients extends DbClientsDefinition = DbClientsDefinition>(
  dbClients: TClients,
  options: MongoToolkitOptions = {},
): {
  service: MongoService<TClients>;
  migrations: MongoMigrationRunner;
} => {
  const service = createMongoService(dbClients, options);
  const migrations = createMongoMigrationRunner(service, {
    migrationDir: service.config.migrationDir,
  });
  return { service, migrations };
};

export type MongoToolkit<TClients extends DbClientsDefinition> = ReturnType<
  typeof createMongoToolkit<TClients>
>;
