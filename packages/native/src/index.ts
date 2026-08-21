/**
 * `@ignex/native` — Rust-accelerated primitives with pure-TS fallbacks.
 *
 * Every function prefers the `castrum` NAPI addon when it is installed and
 * loadable, and otherwise falls back to a byte-compatible pure-TS
 * implementation. Importing this package NEVER throws — native is a pure
 * acceleration layer. Check {@link isNativeAvailable} for observability.
 *
 * Prefer the unified execution API for new consumers: {@link backend} groups
 * every operation by domain and binds each to its fastest implementation per
 * the selection table (`selection.ts` — the single source of truth for which
 * impl wins). The flat named exports below remain the parity-testable surface
 * (each still consults the same table).
 */

export {
  aeadDecrypt,
  aeadDecryptFallback,
  aeadEncrypt,
  aeadEncryptFallback,
  csrfToken,
  csrfTokenFallback,
  csrfVerify,
  csrfVerifyFallback,
  hmacSha256,
  hmacSha256Verify,
  type JwtSignOptions,
  type JwtVerifyOptions,
  jwtSign,
  jwtSignFallback,
  jwtVerify,
  jwtVerifyFallback,
  type PasswordHashOptions,
  passwordHash,
  passwordHashFallback,
  passwordVerify,
  passwordVerifyFallback,
  randomToken,
  randomTokenFallback,
  signCookie,
  signCookieFallback,
  verifyCookie,
  verifyCookieFallback,
} from "./crypto";
// ── Ed25519 / EdDSA JWT (RBAC auth) ─────────────────────────────
export {
  type Ed25519Keypair,
  type EdDsaJwtSignOptions,
  type EdDsaJwtVerifyOptions,
  ed25519Sign,
  ed25519SignFallback,
  ed25519Verify,
  ed25519VerifyFallback,
  generateEd25519Keypair,
  generateEd25519KeypairFallback,
  jwtSignEdDsa,
  jwtSignEdDsaFallback,
  jwtVerifyEdDsa,
  jwtVerifyEdDsaFallback,
} from "./ed25519";
// ── unified execution API ───────────────────────────────────────
export {
  backend,
  createExecutionBackend,
  type ExecutionOpStatus,
  type ExecutionStatus,
  executionStatus,
  type IgnexExecution,
  implFor,
} from "./execution";
export {
  type FfiMode,
  type FfiRouteSurface,
  type FfiSurface,
  getFfi,
  getFfiMode,
  getFfiRoute,
  isFfiActive,
} from "./ffi";
export {
  type FfiBuf,
  ffiBuf,
  ffiString,
  ffiU32,
  ffiU64,
  isFfiReadAvailable,
  readString,
  readU32,
  readU64,
} from "./ffi-read";
export { crc32, fnv1a64, fnv1a64Fallback, fnv1a64String } from "./hash";
export {
  type AcceptNegotiator,
  type ConditionalRequest,
  cookiePairs,
  cookiePairsFallback,
  createAcceptNegotiator,
  createAcceptNegotiatorFallback,
  createConditionalRequest,
  createConditionalRequestFallback,
  type EncodingPrefResult,
  etag,
  etagFallback,
  formPairs,
  formPairsFallback,
  type MediaTypeResult,
  type MultipartLimits,
  type MultipartPart,
  mediaTypeMatches,
  multipartParse,
  multipartParseFallback,
  type Pairs,
  parseAcceptEncoding,
  parseAcceptEncodingFallback,
  parseCookie,
  parseForm,
  parseMediaType,
  parseMediaTypeFallback,
  parseQuery,
  queryPairs,
  queryPairsFallback,
} from "./http";
export {
  buildIngressHeaderPlan,
  type CreateNativeIngressRouterOptions,
  createNativeIngress,
  createNativeIngressRouter,
  type IngressHeaderPlan,
  type NativeIngress,
  type NativeIngressRouter,
  type NativeIngressRouterRoute,
  type NativeIngressRuntime,
} from "./ingress";
export {
  createSchemaValidator,
  jsonPatch,
  jsonPatchFallback,
  jsonValid,
  type SchemaValidator,
} from "./json";
export {
  getNative,
  initNative,
  isNativeAvailable,
  type NativeAddon,
  type NativeInitOptions,
  type NativeInitResult,
} from "./loader";
export {
  type NativeRouteHandlerOptions,
  type NativeRouteResponder,
  type NativeRouteSnapshot,
  nativeRouteHandler,
} from "./native-handler";
export { packBatch, pairsToObject, readPairsPacked } from "./packed";
export {
  brotliCompress,
  brotliDecompress,
  gzipCompress,
  gzipDecompress,
  sseEncode,
  sseEncodeFallback,
  type WsFrame,
  wsAcceptKey,
  wsFrameDecode,
  wsFrameDecodeFallback,
  wsFrameEncode,
  wsFrameEncodeFallback,
} from "./payload";
export {
  createNativePipeline,
  type NativeCorsOptions,
  type NativeIngressOptions,
  type NativePipeline,
  type NativePipelineOptions,
  type NativePreflightOutcome,
  type NativePreflightResult,
  type NativeRateLimitOptions,
} from "./pipeline";
export {
  createRateLimiter,
  createRateLimiterFallback,
  type RateCheck,
  type RateLimiter,
  type RateLimiterOptions,
} from "./ratelimit";
export {
  createNativeRoute,
  type NativeRoute,
  type NativeRouteFrame,
  type NativeRoutePlan,
  type NativeRouteRunResult,
} from "./route";
export {
  type DecodedRouteDescriptor,
  decodeRouteDescriptor,
  encodeRouteDescriptor,
  type NativeRouteStage,
  packRouteFrame,
  packRouteFrameInto,
  packRouteFrameLength,
  packRouteFramePartsInto,
  packRouteFramePartsLength,
  planHasStage,
  ROUTE_DESC_MAGIC,
  ROUTE_DESC_VERSION,
  ROUTE_FRAME_FLAG_HAS_BODY,
  ROUTE_RESULT_FLAG_BODY_VALID,
  ROUTE_RESULT_FLAG_BODY_VALID_JSON,
  ROUTE_RESULT_FLAG_COOKIE_VALID,
  ROUTE_RESULT_FLAG_HEADERS_VALID,
  ROUTE_RESULT_FLAG_OK,
  ROUTE_RESULT_FLAG_PARAMS_VALID,
  ROUTE_RESULT_FLAG_QUERY_VALID,
  ROUTE_STAGE_TAG,
  type RoutePartKind,
  readRouteResult,
} from "./route-wire";
export { backendName, useNative } from "./runtime";
export {
  acquire,
  copyView,
  MAX_POOLED_BYTES,
  MAX_SCRATCH_BYTES,
  poolStats,
  release,
  withScratch,
} from "./scratch";
export { type ExecutionBackend, OPS, type OpDecision, type OpName, SELECTION } from "./selection";
export { createTemplate, renderTemplate, renderTemplateFallback } from "./template";
export { decoder, encoder, fromBytes, toBytes } from "./util";
export {
  validateEmail,
  validateEmailFallback,
  validateIpv4,
  validateIpv4Fallback,
  validateIpv6,
  validateIpv6Fallback,
  validateUuid,
  validateUuidFallback,
} from "./validation";
