/**
 * Native-vs-JS selection registry — THE single source of truth for which
 * implementation each `@flux/native` operation binds to.
 *
 * Pure data: importing this module NEVER touches the addon (no dlopen), so it
 * can be audited without native installed — the same property as castrum's
 * `PROVEN_SURFACE`. The runtime dispatch (`./runtime.ts`) and every wrapper
 * read decisions from here, so a wiring change is a one-line table edit, not a
 * code change across the framework. This replaces the old scattered
 * "measured: prefer JS" inline comments and the duplicated decision text that
 * lived in `docs/native-acceleration.md`.
 *
 * `impl: "castrum"` → the Rust addon is used when available.
 * `impl: "js"`      → the pure-TS implementation is always preferred (native
 *                     is slower for that op at typical sizes, or the FFI
 *                     crossing does not amortize).
 */
export type ExecutionBackend = "castrum" | "js";

export interface OpDecision {
  /** The implementation bound when native is available. */
  readonly impl: ExecutionBackend;
  /**
   * Measured ratio native-ops/s ÷ fallback-ops/s. Numbers from
   * `bun run bench:native` (2026-08-11 flux baseline) where available;
   * otherwise castrum's `PROVEN_SURFACE`/registry ratios (marked in `note`).
   */
  readonly nativeRatio?: number;
  /** Why this decision — replaces the old inline "measured: …" comments. */
  readonly note?: string;
}

/** Every operation that has a native-vs-JS choice. */
export type OpName =
  // hash
  | "crc32"
  | "fnv1a64"
  // crypto
  | "aeadDecrypt"
  | "aeadEncrypt"
  | "csrfToken"
  | "csrfVerify"
  | "hmacSha256"
  | "hmacSha256Verify"
  | "jwtSign"
  | "jwtVerify"
  | "passwordHash"
  | "passwordVerify"
  | "randomToken"
  | "signCookie"
  | "verifyCookie"
  // http
  | "cookiePairs"
  | "createAcceptNegotiator"
  | "createConditionalRequest"
  | "etag"
  | "formPairs"
  | "multipartParse"
  | "parseAcceptEncoding"
  | "parseMediaType"
  | "queryPairs"
  // json
  | "createSchemaValidator"
  | "jsonPatch"
  | "jsonValid"
  // payload
  | "brotliCompress"
  | "brotliDecompress"
  | "gzipCompress"
  | "gzipDecompress"
  | "sseEncode"
  | "wsAcceptKey"
  | "wsFrameDecode"
  | "wsFrameEncode"
  // ratelimit
  | "createRateLimiter"
  // template
  | "createTemplate"
  | "renderTemplate"
  // validation
  | "validateEmail"
  | "validateIpv4"
  | "validateIpv6"
  | "validateUuid";

/**
 * Current decisions. Initial values mirror the actual wiring at the time of
 * extraction (so behavior is unchanged). Decisions are results-driven: the
 * `nativeRatio` comes from `bun run bench:native` on the current addon. Note
 * the bench compares the wrapper against the `*Fallback`, so it is only
 * meaningful for ops where the wrapper actually uses native; ops where both
 * columns resolve to the same impl read as noise and are left at their stable
 * wiring.
 */
