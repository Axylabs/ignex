/**
 * @fileoverview Flux Core v3.0 — Main Entry
 * Feature-complete, optimized Elysia alternative.
 */

// FP
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
export type { AuthUser, JwtAuthOptions } from "./auth";
// Auth & Security
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
} from "./auth";
export type { LazyBody, LazyBodyOptions } from "./body";
// Body
export { BodyParseError, createLazyBody } from "./body";
// Cache
export { cacheControl, entityTag, HttpResponseCache, withBrowserCache } from "./cache";
export type { ClientOptions, ClientResponse, FluxClient } from "./client";
// Client
export { createClient } from "./client";
// Cluster
export { serveCluster } from "./cluster";
export type { Config, ConfigField, ConfigFieldType, ConfigSchema } from "./config";
export { defineConfig } from "./config";
export type { ContextOptions, FluxContext, FluxServer, SetHeaders } from "./context";
// Core
export {
  applySet,
  Cookie,
  createContext,
  createCookieJar,
  parseCookieString,
  serializeCookie,
} from "./context";
export type { CookieSigner, Csrf, JwtService, JwtServiceOptions, PasswordHasher } from "./crypto";
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
} from "./crypto";
export type { CsrfGuardOptions } from "./csrf";
// CSRF
export { createCsrfGuard } from "./csrf";
export type {
  BatchLoadFn,
  DataLoader,
  DataLoaderFactory,
  DataLoaderOptions,
} from "./dataloader";
// Derive & Resolve
export { createDataLoader } from "./dataloader";
export { createDerivePipeline, createResolvePipeline, deriveDb, deriveUser } from "./derive";
// Env & Config
export { env, envBool, envFloat, envInt, envJson, envSecret, loadEnv } from "./env";
// Errors
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
} from "./errors";
// Files
export { safeJoin, sendFile, streamDownload } from "./files";
// Guard & Macro
export { createGuard, mergeLifeCycle } from "./guard";
export type { HookFn, HookResult } from "./hooks";
// Hooks
export {
  composeHooks,
  continueHook,
  executeHooks,
  haltHook,
  mergeHookArrays,
} from "./hooks";
export type { Catalog, Catalogs, I18n, I18nOptions } from "./i18n";
// i18n
export { createI18n, interpolate, negotiateLocale } from "./i18n";
export type { Job, JobQueue, JobQueueOptions, ScheduleOptions } from "./jobs";
// Jobs
export { createJobQueue, withRetry, withTimeout } from "./jobs";
export type { AppOptions, FluxApp } from "./lifecycle";
// Lifecycle
export {
  buildPostStages,
  buildPreStages,
  createApp,
  POST_HANDLER_STAGES,
  PRE_HANDLER_STAGES,
  runHooks,
  runLifecycle,
} from "./lifecycle";
// LRU
export { LRUCache } from "./lru";
export {
  authMacro,
  cacheMacro,
  createMacroRegistry,
  csrfMacro,
  jwtMacro,
  sessionMacro,
} from "./macro";
// OpenAPI
export { generateOpenAPI } from "./openapi";
export type { FluxPlugin, PluginContext } from "./plugin";
// Plugin
export {
  composePlugins,
  createPluginContext,
  pluginContextToLifecycle,
  pluginsToLifeCycle,
} from "./plugin";
export {
  auth,
  authGuard,
  basicAuthPlugin,
  bearerAuthPlugin,
  jwtAuthPlugin,
  optionalAuthPlugin,
} from "./plugins/auth";
export { compression } from "./plugins/compression";
// Plugins
export { cors } from "./plugins/cors";
export { csrf } from "./plugins/csrf";
export { logger } from "./plugins/logger";
export { rateLimit } from "./plugins/ratelimit";
export { security } from "./plugins/security";
export { session } from "./plugins/session";
// Proxy
export { forwardRequest, proxyRequest } from "./proxy";
// Query
export { parseQuery, parseQueryFromURL } from "./query";
// Schema
export {
  compileValidator,
  validateAsync,
  validateOrThrow,
} from "./schema";
export type { Session, SessionManager, SessionManagerOptions, SessionStore } from "./session";
// Sessions
export {
  createMemorySessionStore,
  createSessionManager,
  getSession,
  withSession,
} from "./session";
// SSE & WS
export { formatSSE, sse, sseFromStream } from "./sse";
export type { TemplateContext, TemplateFn, TemplateRegistry } from "./template";
// Templates
export {
  createTemplate,
  createTemplateDir,
  createTemplateRegistry,
  renderTemplate,
  withLayout,
} from "./template";
// Trace
export { createTraceContext, finishTrace, startTrace } from "./trace";
// Types
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
// Validation
export { validateEmail, validateIpv4, validateIpv6, validateUuid } from "./validation";
export { acceptWsKey, createWSHandler, FluxWS } from "./ws";
