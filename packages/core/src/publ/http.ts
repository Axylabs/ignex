/**
 * @fileoverview Public sub-barrel: the http surface (context, body, proxy,
 * files, sse, ws, route DSL, tls, uploads, …) re-exported from the
 * `@ignex/core` entry (split from the barrel `src/index.ts` by section banner —
 * move-only; `export` statements verbatim).
 */

// ── http ────────────────────────────────────────────────────────
// Value export: the AOT-generated route core fn hoists `abortedResponse()`
// into a module constant and the interpreted lifecycle calls it for a
// pre-aborted request, so it must be reachable from the entry.
export { abortedResponse } from "../http/abort";
export type { LazyBody, LazyBodyOptions } from "../http/body";
export { BodyParseError, createLazyBody, readBodyBounded } from "../http/body";
export type { ContextOptions, IgnexContext, IgnexServer } from "../http/context";
// Value export: generated route code emits `path: pathnameOf(req.url)` for the
// usage-specialized context, so it must be reachable from the package entry.
export { createContext, pathnameOf, resolveClientIp } from "../http/context";
export {
  Cookie,
  cookiePairsToRecord,
  createCookieJar,
  createLazyCookieJar,
  parseCookieString,
  readRequestCookie,
  serializeCookie,
} from "../http/cookies";
export { safeJoin, sendFile, streamDownload } from "../http/files";
export {
  finalizeResponse,
  htmlReply,
  isDecoratedResponse,
  jsonReply,
  markDecoratedResponse,
  type StatusSerializerMap,
  textReply,
  withBody,
} from "../http/finalize";
export type { SetHeaders } from "../http/headers";
export { applySet, headersToRecord, mutateHeaders } from "../http/headers";
export { forwardRequest, proxyRequest } from "../http/proxy";
export {
  assertSafeRedirectTarget,
  checkRedirectTarget,
  type RedirectGuardOptions,
  type RedirectTarget,
  UnsafeRedirectError,
} from "../http/redirect-guard";
// Value export: the usage-specialized context emits `requestId:
// generateRequestId()` so a route that reads `ctx.requestId` can stay on the
// fast tier, and it must be the SAME generator the full context uses.
export { generateRequestId } from "../http/request-id";
export {
  createRouter,
  type IgnexRouter,
  type RouteRegistration,
  type RouterMethod,
} from "../http/router";
export {
  bootOrigin,
  getServeBootInfo,
  type ServeBootInfo,
  setServeBootInfo,
} from "../http/serve-boot";
export { formatSSE, type SSEMessage, type SSEOptions, sse } from "../http/sse";
export {
  type ServeStaticAppOptions,
  serveStaticApp,
} from "../http/static-app";
export {
  DEFAULT_SERVER_IDLE_TIMEOUT,
  DEV_CERT_FILENAMES,
  type DevCert,
  type DevCertKind,
  defaultCertDir,
  ensureDevCerts,
  type ResolvedTls,
  type ResolveTlsOptions,
  resolveServeTls,
  type ServerConfig,
  type ServerProtocolConfig,
  type ServerTlsConfig,
} from "../http/tls";
export { type TrustedHostOptions, trustedHost } from "../http/trusted-host";
export {
  DEFAULT_UPLOAD_TYPES,
  type SavedUpload,
  type SaveUploadOptions,
  type ServeUploadOptions,
  sanitizeFileName,
  saveUpload,
  serveUpload,
  type UploadRejection,
  type UploadSuccess,
  type UploadTypes,
} from "../http/uploads";
export {
  createWSConnections,
  createWSHandler,
  DEFAULT_MAX_INFLIGHT_MESSAGES,
  IgnexWS,
  mergeWSLimits,
  upgradeWS,
  WS_INFLIGHT_LIMIT_CODE,
  WS_INFLIGHT_LIMIT_REASON,
  type WSConnections,
  type WSHandlerOptions,
  type WSLimits,
  type WSLocalHook,
  type WSUpgradeOptions,
} from "../http/ws";
