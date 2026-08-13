/**
 * Ambient type surface for the `castrum` NAPI addon.
 *
 * This is the SUB-SET of castrum's generated `index.d.ts` that ignex uses.
 * It is mapped through the root tsconfig `paths` (`"castrum": [...]`), so
 * TypeScript resolves the module even when the addon isn't installed; at
 * runtime the loader resolves the real package (native) or falls back to
 * the pure-TS implementations. Keeping a trimmed, hand-maintained surface
 * here avoids shipping the full generated `index.d.ts` and makes the exact
 * native contract we rely on explicit.
 *
 * Note: byte parameters/returns are declared as `Uint8Array` even though
 * the real addon returns Node `Buffer`s (a `Buffer` IS a `Uint8Array`), so
 * the wrappers never need casts.
 */

export declare class TemplateRenderer {
  constructor(source: string);
  render(context: any): Uint8Array;
}

/**
 * Benchmark-driven native-vs-TS decision, OWNED BY CASTRUM (generated from
 * `scripts/select-native.ts --write` into `src/selection.json`, embedded in
 * the addon). Consumers read this ONCE at load time and bind each op to a
 * fixed implementation — never swapping native↔js at runtime.
 * Returns `"native"` | `"js"` | `null`.
 */
export declare function opImpl(op: string): "native" | "js" | null;

export interface EncodingPrefResult {
  encoding: string;
  q: number;
  order: number;
}

export interface MediaTypeResult {
  mediaType: string;
  charset?: string;
  boundary?: string;
  params: Record<string, string>;
}

export interface MultipartLimitsInput {
  maxParts?: number;
  maxFieldCount?: number;
  maxPartBytes?: number;
  maxTotalBytes?: number;
}

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
}

export interface PasswordHashOptions {
  mCost?: number;
  tCost?: number;
  pCost?: number;
  outLen?: number;
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

export interface RateCheck {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

/** Sharded fixed-window per-key rate limiter (native). */
export declare class RateLimiter {
  constructor(limit: number, windowMs: number, maxEntries?: number | null);
  check(key: string, nowMs: number): RateCheck;
  checkKey(key: number, nowMs: number): RateCheck;
}

export declare function fnv1a64(input: Uint8Array): bigint;
export declare function crc32(input: Uint8Array): number;
/** Initialize the rayon worker pool (honored only before first pool use). */
export declare function initThreadPool(threads: number): number;
/** Current rayon worker count (0 until the pool initializes). */
export declare function rayonNumThreads(): number;
export declare function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
export declare function hmacSha256Verify(
  key: Uint8Array,
  data: Uint8Array,
  sig: Uint8Array,
): boolean;
export declare function signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array;
export declare function verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | null;
export declare function csrfToken(secret: Uint8Array): Uint8Array;
export declare function csrfVerify(token: Uint8Array, secret: Uint8Array): boolean;
export declare function jwtSign(
  claims: any,
  secret: Uint8Array,
  ttlSeconds: number | null,
  nowSeconds: number,
): Uint8Array;
export declare function jwtVerify(token: Uint8Array, secret: Uint8Array, nowSeconds: number): any;
export declare function randomToken(byteLen: number): Uint8Array;
export declare function passwordHash(
  password: Uint8Array,
  salt: Uint8Array,
  options?: PasswordHashOptions | null,
): Uint8Array;
export declare function passwordVerify(password: Uint8Array, phc: Uint8Array): boolean;
export declare function aeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  algorithm?: string | null,
): Uint8Array;
export declare function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  algorithm?: string | null,
): Uint8Array | null;
export declare function queryParsePacked(input: Uint8Array): Uint8Array;
export declare function cookieParsePacked(input: Uint8Array): Uint8Array;
export declare function parseMediaType(input: Uint8Array): MediaTypeResult;
export declare function etag(input: Uint8Array, weak?: boolean | null): Uint8Array;
export declare function multipartParse(
  body: Uint8Array,
  boundary: Uint8Array,
  limits?: MultipartLimitsInput | null,
): Array<MultipartPart>;
export declare function parseAcceptEncoding(input: Uint8Array): Array<EncodingPrefResult>;
export declare function jsonValid(input: Uint8Array): boolean;
export declare function jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array;
export declare function gzipCompress(data: Uint8Array, level?: number | null): Uint8Array;
export declare function gzipDecompress(data: Uint8Array): Uint8Array;
export declare function brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array;
export declare function brotliDecompress(data: Uint8Array): Uint8Array;
export declare function sseEncodeEvent(
  event: string | null,
  data: Uint8Array,
  id?: string | null,
  retry?: number | null,
): Uint8Array;
export declare function wsFrameEncode(
  opcode: number,
  payload: Uint8Array,
  mask: boolean,
  fin: boolean,
): Uint8Array;
export declare function wsFrameDecode(data: Uint8Array): WsFrame | null;
export declare function wsAcceptKey(key: Uint8Array): Uint8Array;
export declare function validateEmail(input: Uint8Array): boolean;
export declare function validateUuid(input: Uint8Array): boolean;
export declare function validateIpv4(input: Uint8Array): boolean;
export declare function validateIpv6(input: Uint8Array): boolean;

