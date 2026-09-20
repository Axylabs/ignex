/**
 * @fileoverview Public sub-barrel: ready-made plugin factories re-exported
 * from the `@ignex/core` entry (split from the barrel `src/index.ts` by section
 * banner — move-only; `export` statements verbatim).
 */

// The app-logger plugin precedes the plugins banner in the source barrel —
// kept first here to preserve order.
export {
  type AppLogger,
  type AppLoggerOptions,
  createAppLogger,
} from "../plugins/app-logger";
// ── plugins ─────────────────────────────────────────────────────
export {
  auth,
  authGuard,
  basicAuthPlugin,
  bearerAuthPlugin,
  jwtAuthPlugin,
  optionalAuthPlugin,
} from "../plugins/auth";
export type { AuthMode, AuthModule, AuthModuleOptions } from "../plugins/auth-module";
export { authModule, createAuthModule } from "../plugins/auth-module";
export { type CompressionOptions, compression } from "../plugins/compression";
export { type CorsOptions, cors } from "../plugins/cors";
export { csrf } from "../plugins/csrf";
export { type DebugbarOptions, debugbar } from "../plugins/debugbar";
export {
  type HealthProbeOptions,
  healthProbe,
  type ReadinessCheck,
  type ReadinessReport,
  runReadinessChecks,
} from "../plugins/health";
export {
  type CreateLoggerOptions,
  createLogger,
  type LoggerOptions,
  logger,
} from "../plugins/logger";
export {
  createOtlpExporter,
  type MetricsPluginOptions,
  metricsPlugin,
  type OtlpExporterOptions,
} from "../plugins/metrics";
export { type NativePreflightOptions, nativePreflight } from "../plugins/native";
export {
  type NovaAuthResult,
  type NovaClientMeta,
  type NovaPluginOptions,
  type NovaServerHandle,
  novaAuthFromHook,
  novaMissingError,
  novaPlugin,
} from "../plugins/nova";
export { type OpenAPIOptions, type OpenAPIProvider, openapi } from "../plugins/openapi";
export type { RateLimitOptions, RateLimitStore } from "../plugins/ratelimit";
export { rateLimit } from "../plugins/ratelimit";
export type { RbacOptions, RouteGuards } from "../plugins/rbac";
export {
  authorize,
  can,
  canAll,
  composeGuards,
  createRbac,
  getPermissions,
  getRoles,
  guardChain,
  hasRole,
  permissionMatches,
  requireAuthenticated,
} from "../plugins/rbac";
export { type SecurityOptions, security } from "../plugins/security";
export { type SessionPluginOptions, session } from "../plugins/session";
