/**
 * @fileoverview Flux Core — public entry.
 *
 * This barrel is the single public surface of `@flux/core`. Internally the
 * implementation is grouped by use case into domain folders so each concern
 * stays small and discoverable:
 *
 *   security/   — auth, csrf, crypto, session        (request security & trust)
 *   http/       — context, body, proxy, files, sse, ws, route DSL
 *   data/       — cache, dataloader, lru, query, schema, validation
 *   lifecycle/  — hooks, lifecycle, guard, plugin, macro, derive
 *   platform/   — env, config, trace, cluster, jobs, errors
 *   content/    — i18n, template
 *   plugins/    — ready-made FluxPlugin factories
 *
 * Consumers import everything from `@flux/core` (or `@flux/core/http` for the
 * route DSL) — the folder layout is an internal implementation detail.
 */

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
} from "@flux/shared";
// ── client / openapi (consumer-facing) ──────────────────────────
export type { ClientOptions, ClientResponse, FluxClient } from "./client";
export { createClient } from "./client";
// ── content ─────────────────────────────────────────────────────
export type { Catalog, Catalogs, I18n, I18nOptions } from "./content/i18n";
export { createI18n, interpolate, negotiateLocale } from "./content/i18n";
export type { TemplateContext, TemplateFn, TemplateRegistry } from "./content/template";
export {
  createTemplate,
  createTemplateDir,
  createTemplateRegistry,
  renderTemplate,
  withLayout,
} from "./content/template";
// ── data ────────────────────────────────────────────────────────
export { cacheControl, entityTag, HttpResponseCache, withBrowserCache } from "./data/cache";
export type {
  BatchLoadFn,
  DataLoader,
  DataLoaderFactory,
  DataLoaderOptions,
} from "./data/dataloader";
export { createDataLoader } from "./data/dataloader";
export { LRUCache } from "./data/lru";
export { parseQuery, parseQueryFromURL } from "./data/query";
export { compileValidator, validateAsync, validateOrThrow } from "./data/schema";
export { validateEmail, validateIpv4, validateIpv6, validateUuid } from "./data/validation";
// ── http ────────────────────────────────────────────────────────
export type { LazyBody, LazyBodyOptions } from "./http/body";
export { BodyParseError, createLazyBody } from "./http/body";
export type { ContextOptions, FluxContext, FluxServer } from "./http/context";
export { createContext } from "./http/context";
export { Cookie, createCookieJar, parseCookieString, serializeCookie } from "./http/cookies";
export { safeJoin, sendFile, streamDownload } from "./http/files";
export type { SetHeaders } from "./http/headers";
export { applySet } from "./http/headers";
export { forwardRequest, proxyRequest } from "./http/proxy";
export { formatSSE, sse, sseFromStream } from "./http/sse";
export { acceptWsKey, createWSHandler, FluxWS } from "./http/ws";
export {
  createDerivePipeline,
  createResolvePipeline,
  deriveDb,
  deriveUser,
} from "./lifecycle/derive";
export { createGuard, mergeLifeCycle } from "./lifecycle/guard";

// ── lifecycle ───────────────────────────────────────────────────
export type { HookFn, HookResult } from "./lifecycle/hooks";
export {
  composeHooks,
  continueHook,
  executeHooks,
  haltHook,
  mergeHookArrays,
} from "./lifecycle/hooks";
export type { AppOptions, FluxApp } from "./lifecycle/lifecycle";
export {
  buildPostStages,
  buildPreStages,
  createApp,
  POST_HANDLER_STAGES,
  PRE_HANDLER_STAGES,
  runHooks,
  runLifecycle,
} from "./lifecycle/lifecycle";
export {
  authMacro,
  cacheMacro,
  createMacroRegistry,
  csrfMacro,
  jwtMacro,
  sessionMacro,
} from "./lifecycle/macro";
export type { FluxPlugin, PluginContext } from "./lifecycle/plugin";
export {
  composePlugins,
  createPluginContext,
  pluginContextToLifecycle,
  pluginsToLifeCycle,
} from "./lifecycle/plugin";
export { generateOpenAPI } from "./openapi";
// ── platform ────────────────────────────────────────────────────
export { serveCluster } from "./platform/cluster";
export type { Config, ConfigField, ConfigFieldType, ConfigSchema } from "./platform/config";
export { defineConfig } from "./platform/config";
export { env, envBool, envFloat, envInt, envJson, envSecret, loadEnv } from "./platform/env";
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
  StatusMap,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "./platform/errors";
export type { Job, JobQueue, JobQueueOptions, ScheduleOptions } from "./platform/jobs";
export { createJobQueue, withRetry, withTimeout } from "./platform/jobs";
export { createTraceContext, finishTrace, startTrace } from "./platform/trace";
// ── plugins ─────────────────────────────────────────────────────
export {
  auth,
  authGuard,
  basicAuthPlugin,
  bearerAuthPlugin,
  jwtAuthPlugin,
  optionalAuthPlugin,
} from "./plugins/auth";
export { compression } from "./plugins/compression";
export { cors } from "./plugins/cors";
export { csrf } from "./plugins/csrf";
export { logger } from "./plugins/logger";
export { rateLimit } from "./plugins/ratelimit";
export { security } from "./plugins/security";
export { session } from "./plugins/session";
// ── security ────────────────────────────────────────────────────
export type { AuthUser, JwtAuthOptions } from "./security/auth";
export {
  basicAuth,
  bearerAuth,
  getUser,
  jwtAuth,
  optionalAuth,
  requireAuth,
  setUser,
  tokenAuth,
  USER_KEY,
  unauthorized,
} from "./security/auth";
export type {
  CookieSigner,
  Csrf,
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
} from "./security/session";
export {
  createMemorySessionStore,
  createSessionManager,
  getSession,
  withSession,
} from "./security/session";

// ── types ───────────────────────────────────────────────────────
export type {
  AnySchema,
  ContextUsage,
  CookieOptions,
  DefinitionBase,
  HookContainer,
  HttpMethod,
  InputSchema,
  LifeCycleStore,
  RouteSchema,
  ServerWebSocket,
  SingletonBase,
  StandardSchemaV1,
  Static,
  TSchema,
  WebSocketHandler,
} from "./types";
export { EMPTY_LIFECYCLE, EMPTY_USAGE, FULL_USAGE, HTTP_METHODS } from "./types";
