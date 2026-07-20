/**
 * @fileoverview Flux Core v3.0 — Main Entry
 * Feature-complete, optimized Elysia alternative.
 */

// Core
export { createContext, Cookie, createCookieJar, serializeCookie, parseCookieString } from "./context";
export type { FluxContext, ContextOptions, SetHeaders } from "./context";

// Body
export { createLazyBody, BodyParseError } from "./body";
export type { LazyBody, LazyBodyOptions } from "./body";

// Errors
export {
  HTTPError, ValidationError, NotFoundError, UnauthorizedError,
  ForbiddenError, ConflictError, TooManyRequestsError, InternalError,
  ParseError, InvalidCookieSignature, errorToResponse, StatusMap,
} from "./errors";

// Hooks
export { executeHooks, composeHooks, continueHook, haltHook, mergeHookArrays, isAsyncFn } from "./hooks";
export type { HookFn, HookResult } from "./hooks";

// Plugin
export { createPluginContext, composePlugins } from "./plugin";
export type { FluxPlugin, PluginContext } from "./plugin";

// Plugins
export { cors } from "./plugins/cors";
export { rateLimit } from "./plugins/ratelimit";
export { security } from "./plugins/security";
export { compression } from "./plugins/compression";
export { logger } from "./plugins/logger";

// Guard & Macro
export { createGuard, mergeLifeCycle } from "./guard";
export { createMacroRegistry, authMacro, cacheMacro } from "./macro";

// Derive & Resolve
export { createDerivePipeline, createResolvePipeline, deriveUser, deriveDb } from "./derive";

// SSE & WS
export { sse, sseFromStream, formatSSE } from "./sse";
export { FluxWS, createWSHandler } from "./ws";

// Trace
export { createTraceContext, startTrace, finishTrace } from "./trace";

// Query
export { parseQuery, parseQueryFromURL } from "./query";

// OpenAPI
export { generateOpenAPI } from "./openapi";

// Cache
export { HttpResponseCache, cacheControl, entityTag, withBrowserCache } from "./cache";

// Files
export { sendFile, safeJoin, streamDownload } from "./files";

// Proxy
export { proxyRequest, forwardRequest } from "./proxy";

// LRU
export { LRUCache } from "./lru";

// Cluster
export { serveCluster } from "./cluster";

// FP
export * from "../compiler/fp";

// Types
export type {
  HttpMethod, RouteSchema, InputSchema, ContextUsage,
  CompilerOptions, CookieOptions, WebSocketHandler, ServerWebSocket,
  LifeCycleStore, HookContainer, SingletonBase, DefinitionBase,
  StandardSchemaV1, TSchema, AnySchema, Static,
} from "./types";
export { HTTP_METHODS, DEFAULT_OPTS, EMPTY_USAGE, FULL_USAGE, EMPTY_LIFECYCLE } from "./types";