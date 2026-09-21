/**
 * @fileoverview C-ABI surface types — the `bun:ffi` transport's contract.
 *
 * Extracted from the pre-split `ffi.ts`: every interface here describes an
 * additive C-ABI surface that `bind.ts` / `routes.ts` / `instances.ts` /
 * `metrics.ts` / `ingress.ts` dlopen lazily. The `@ignex/native` import
 * surface is unchanged (`ffi/index.ts` barrel re-exports each type).
 */

/** Transport selection for the C-ABI fast path. */
export type FfiMode = "auto" | "ffi" | "napi";

/** The C-ABI-bound surface (a focused subset of the castrum scalar cores). */
export interface FfiSurface {
  /** Fused session seal (undefined when the addon predates the symbols). */
  sessionSeal?(
    id: string,
    dataJson: string,
    expSecs: bigint | number,
    secret: string,
  ): string | null;
  /** Fused session open (undefined when the addon predates the symbols). */
  sessionOpen?(token: string, secret: string, out: Uint8Array, outLen: number): number;
  readonly ffiMode: "ffi";
  // hash
  fnv1a64(input: Uint8Array): bigint;
  crc32(input: Uint8Array): number;
  // json
  jsonValid(input: Uint8Array): boolean;
  // validators — the byte-exact `*_bytes` C-ABI pair (`ptr` + `len`). castrum
  // 0.9.6 moved these off the `cstring` ARG because a `cstring` ARG is
  // NUL-terminated: an embedded U+0000 truncated the value native-side, so
  // `validateEmail("a@b.com\0…")` reported TRUE. The napi transport already
  // takes bytes, so both transports now share one bytes-in contract.
  validateEmail(input: Uint8Array): boolean;
  validateUuid(input: Uint8Array): boolean;
  validateIpv4(input: Uint8Array): boolean;
  validateIpv6(input: Uint8Array): boolean;
  // crypto (cstring returns = engine clones the string natively — zero JS decode/alloc)
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array; // 64 lowercase-hex (bytes contract)
  hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean;
  signCookie(value: Uint8Array, secret: Uint8Array): string; // `value.<64hex>`
  verifyCookie(signed: Uint8Array, secret: Uint8Array): string | null; // value | null
  csrfToken(secret: Uint8Array): string; // 129 B: 64rnd-hex.<64sig-hex>
  csrfVerify(token: Uint8Array, secret: Uint8Array): boolean;
  // http
  etag(data: Uint8Array, weak?: boolean): string; // `"<8hex>"` strong / `W/"…"` weak
  randomToken(byteLen: number): string; // byteLen*2 hex chars
  // pair parsers → packed pairs wire (`[u32 count]{[u32 len][bytes]}`)
  queryParsePacked(input: Uint8Array): Uint8Array;
  cookieParsePacked(input: Uint8Array): Uint8Array;
  formParsePacked(input: Uint8Array): Uint8Array;
  // more cstring single-string outputs (engine-cloned) + buffer outputs
  wsAcceptKey(key: string): string; // RFC 6455 accept (28 B) — `cstring` ARG
  jwtSignBytes(claims: Uint8Array, secret: Uint8Array, ttl: number | null, now: number): string;
  /** Verify → parsed claims object (cstring claims JSON) or `null` on invalid. */
  jwtVerify(token: Uint8Array, secret: Uint8Array, now: number): unknown;
  // Ed25519 / EdDSA JWT (RBAC auth)
  /** Keypair generation → `{ privateKey, publicKey }` base64url DER strings. */
  generateEd25519Keypair(): { privateKey: string; publicKey: string };
  ed25519Sign(msg: Uint8Array, privateKey: Uint8Array): Uint8Array;
  ed25519Verify(msg: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
  /** EdDSA JWT sign → compact token (cstring). `ttl` 0/null = no iat/exp. */
  jwtSignEddsa(claims: Uint8Array, privateKey: Uint8Array, ttl: number | null, now: number): string;
  /** EdDSA JWT verify → parsed claims object (cstring JSON) or `null`. */
  jwtVerifyEddsa(token: Uint8Array, publicKey: Uint8Array, now: number): unknown;
  brotliCompress(data: Uint8Array, quality: number): Uint8Array;
  brotliDecompress(data: Uint8Array, maxSize: number): Uint8Array;
  aeadEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    algorithm: string | null,
  ): Uint8Array;
  aeadDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    algorithm: string | null,
  ): Uint8Array | null;
}

