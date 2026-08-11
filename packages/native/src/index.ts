/**
 * `@flux/native` — Rust-accelerated primitives with pure-TS fallbacks.
 *
 * Every function prefers the `castrum` NAPI addon when it is installed and
 * loadable, and otherwise falls back to a byte-compatible pure-TS
 * implementation. Importing this package NEVER throws — native is a pure
 * acceleration layer. Check {@link isNativeAvailable} for observability.
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
  passwordVerify,
  randomToken,
  randomTokenFallback,
  signCookie,
  signCookieFallback,
  verifyCookie,
  verifyCookieFallback,
} from "./crypto";
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
  type NativePipeline,
  type NativePreflightOutcome,
  type NativePreflightResult,
} from "./pipeline";
export {
  createRateLimiter,
  createRateLimiterFallback,
  type RateCheck,
  type RateLimiter,
  type RateLimiterOptions,
} from "./ratelimit";
export { createTemplate, renderTemplate, renderTemplateFallback } from "./template";
export { decoder, encoder, fromBytes, toBytes } from "./util";
export { validateEmail, validateIpv4, validateIpv6, validateUuid } from "./validation";
