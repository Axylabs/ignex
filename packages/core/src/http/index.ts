/**
 * @fileoverview `http` domain — request/response handling.
 *
 * Modules: body, context, files, proxy, route (DSL), sse, ws. Re-exported here
 * for internal and subpath consumers; `@flux/core/http` resolves to
 * `./route` (the schema-first route helpers).
 */
export * from "./body";
export * from "./context";
export * from "./files";
export * from "./proxy";
export * from "./route";
export * from "./sse";
export * from "./ws";
