/**
 * @fileoverview `platform` domain — application runtime infrastructure.
 *
 * Modules: app-error, boot-failure, config, env, errors, fault, jobs, redact.
 * Re-exported here for internal and subpath consumers; `@ignex/core/config`
 * resolves to `./config`. The HTTP error family is re-exported through
 * `errors.ts` (`http-errors.ts` + `operational-errors.ts`).
 */
export * from "./app-error";
export * from "./boot-failure";
export * from "./config";
export * from "./env";
export * from "./env-config";
export * from "./env-report";
export * from "./errors";
export * from "./fault";
export * from "./fault-report";
export * from "./fault-vocabulary";
export * from "./jobs";
export * from "./jobs-durable";
export * from "./jobs-store";
export * from "./redact";
