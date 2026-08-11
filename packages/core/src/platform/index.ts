/**
 * @fileoverview `platform` domain — application runtime infrastructure.
 *
 * Modules: config, env, errors, jobs. Re-exported here for internal and
 * subpath consumers; `@ignus/core/config` resolves to `./config`.
 */
export * from "./config";
export * from "./env";
export * from "./errors";
export * from "./jobs";
export * from "./jobs-durable";
export * from "./jobs-store";
