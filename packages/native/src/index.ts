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

export { batch, type NativeBatch } from "./batch";
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
export { backendName, useNative } from "./runtime";
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
