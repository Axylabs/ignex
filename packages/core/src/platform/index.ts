/**
 * @fileoverview `platform` domain — application runtime infrastructure.
 *
 * Modules: cluster, config, env, errors, jobs, trace. Re-exported here for
 * internal and subpath consumers; `@flux/core/config` resolves to `./config`.
 */
export * from "./cluster";
export * from "./config";
export * from "./env";
export * from "./errors";
export * from "./jobs";
export * from "./trace";
