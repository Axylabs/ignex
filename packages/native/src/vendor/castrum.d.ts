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
  /** Opaque handle for the C-ABI instance fast path (`castrum_template_render`). */
  innerPtr(): bigint;
}

/**
 * The native ingress pipeline instance (the full 8-stage core: CORS, rate
 * limit, IP-trust, body guard, JSON schema). `createNativeIngress` constructs
 * it via the addon and drives the C-ABI `castrum_ingress_*` symbols through
 * `ingressInnerPtr()` (held alive for the handle's lifetime).
 */
export declare class Ingress {
  constructor(options: unknown);
  /** Opaque handle for the C-ABI ingress fast path (`castrum_ingress_handle_*`). */
  ingressInnerPtr(): bigint;
  handleRequestPacked(input: Uint8Array, body: Uint8Array | null, output: Uint8Array): number;
  handleRequestFullSync(input: Uint8Array, body: Uint8Array | null): Uint8Array;
  handleRequestFullSyncInto(input: Uint8Array, body: Uint8Array | null, output: Uint8Array): number;
}

/**
 * Per-route native stack (the route-wire v3 contract). Constructed from a
 * compiled route descriptor; `run` processes one packed request frame and
 * returns the packed verdict result bytes written (`0` = error / too-small,
 * `> output.length` = the exact required size — the growExact convention).
 * `bindNapiRoute` uses this as the Node/fallback transport behind
 * `createNativeRoute`.
 */
export declare class Route {
  constructor(descriptor: Uint8Array);
  run(frame: Uint8Array, output: Uint8Array): number;
  destroy?(): void;
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
/**
 * Sign from pre-serialized claim JSON bytes — avoids the napi
 * `serde_json::Value` DOM marshal of `jwtSign` for callers that already hold
 * the claim bytes (e.g. JSON.stringify'd on the JS side). Semantics are
 * identical (incl. `iat`/`exp` injection).
 */
export declare function jwtSignBytes(
  claimsJson: Uint8Array,
  secret: Uint8Array,
  ttlSeconds: number | null,
  nowSeconds: number,
): Uint8Array;
export declare function jwtVerify(token: Uint8Array, secret: Uint8Array, nowSeconds: number): any;

/** An Ed25519 keypair serialized for `.env` storage (base64url DER strings). */
export interface Ed25519Keypair {
  /** PKCS#8 v1 DER private key, base64url. */
  privateKey: string;
  /** SPKI DER public key, base64url. */
  publicKey: string;
}
/** Generate an Ed25519 keypair → `{ privateKey, publicKey }` (base64url DER). */
export declare function generateEd25519Keypair(): Ed25519Keypair;
/** Sign `msg` with an Ed25519 private key (PKCS#8 DER) → 64-byte signature. */
export declare function ed25519Sign(msg: Uint8Array, privateKey: Uint8Array): Uint8Array;
/** Verify a 64-byte Ed25519 signature with an SPKI DER (or raw) public key. */
export declare function ed25519Verify(
  msg: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean;
/**
 * Sign an EdDSA (Ed25519) compact JWT from pre-serialized claim JSON bytes —
 * the byte-path twin of `jwtSign` for the `alg: "EdDSA"` header (iat/exp
 * injection semantics are identical).
 */
export declare function jwtSignEddsa(
  claimsJson: Uint8Array,
  privateKey: Uint8Array,
  ttlSeconds: number | null,
  nowSeconds: number,
): Uint8Array;
/** Verify an EdDSA (Ed25519) JWT; returns the claims object or `null`. */
export declare function jwtVerifyEddsa(
  token: Uint8Array,
  publicKey: Uint8Array,
  nowSeconds: number,
): any;
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
// Crypto batches — byte-results (`[u32 count]{[u32 len][bytes]}`) or bitset
// (`[u32 count][bitset bytes]`) outputs, same wire as the scalar cores.
export declare function signCookieBatchPacked(input: Uint8Array, secret: Uint8Array): Uint8Array;
export declare function verifyCookieBatchPacked(input: Uint8Array, secret: Uint8Array): Uint8Array;
export declare function csrfVerifyBatchPacked(input: Uint8Array, secret: Uint8Array): Uint8Array;
export declare function hmacSha256BatchPacked(input: Uint8Array, key: Uint8Array): Uint8Array;
export declare function hmacSha256VerifyBatchPacked(
  input: Uint8Array,
  sigs: Uint8Array,
  key: Uint8Array,
): Uint8Array;

// ── Compiled-once napi classes (the raw addon surface) ──────────

export declare class ConditionalRequest {
  constructor(etagValue: Uint8Array, lastModifiedSecs?: number | null);
  isNotModified(ifNoneMatch: Uint8Array | null, ifModifiedSince: Uint8Array | null): boolean;
  /** Opaque handle for the C-ABI instance fast path (`castrum_conditional_is_not_modified`). */
  innerPtr(): bigint;
}

export declare class AcceptNegotiator {
  constructor(supported: Array<string>);
  negotiate(header: Uint8Array): string | null;
  /**
   * Best supported encoding with SERVER-preference tie-breaking (q-only; the
   * supported list's order decides ties — ignex `negotiateEncoding` semantic).
   * Empty header → `null` (identity). Absent on addons built before the
   * feature existed (the JS wrapper falls back to the pure-TS engine).
   */
  negotiateServerPreference(header: Uint8Array): string | null;
  /** Opaque handle for the C-ABI instance fast path (`castrum_accept_negotiator_negotiate`). */
  innerPtr(): bigint;
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
  /** Opaque handle for the C-ABI instance fast path (`castrum_schema_validator_validate`). */
  innerPtr(): bigint;
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

/** Sharded counters/gauges/histograms registry (castrum `metrics` domain). */
export declare class MetricsRegistry {
  constructor();
  counter(name: string, labelKeys?: string[] | null): number;
  gauge(name: string, labelKeys?: string[] | null): number;
  histogram(name: string, labelKeys?: string[] | null, buckets?: number[] | null): number;
  record(series: number, values?: string[] | null, amount?: number): void;
  gaugeSet(series: number, values: string[] | null, value: number): void;
  render(): string;
  /** Packed v1 series snapshot (families then series — see castrum registry). */
  snapshot(): Uint8Array;
  seriesCount?(): number;
}