/**
 * The C-ABI per-route surface (`castrum_route_*`). Bound LAZILY in a separate
 * `dlopen` so a castrum build without the route stack (e.g. the registry
 * `^0.9.0`) cannot break the primary `FfiSurface` — `getFfiRoute()` returns
 * `null` and the JS prelude remains the fallback (parity preserved).
 */
export interface FfiRouteSurface {
  /** Compile a route descriptor → opaque handle (`0n` = failure). */
  routeCompile(descriptor: Uint8Array): bigint;
  /** Run a pre-baked route stack; returns bytes written (`0` = error/too small). */
  routeRun(handle: bigint, frame: Uint8Array, out: Uint8Array): number;
  /** Release a route handle. */
  routeDestroy(handle: bigint): void;
}

/**
 * The C-ABI opaque-handle instance surface — castrum's Phase-6 stateful
 * instances evaluate each per-call op through a C-ABI symbol via the opaque
 * inner pointer (`innerPtr()`), collapsing the ~100-350ns NAPI crossing to the
 * ~10-20ns C-ABI crossing. The JS wrapper holds the napi instance alive for
 * the handle's lifetime (same contract as `castrum_route_*`); a null (0)
 * handle never dereferences freed state. Bound LAZILY in a separate `dlopen`
 * so a castrum build lacking these symbols cannot break the primary surface.
 */
export interface FfiInstancesSurface {
  /**
   * Fused wire-level query validation: RAW query string → JSON → draft-07
   * validate in ONE crossing. Always bound: returns `false` when the addon
   * predates the symbol (callers treat false as "use detailed path").
   * `qs` is a `cstring` ARG — engine-transcoded, zero JS encode.
   */
  schemaQueryValidate(inner: number, qs: string): boolean;
  /** Fused cookie-header variant of {@link schemaQueryValidate}. */
  schemaCookieValidate(inner: number, header: string): boolean;
  /** SchemaValidator: validate a JSON doc against the compiled schema → 1/0. */
  schemaValidatorValidate(inner: number, doc: Uint8Array): boolean;
  /**
   * TemplateRenderer: render the compiled template with pre-serialized JSON
   * context → bytes written (needed-size convention; 0 = real error).
   */
  templateRender(inner: number, context: Uint8Array, out: Uint8Array): number;
  /**
   * AcceptNegotiator: best supported encoding → cstring (`null` = identity).
   * `header` is a `cstring` ARG — the engine transcodes the JS string
   * in-engine (zero JS encode).
   */
  acceptNegotiatorNegotiate(inner: number, header: string): string | null;
  /**
   * AcceptNegotiator: best supported encoding with SERVER-preference
   * tie-breaking (ignex `negotiateEncoding` semantics) → cstring (`null` =
   * identity). Returns `undefined` when the addon lacks the symbol (built
   * before it existed) so callers fall back to the napi method / JS engine.
   * `header` is a `cstring` ARG (zero JS encode).
   */
  acceptNegotiatorNegotiateServer(inner: number, header: string): string | null | undefined;
  /**
   * ConditionalRequest: 304 check → 1 when not-modified. `ifNoneMatch` /
   * `ifModifiedSince` cross as `(ptr,len)` byte pairs (the Rust signature is
   * `(inner, inm: *const u8, inm_len: usize, ims: *const u8, ims_len: usize,
   * flags: u8)`); presence is gated by the flags byte, so absent headers pass
   * an empty view and are never read.
   */
  conditionalIsNotModified(
    inner: number,
    ifNoneMatch: string | null,
    ifModifiedSince: string | null,
  ): boolean;
}

