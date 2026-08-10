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
  cookiePairs,
  cookiePairsFallback,
  type EncodingPrefResult,
  etag,
  etagFallback,
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
  parseMediaType,
  parseMediaTypeFallback,
  parseQuery,
  queryPairs,
  queryPairsFallback,
} from "./http";
export { jsonPatch, jsonPatchFallback, jsonValid } from "./json";
export { getNative, isNativeAvailable, type NativeAddon } from "./loader";
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
export { createTemplate, renderTemplate, renderTemplateFallback } from "./template";
export { decoder, encoder, fromBytes, toBytes } from "./util";
export { validateEmail, validateIpv4, validateIpv6, validateUuid } from "./validation";