export const SELECTION: Record<OpName, OpDecision> = {
  // ── hash ──────────────────────────────────────────────────────
  fnv1a64: {
    impl: "castrum",
    nativeRatio: 8.5,
    note: "bench 2026-08-11: native x8.5 — wired.",
  },
  crc32: {
    impl: "castrum",
    nativeRatio: 0.27,
    note: "castrum registry classifies native crc32 ~3.7x slower than JS; current wiring uses native. Candidate to flip to js pending flux re-measure.",
  },

  // ── crypto ────────────────────────────────────────────────────
  hmacSha256: { impl: "castrum", nativeRatio: 1.5, note: "castrum proven registry." },
  hmacSha256Verify: { impl: "castrum", nativeRatio: 2.4, note: "castrum proven registry." },
  signCookie: { impl: "castrum", nativeRatio: 9, note: "castrum proven registry (~9x)." },
  verifyCookie: { impl: "castrum", nativeRatio: 2.1, note: "castrum proven registry." },
  csrfToken: { impl: "castrum", nativeRatio: 13.8, note: "castrum proven registry (~13.8x)." },
  csrfVerify: { impl: "castrum", nativeRatio: 2.7, note: "castrum proven registry." },
  jwtSign: {
    impl: "castrum",
    note: "native wired; castrum registry prefers jwtSignBytes for long payloads.",
  },
  jwtVerify: { impl: "castrum", nativeRatio: 1.4, note: "castrum proven registry." },
  passwordHash: { impl: "castrum", nativeRatio: 18, note: "argon2id vs scrypt (~18x)." },
  passwordVerify: { impl: "castrum", note: "castrum registry: unmeasured — native wired." },
  aeadEncrypt: { impl: "castrum", nativeRatio: 1.6, note: "castrum proven registry." },
  aeadDecrypt: { impl: "castrum", nativeRatio: 2, note: "castrum proven registry." },
  randomToken: { impl: "castrum", nativeRatio: 1, note: "parity — native wired." },

  // ── http ──────────────────────────────────────────────────────
  queryPairs: {
    impl: "js",
    nativeRatio: 0.96,
    note: "flux bench 2026-08-11: scalar FFI x0.96 — JS wins. Native queryParsePacked stays for batched large inputs.",
  },
  cookiePairs: {
    impl: "js",
    nativeRatio: 0.65,
    note: "flux bench 2026-08-11: x0.65 — JS wins.",
  },
  formPairs: {
    impl: "js",
    nativeRatio: 0.88,
    note: "flux bench 2026-08-11: x0.88 — JS wins.",
  },
  parseMediaType: {
    impl: "js",
    nativeRatio: 0.5,
    note: "castrum marks native scalar parseMediaType @deprecated (slower); JS path.",
  },
  etag: {
    impl: "js",
    nativeRatio: 0.92,
    note: "flux bench 2026-08-11: x0.92 — JS crc32 wins for typical sizes.",
  },
  multipartParse: {
    impl: "castrum",
    nativeRatio: 2.3,
    note: "castrum proven registry (x2.3); Bun req.formData() still wins at 64-512KB — core keeps the streaming path.",
  },
  parseAcceptEncoding: {
    impl: "js",
    nativeRatio: 1.0,
    note: "parity — JS path (headers are tiny).",
  },
  createAcceptNegotiator: {
    impl: "js",
    nativeRatio: 1.0,
    note: "castrum registry x4 on large sets, but typical negotiation is small — JS path.",
  },
  createConditionalRequest: {
    impl: "js",
    nativeRatio: 0.08,
    note: "bench 2026-08-11: per-call native ConditionalRequest construction is x0.08 (loses ~12x) — JS path wins decisively. (An earlier baseline claimed x1.14; the real wrapper path disproved it.)",
  },

  // ── json ──────────────────────────────────────────────────────
  jsonValid: { impl: "castrum", nativeRatio: 3, note: "castrum proven registry (zero-DOM)." },
  jsonPatch: {
    impl: "castrum",
    nativeRatio: 1.2,
    note: "castrum proven registry — marginal but wired.",
  },
  createSchemaValidator: {
    impl: "castrum",
    note: "native-only (returns null without addon); fastest for large schemas/batch.",
  },

  // ── payload ───────────────────────────────────────────────────
  gzipCompress: { impl: "castrum", nativeRatio: 1, note: "parity (zlib-rs) — wired." },
  gzipDecompress: { impl: "castrum", nativeRatio: 1.4, note: "castrum proven registry." },
  brotliCompress: {
    impl: "castrum",
    nativeRatio: 0.8,
    note: "castrum registry marks brotliCompress not-competitive; current wiring uses native. Candidate to flip to js.",
  },
  brotliDecompress: { impl: "castrum", nativeRatio: 1.9, note: "castrum proven registry." },
  sseEncode: {
    impl: "js",
    nativeRatio: 0.28,
    note: "bench 2026-08-11: native sseEncodeEvent FFI marshal is x0.28 (loses ~3.6x) for typical frames — JS path. (An earlier baseline claimed x1.24; the real wrapper path disproved it.)",
  },
  wsFrameEncode: { impl: "castrum", nativeRatio: 1.8, note: "castrum proven registry." },
  wsFrameDecode: { impl: "castrum", nativeRatio: 2, note: "castrum proven registry." },
  wsAcceptKey: { impl: "castrum", nativeRatio: 1.6, note: "castrum proven registry." },

  // ── ratelimit ─────────────────────────────────────────────────
  createRateLimiter: {
    impl: "castrum",
    nativeRatio: 0.3,
    note: "native standalone limiter is slower per-check (FFI vs JS Map, x0.07-0.30). Prefer the ingress pipeline for native rate limiting; candidate to flip to js for the standalone path.",
  },

  // ── template ──────────────────────────────────────────────────
  createTemplate: { impl: "castrum", note: "minijinja compiled renderer — wired." },
  renderTemplate: { impl: "castrum", note: "minijinja — wired." },

  // ── validation ────────────────────────────────────────────────
  validateEmail: {
    impl: "castrum",
    nativeRatio: 1.01,
    note: "flux bench 2026-08-11: parity+ — wired.",
  },
  validateUuid: {
    impl: "castrum",
    nativeRatio: 1.19,
    note: "flux bench 2026-08-11: native x1.19 — wired.",
  },
  validateIpv4: {
    impl: "castrum",
    nativeRatio: 1.02,
    note: "flux bench 2026-08-11: parity+ — wired.",
  },
  validateIpv6: { impl: "castrum", nativeRatio: 1.3, note: "castrum proven registry — wired." },
};

/** All selectable op names (for completeness audits / iteration). */
export const OPS: readonly OpName[] = Object.keys(SELECTION) as OpName[];