// ── Ingress pipeline C-ABI (`castrum_ingress_*`) ─────────────────
// The full native ingress pipeline (CORS / rate-limit / IP-trust / body-guard /
// JSON-schema) driven directly from ignex — NO castrum TS-layer round trip.
// Transfer is minimal-overhead by construction:
//   - `url`/`ip` are `cstring` ARGs — the engine transcodes the JS strings to
//     call-scoped NUL-terminated buffers in-engine (ZERO JS-side encode, no
//     frame assembly for URL/IP);
//   - every `(ptr,len)` pair uses the probe-gated `buffer`/`buffer_length` ABI
//     (the engine reads ptr + byteLength off the SAME TypedArray at call time —
//     an atomic snapshot, one JS arg instead of two); falls back to `(ptr,len)`;
//   - the 48-byte output header is decoded with cached DataView reads (no
//     TextDecoder, no intermediate objects).
// The opaque `inner` is the napi `Ingress.ingressInnerPtr()` handle; the JS
// wrapper holds the napi instance alive for the handle's lifetime (same
// contract as the route/instance surfaces). Bound LAZILY in a separate dlopen
// so a build lacking the symbols cannot break the primary surface.

/** The C-ABI ingress pipeline surface. */
export interface FfiIngressSurface {
  /**
   * Run the full ingress pipeline from raw request components. `url`/`ip` are
   * passed as JS strings (`cstring` ARGs — the engine transcodes in-engine,
   * zero JS encode). `headers` is the packed `[u16 count]{[u16 klen][key]
   * [u32 vlen][value]}` block. Returns bytes written (0 = error/too-small).
   */
  ingressHandleComponents(
    inner: number,
    methodKind: number,
    url: string,
    ip: string,
    rid: Uint8Array,
    headers: Uint8Array,
    body: Uint8Array | null,
    out: Uint8Array,
  ): number;
  /**
   * Run the ingress pipeline from a packed request frame
   * (`[method u8][url][ip][rid] len-prefixed sections + [u16 count] headers`).
   */
  ingressHandlePacked(
    inner: number,
    input: Uint8Array,
    body: Uint8Array | null,
    out: Uint8Array,
  ): number;
  /** Read the 38×u32 LE ingress layout blob into `out`; returns bytes written. */
  ingressLayout(out: Uint8Array): number;
}

/**
 * The metrics-registry C-ABI surface (`castrum_metrics_*`) — caller-owned
 * registry handle + cstring declare / record_str updates. Bound LAZILY and
 * OPTIONALLY: `null` when the addon predates these symbols or bun:ffi is
 * unavailable, so the metrics wrapper falls back to the NAPI class. The
 * handle is created via `metricsCreate` and must be released with
 * `metricsDestroy`.
 */
export interface FfiMetricsSurface {
  metricsCreate(): number;
  metricsCounter(handle: number, name: string, labelKeys: string): number;
  metricsGauge(handle: number, name: string, labelKeys: string): number;
  metricsHistogram(handle: number, name: string, labelKeys: string, bucketsCsv: string): number;
  /** Label VALUES cross as ONE `\u001f`-joined `cstring` ARG (zero encode). */
  metricsRecordStr(handle: number, series: number, values: string, amount: number): boolean;
  metricsGaugeSetStr(handle: number, series: number, values: string, value: number): boolean;
  metricsRender(handle: number, out: Uint8Array): number;
  metricsSnapshot(handle: number, out: Uint8Array): number;
  metricsDestroy(handle: number): void;
  /**
   * Record N events in ONE crossing. Packed layout:
   * `[u32 n]{[u32 series][u32 valsLen][vals][f64 amount]}`.
   * Returns `false` when the addon predates the symbol.
   */
  metricsRecordBatch(handle: number, packed: Uint8Array): boolean;
}