// ── Packed BATCH entry points (one FFI call for many items) ─────
// Wire format for input: `[u32 count]{[u32 len][bytes]}`. Outputs:
//   bitset fns: `[u32 count][bitset bytes]` (bit i = item i valid)
//   crc32:      `[u32 count][u32 …]`
//   fnv1a64:    `[u32 count][i64 …]` (bit-identical to the u64 scalar)
export declare function validateEmailBatchPacked(input: Uint8Array): Uint8Array;
export declare function validateUuidBatchPacked(input: Uint8Array): Uint8Array;
export declare function validateIpv4BatchPacked(input: Uint8Array): Uint8Array;
export declare function validateIpv6BatchPacked(input: Uint8Array): Uint8Array;
export declare function jsonValidBatchPacked(input: Uint8Array): Uint8Array;
export declare function crc32BatchPacked(input: Uint8Array): Uint8Array;
export declare function fnv1A64BatchPacked(input: Uint8Array): Uint8Array;
// Pair-parse batches: output `[u32 item_count]{[u32 len][pairs_packed]}` where
// each `pairs_packed` = `[u32 pair_count]{[u32 name_len][name][u32 value_len]
// [value]}` (the same per-item layout the scalar `*ParsePacked` fns return).
export declare function queryParseBatchPacked(input: Uint8Array): Uint8Array;
export declare function cookieParseBatchPacked(input: Uint8Array): Uint8Array;
export declare function formParseBatchPacked(input: Uint8Array): Uint8Array;

// ── Compiled-once napi classes (the raw addon surface) ──────────

export declare class ConditionalRequest {
  constructor(etagValue: Uint8Array, lastModifiedSecs?: number | null);
  isNotModified(ifNoneMatch: Uint8Array | null, ifModifiedSince: Uint8Array | null): boolean;
}

export declare class AcceptNegotiator {
  constructor(supported: Array<string>);
  negotiate(header: Uint8Array): string | null;
}

export declare class FormParser {
  constructor(capacity?: number | null);
  parse(input: Uint8Array): Uint8Array;
  parseInto(input: Uint8Array, output: Uint8Array): number;
}

export declare class SchemaValidator {
  constructor(schemaBytes: Uint8Array);
  validate(input: Uint8Array): boolean;
  validateBatchPackedCount(packed: Uint8Array): number;
  validateBatchPackedBitset(packed: Uint8Array): Uint8Array;
  validateBatchStreaming(batchBytes: Uint8Array): number;
  /** One-pass validate + extract (see `@ignex/native` `JsonDeriveResult`). */
  derive(input: Uint8Array, paths: string[]): CastrumJsonDeriveResult | null;
}

/** Mirror of castrum's `JsonDeriveResult` napi object. */
export interface CastrumJsonDeriveValue {
  kind: string;
  int: number | null;
  number: number | null;
  text: string | null;
  boolean: boolean | null;
}

export interface CastrumJsonDeriveResult {
  ok: boolean;
  values: Array<CastrumJsonDeriveValue | null>;
}

export declare function formParsePacked(input: Uint8Array): Uint8Array;

/** Castrum ingress pipeline factory (TS-layer export — the "route manager" adapter). */
export declare function createPipeline(options?: unknown): unknown;
