/**
 * Native-vs-JS selection — CONSUMED FROM CASTRUM (the decision is OWNED by
 * the addon library, auto-selected from benchmarks via castrum's
 * `scripts/select-native.ts --write` into `src/selection.json` and embedded
 * in the `.node` as `opImpl(op)`).
 *
 * This module no longer maintains a decision table. It reads `opImpl(op)`
 * from the loaded castrum addon ONCE at module load and binds each operation
 * to a FIXED implementation for the process — the API never swaps native↔js
 * at runtime. When the addon is absent (or an op is unknown) the decision
 * falls back to `"js"` (pure-TS behavior is always the safe default).
 *
 * `impl: "castrum"` → the Rust addon is used when available.
 * `impl: "js"`      → the pure-TS implementation is always preferred.
 */
import { getNative } from "./loader";

/** The execution backend: Rust addon (`castrum`) or pure-TS (`js`). */
export type ExecutionBackend = "castrum" | "js";

/** The per-operation implementation decision. */
export interface OpDecision {
  /** The implementation bound when native is available. */
  readonly impl: ExecutionBackend;
  /**
   * Measured native-vs-JS ratio (informational; lives in castrum's
   * `src/selection.json` — not populated by the derived selection here).
   */
  readonly nativeRatio?: number;
  /** Why this decision (informational). */
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
  | "cookiesToJson"
  | "createAcceptNegotiator"
  | "createConditionalRequest"
  | "etag"
  | "formPairs"
  | "multipartParse"
  | "parseAcceptEncoding"
  | "parseMediaType"
  | "queryPairs"
  | "queryToJson"
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
 * Ops where Bun's NATIVE built-in beats the Rust addon (mirrors castrum's
 * `docs/bun-builtins-decision-matrix.md` + `src/selection.ts` BUN_WINS). Under
 * Bun these bind to `"js"` so the Bun-aware fallback is used (Bun.gzipSync,
 * Bun.hash.crc32, Bun.CryptoHasher, crypto.getRandomValues) — never something
 * slower than what Bun natively provides. Under Node the base decision stands
 * (Rust wins there).
 *
 * NOTE: `hmacSha256`/`randomToken` also appear in `FFI_WINS` (runtime.ts) —
 * deliberate, NOT a conflict. The sets apply at different layers: this one
 * fixes the base `implFor` decision (Bun builtin beats the ~300ns NAPI
 * crossing), while `FFI_WINS` is a final override that flips those ops back to
 * native ONLY when the ~10-20ns C-ABI (`bun:ffi`) transport is live, where the
 * crossing no longer swamps the Rust gain. Keeping them in both sets preserves
 * "Bun builtin on NAPI, Rust on C-ABI".
 */
const BUN_WINS: ReadonlySet<string> = new Set([
  "gzipCompress",
  "gzipDecompress",
  "crc32",
  "randomToken",
  "hmacSha256",
]);

const isBun = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * The decision for `op`, read from castrum's benchmark-generated `opImpl`
 * (the single source of truth, owned by the addon library) plus the runtime
 * Bun refinement above. Bound once at module load — the implementation never
 * changes for the life of the process.
 */
export const implFor = (op: OpName): ExecutionBackend =>
  isBun() && BUN_WINS.has(op) ? "js" : getNative()?.opImpl?.(op) === "native" ? "castrum" : "js";

/** All selectable op names (for completeness audits / iteration). */
export const OPS: readonly OpName[] = [
  "crc32",
  "fnv1a64",
  "aeadDecrypt",
  "aeadEncrypt",
  "csrfToken",
  "csrfVerify",
  "hmacSha256",
  "hmacSha256Verify",
  "jwtSign",
  "jwtVerify",
  "passwordHash",
  "passwordVerify",
  "randomToken",
  "signCookie",
  "verifyCookie",
  "cookiePairs",
  "cookiesToJson",
  "createAcceptNegotiator",
  "createConditionalRequest",
  "etag",
  "formPairs",
  "multipartParse",
  "parseAcceptEncoding",
  "parseMediaType",
  "queryPairs",
  "queryToJson",
  "createSchemaValidator",
  "jsonPatch",
  "jsonValid",
  "brotliCompress",
  "brotliDecompress",
  "gzipCompress",
  "gzipDecompress",
  "sseEncode",
  "wsAcceptKey",
  "wsFrameDecode",
  "wsFrameEncode",
  "createRateLimiter",
  "createTemplate",
  "renderTemplate",
  "validateEmail",
  "validateIpv4",
  "validateIpv6",
  "validateUuid",
];

/**
 * Decisions bound once at module load from castrum's `opImpl` (fixed for the
 * process — no runtime switching). `nativeRatio`/`note` live in castrum's
 * `src/selection.json`; here we keep only the bound implementation.
 */
export const SELECTION: Record<OpName, OpDecision> = Object.fromEntries(
  OPS.map((op) => [op, { impl: implFor(op) }]),
) as Record<OpName, OpDecision>;
