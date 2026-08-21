/**
 * @fileoverview Ignex Core — public entry.
 *
 * This barrel is the single public surface of `@ignex/core`. Internally the
 * implementation is grouped by use case into domain folders so each concern
 * stays small and discoverable:
 *
 *   security/   — auth, csrf, crypto, session        (request security & trust)
 *   http/       — context, body, proxy, files, sse, ws, route DSL
 *   data/       — cache, dataloader, lru, query, schema, validation
 *   lifecycle/  — hooks, lifecycle, plugin
 *   platform/   — env, config, jobs, errors
 *   content/    — i18n, template
 *   plugins/    — ready-made IgnexPlugin factories
 *
 * Consumers import everything from `@ignex/core` (or `@ignex/core/http` for the
 * route DSL) — the folder layout is an internal implementation detail.
 */

// ── unified execution API (@ignex/native) ────────────────────────
// The single runtime-switch facade: `backend.*` binds every primitive to its
// fastest implementation (castrum native on Bun vs pure-TS fallback), driven
// by the `SELECTION` table in @ignex/native. `SELECTION` is read-only data —
// treat it as a snapshot, not something to mutate.
export {
  backend,
  backendName,
  createExecutionBackend,
  createNativeRoute,
  type ExecutionBackend,
  type ExecutionOpStatus,
  type ExecutionStatus,
  executionStatus,
  type IgnexExecution,
  implFor,
  initNative,
  isNativeAvailable,
  type NativeRoute,
  type NativeRouteFrame,
  type NativeRoutePlan,
  type NativeRouteRunResult,
  type OpDecision,
  type OpName,
  SELECTION,
  useNative,
} from "@ignex/native";
// ── FP toolkit (shared) ─────────────────────────────────────────
export {
  always,
  compose,
  err,
  flatMapResult,
  identity,
  isErr,
  isOk,
  mapErr,
  mapResult,
  ok,
  pipe,
  type Result,
  type Task,
  taskChain,
  taskFromResult,
  taskMap,
  tryCatch,
  tryCatchAsync,
  tryCatchOr,
  unwrapOr,
  unwrapOrElse,
} from "@ignex/shared";
// ── client / openapi (consumer-facing) ──────────────────────────
export type { ClientOptions, ClientResponse, IgnexClient } from "./client";
export { createClient } from "./client";
// ── content ─────────────────────────────────────────────────────
export type { Catalog, Catalogs, I18n, I18nOptions, LoadCatalogDirOptions } from "./content/i18n";
export {
  createI18n,
  createI18nFromDir,
  formatCurrency,
  formatDate,
  formatNumber,
  interpolate,
  LOCALE_KEY,
  loadCatalogDir,
  negotiateLocale,
  pluralCategory,
  withI18n,
} from "./content/i18n";
export type { TemplateContext, TemplateFn, TemplateRegistry } from "./content/template";
export {
  createTemplate,
  createTemplateDir,
  createTemplateRegistry,
  renderTemplate,
  withLayout,
} from "./content/template";
export type {
  HttpResponseCacheOptions,
  HttpResponseCacheStore,
} from "./data/cache";
// ── data ────────────────────────────────────────────────────────
export {
  cacheControl,
  entityTag,
  HttpResponseCache,
  parseCacheControl,
  withBrowserCache,
} from "./data/cache";
export { etagWithEncoding, isCompressible, negotiateEncoding } from "./data/content-encoding";
export type {
  BatchLoadFn,
  DataLoader,
  DataLoaderFactory,
  DataLoaderOptions,
} from "./data/dataloader";
export { createDataLoader } from "./data/dataloader";
export {
  createDriverManager,
  type DriverFactory,
  type DriverManager,
  type DriverManagerOptions,
} from "./data/drivers/manager";
export { LRUCache } from "./data/lru";
export {
  groupQueryPairs,
  NativeQueryParams,
  parseQuery,
  parseQueryFromURL,
} from "./data/query";
export type { RateLimitAlgorithm } from "./data/ratelimit";
export { compileValidator, validateAsync, validateOrThrow } from "./data/schema";
export {
  createFileStore,
  createMemoryStore,
  createSqliteStore,
  createStoreManager,
  type FileStoreOptions,
  type MaybePromise,
  type MemoryStoreOptions,
  type SqliteStoreOptions,
  type Store,
  type StoreManagerOptions,
  type StoreSetOptions,
} from "./data/store";
export { validateEmail, validateIpv4, validateIpv6, validateUuid } from "./data/validation";
export {
  debugCache,
  debugError,
  debugEvent,
  debugQuery,
  debugSpan,
} from "./debug/api";
export { TraceStore } from "./debug/store";
export { SystemProfiler } from "./debug/system";
export {
  currentTrace,
  isTracingEnabled,
} from "./debug/tracer";
// ── debug (developer dashboard primitives) ──────────────────────
export type {
  DebugApi,
  DebugSpanHandle,
  RequestTrace,
  Span,
  SpanAttrs,
  SpanKind,
  SystemSample,
  SystemStats,
} from "./debug/types";
// ── http ────────────────────────────────────────────────────────
export type { LazyBody, LazyBodyOptions } from "./http/body";
export { BodyParseError, createLazyBody } from "./http/body";
export type { ContextOptions, IgnexContext, IgnexServer } from "./http/context";
export { createContext } from "./http/context";
export {
  Cookie,
  cookiePairsToRecord,
  createCookieJar,
  createLazyCookieJar,
  parseCookieString,
  serializeCookie,
} from "./http/cookies";
export { safeJoin, sendFile, streamDownload } from "./http/files";
export {
  finalizeResponse,
  htmlReply,
  jsonReply,
  type StatusSerializerMap,
  textReply,
  withBody,
} from "./http/finalize";
export type { SetHeaders } from "./http/headers";
export { applySet, mutateHeaders } from "./http/headers";
export { forwardRequest, proxyRequest } from "./http/proxy";
export {
  createRouter,
  type IgnexRouter,
  type RouteRegistration,
  type RouterMethod,
} from "./http/router";
export { formatSSE, type SSEMessage, type SSEOptions, sse } from "./http/sse";
export {
  DEV_CERT_FILENAMES,
  type DevCert,
  type DevCertKind,
  defaultCertDir,
  ensureDevCerts,
  type ResolvedTls,
  type ResolveTlsOptions,
  resolveServeTls,
  type ServerProtocolConfig,
  type ServerTlsConfig,
} from "./http/tls";
export {
  createWSConnections,
  createWSHandler,
  IgnexWS,
  upgradeWS,
  type WSConnections,
  type WSUpgradeOptions,
} from "./http/ws";
// ── lifecycle ───────────────────────────────────────────────────
export type { HookFn, HookResult } from "./lifecycle/hooks";
export {
  composeHooks,
  continueHook,
  executeHooks,
  haltHook,
  mergeHookArrays,
  mergeLifeCycle,
} from "./lifecycle/hooks";
export type { AppOptions, IgnexApp, ServeOptions } from "./lifecycle/lifecycle";
export {
  buildPostStages,
  buildPreStages,
  createApp,
  POST_HANDLER_STAGES,
  PRE_HANDLER_STAGES,
  runHooks,
  runLifecycle,
} from "./lifecycle/lifecycle";
export type { IgnexPlugin, PluginContext } from "./lifecycle/plugin";
export {
  composePlugins,
  createPluginContext,
  hookToPlugin,
  pluginContextToLifecycle,
  pluginsToLifeCycle,
} from "./lifecycle/plugin";
export { generateOpenAPI } from "./openapi";
// ── platform ────────────────────────────────────────────────────
export type { Config, ConfigField, ConfigFieldType, ConfigSchema } from "./platform/config";
export { defineConfig } from "./platform/config";
export { env, envBool, envFloat, envInt, envJson, envSecret, loadEnv } from "./platform/env";
export type {
  DefineEnvOptions,
  EnvIssue,
  EnvIssueCode,
  EnvIssueSeverity,
  EnvResult,
  EnvSource,
  ValidateEnvOptions,
} from "./platform/env-config";
export {
  defineEnv,
  EnvError,
  EnvIssueCodes,
  envExampleFromSchema,
  validateEnv,
} from "./platform/env-config";
export {
  BadRequestError,
  ConflictError,
  errorToResponse,
  ForbiddenError,
  HTTPError,
  InternalError,
  InvalidCookieSignature,
  isHttpError,
  MethodNotAllowedError,
  NotFoundError,
  ParseError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "./platform/errors";
export type { Job, JobQueue, JobQueueOptions, ScheduleOptions } from "./platform/jobs";
export { createJobQueue, withRetry, withTimeout } from "./platform/jobs";
export type {
  DurableJobQueue,
  DurableJobQueueOptions,
  DurableJobSpec,
  JobHandler,
} from "./platform/jobs-durable";
export { createDurableJobQueue } from "./platform/jobs-durable";
export type { JobStatus, JobStore, StoredJob } from "./platform/jobs-store";
export {
  createFileJobStore,
  createSqliteJobStore,
  createStoreJobStore,
  newJobId,
} from "./platform/jobs-store";
export { installProcessGuards } from "./platform/process-guards";
// ── plugins ─────────────────────────────────────────────────────
export {
  auth,
  authGuard,
  basicAuthPlugin,
  bearerAuthPlugin,
  jwtAuthPlugin,
  optionalAuthPlugin,
} from "./plugins/auth";
export type { AuthMode, AuthModule, AuthModuleOptions } from "./plugins/auth-module";
export { authModule, createAuthModule } from "./plugins/auth-module";
export { type CompressionOptions, compression } from "./plugins/compression";
export { type CorsOptions, cors } from "./plugins/cors";
export { csrf } from "./plugins/csrf";
export { type DebugbarOptions, debugbar } from "./plugins/debugbar";
export { type LoggerOptions, logger } from "./plugins/logger";
export { type NativePreflightOptions, nativePreflight } from "./plugins/native";
export { type OpenAPIOptions, type OpenAPIProvider, openapi } from "./plugins/openapi";
export type { RateLimitOptions, RateLimitStore } from "./plugins/ratelimit";
export { rateLimit } from "./plugins/ratelimit";
export type { RbacOptions, RouteGuards } from "./plugins/rbac";
export {
  authorize,
  can,
  canAll,
  createRbac,
  getPermissions,
  getRoles,
  guardChain,
  hasRole,
  permissionMatches,
  requireAuthenticated,
  withGuards,
} from "./plugins/rbac";
export { type SecurityOptions, security } from "./plugins/security";
export { type SessionPluginOptions, session } from "./plugins/session";
// ── security ────────────────────────────────────────────────────
export type { AuthUser, JwtAuthOptions } from "./security/auth";
export {
  basicAuth,
  bearerAuth,
  forbidden,
  getUser,
  jwtAuth,
  optionalAuth,
  requireAuth,
  setUser,
  USER_KEY,
  unauthorized,
} from "./security/auth";
export type {
  CookieSigner,
  Csrf,
  Ed25519JwtOptions,
  Ed25519JwtService,
  JwtService,
  JwtServiceOptions,
  PasswordHasher,
} from "./security/crypto";
export {
  aeadDecrypt,
  aeadEncrypt,
  createAead,
  createCookieSigner,
  createCsrf,
  createEd25519Jwt,
  createJwt,
  createPasswordHasher,
  csrfToken,
  csrfVerify,
  hmacSha256,
  hmacSha256Verify,
  jwtSign,
  jwtVerify,
  passwordHash,
  passwordVerify,
  randomToken,
  signCookie,
  verifyCookie,
} from "./security/crypto";
export type { CsrfGuardOptions } from "./security/csrf";
export { createCsrfGuard } from "./security/csrf";
export type {
  Session,
  SessionManager,
  SessionManagerOptions,
  SessionStore,
  SessionStoreOptions,
} from "./security/session";
export {
  createMemorySessionStore,
  createSessionManager,
  createSessionStoreFromStore,
  createSqliteSessionStore,
  getSession,
  withSession,
} from "./security/session";

// ── types ───────────────────────────────────────────────────────
export type {
  AnySchema,
  ContextUsage,
  CookieOptions,
  HookContainer,
  HttpMethod,
  LifeCycleStore,
  RouteSchema,
  ServerWebSocket,
  StandardSchemaV1,
  Static,
  TSchema,
  WebSocketHandler,
} from "./types";
export { EMPTY_LIFECYCLE, EMPTY_USAGE, FULL_USAGE, HTTP_METHODS } from "./types";
