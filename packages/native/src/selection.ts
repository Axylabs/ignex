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
  | "ed25519Sign"
  | "ed25519Verify"
  | "generateEd25519Keypair"
  | "hmacSha256"
  | "hmacSha256Verify"
  | "jwtSign"
  | "jwtSignEdDsa"
  | "jwtVerify"
  | "jwtVerifyEdDsa"
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

/**
 * Ops PINNED to the Rust addon when it is present, pending a benchmark.
 *
 * These are brand-new ops castrum has not benchmarked yet (its `opImpl`
 * returns `null` → "js"), but the addon exports them and the Rust work
 * (Ed25519 sign/verify — microseconds) is far more expensive than the
 * ~10-20ns C-ABI / ~300ns NAPI crossing, so the win is structural, not
 * marginal. Mirrors castrum's own "pinned native" entries (jwtSign/
 * jwtVerify). Once castrum publishes a measured selection for these ops,
 * remove them from this set — the benchmark-driven `opImpl` takes over.
 */
const PINNED_NATIVE: ReadonlySet<string> = new Set([
  "generateEd25519Keypair",
  "jwtSignEdDsa",
  "jwtVerifyEdDsa",
  "ed25519Sign",
  "ed25519Verify",
]);

const isBun = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * True when the loaded addon actually EXPORTS the op's method. `PINNED_NATIVE`
 * bypasses castrum's `opImpl` benchmark, so it must not blindly force an op to
 * native when a loaded addon build lacks the symbol — an older registry build
 * would otherwise route the call to a missing method (TypeError). Matches the
 * additive C-ABI surfaces' symbol-presence checks.
 */
const hasPinnedSymbol = (op: OpName): boolean => {
  const addon = getNative();
  if (!addon) return false;
  return typeof (addon as Record<string, unknown>)[op] === "function";
};

/**
 * The decision for `op`, read from castrum's benchmark-generated `opImpl`
 * (the single source of truth, owned by the addon library) plus the runtime
 * Bun refinement above. Bound once at module load — the implementation never
 * changes for the life of the process.
 */
export const implFor = (op: OpName): ExecutionBackend =>
  isBun() && BUN_WINS.has(op)
    ? "js"
    : getNative() != null && PINNED_NATIVE.has(op) && hasPinnedSymbol(op)
      ? "castrum"
      : getNative()?.opImpl?.(op) === "native"
        ? "castrum"
        : "js";

/** All selectable op names (for completeness audits / iteration). */
export const OPS: readonly OpName[] = [
  "crc32",
  "fnv1a64",
  "aeadDecrypt",
  "aeadEncrypt",
  "csrfToken",
  "csrfVerify",
  "ed25519Sign",
  "ed25519Verify",
  "generateEd25519Keypair",
  "hmacSha256",
  "hmacSha256Verify",
  "jwtSign",
  "jwtSignEdDsa",
  "jwtVerify",
  "jwtVerifyEdDsa",
  "passwordHash",
  "passwordVerify",
  "randomToken",
  "signCookie",
  "verifyCookie",
  "cookiePairs",
  "createAcceptNegotiator",
  "createConditionalRequest",
  "etag",
  "formPairs",
  "multipartParse",
  "parseAcceptEncoding",
  "parseMediaType",
  "queryPairs",
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

/**
 * Per-op input-size crossovers (the "check the length, then decide" layer).
 *
 * The static table above answers "which impl wins for a TYPICAL payload" —
 * but some ops flip winner with input size: tiny inputs lose to the
 * boundary/transcode cost while large ones amortize it. Each gate records
 * the MEASURED byte threshold (see `scripts/bench-size-crossover.ts`, median
 * of interleaved trials) below which the JS path wins.
 *
 * Measured 2026-08 (Bun 1.4.1-canary, castrum C-ABI):
 * - `jsonValid`: JS (JSON.parse) loses ~20–40% below 64B under the forced
 *   native dispatch; native wins consistently from ~64B (up to ~1.2×).
 *   Threshold set at 256B for margin on both sides of the flip.
 * - `hmacSha256`: measured NO clean crossover (noise-level trading across
 *   the sweep) → deliberately NOT gated; static decision stands.
 * - `fnv1a64`: native from ≥32B (7–60×) → no gate needed (static native).
 * - `sessionSeal`/`sessionOpen`: JS wins at every size for open (growing to
 *   2.3×); seal flips only past ~1KB envelopes → opt-in flag, not gated.
 *
 * Kill switch: `IGNEX_SIZE_GATES=off` disables all gating (every call uses
 * the static-table decision — used by parity tests and emergency rollbacks).
 */
export interface SizeGate {
  /** Use the JS path for inputs strictly below this many bytes. */
  readonly jsBelowBytes: number;
}

/**
 * Per-op measured size crossovers (see the rationale above and
 * `scripts/bench-size-crossover.ts`). Read-only data — never mutate.
 */
export const SIZE_GATES: Readonly<Partial<Record<OpName, SizeGate>>> = Object.freeze({
  jsonValid: Object.freeze({ jsBelowBytes: 256 }),
} satisfies Partial<Record<OpName, SizeGate>>);

const SIZE_GATES_DISABLED = process.env.IGNEX_SIZE_GATES === "off";

/**
 * True when an input of `bytes` length may take the NATIVE path for `op`
 * (false = the measured crossover says JS wins at this size). Ops without a
 * gate always allow native (static table decides as before).
 */
export const sizeGateAllowsNative = (op: OpName, bytes: number): boolean => {
  if (SIZE_GATES_DISABLED) return true;
  const gate = SIZE_GATES[op];
  return gate === undefined || bytes >= gate.jsBelowBytes;
};
