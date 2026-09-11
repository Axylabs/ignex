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
 * Ops where ignex's OWN interleaved-median measurement contradicts the
 * addon's `opImpl` and the JS path wins by a margin worth binding.
 *
 * `scripts/bench-native.ts` measures native vs the exact JS fallback (median
 * of 5 interleaved trials) AND compares the winner with `effectiveImplFor(op)`
 * — every op whose bound implementation is the slower one is printed as a
 * MISMATCH at the end of the run. These two were flagged there:
 *
 * - `createSchemaValidator` (native/js **0.08x** on the probe): the Rust
 *   `fast_schema` engine loses to Ajv at EVERY size — 4.15x slower at 568B,
 *   1.41x at 15KB (the real bulk-order payload), 1.37x against the core Ajv
 *   config. Ajv is the validation oracle ignex keeps anyway, so binding this
 *   to `castrum` only added cost (it was the top self-time in the app CPU
 *   profile). The one-pass `derive` accept path is not cheaper than parsing
 *   the document, so nothing is lost on the hot path.
 * - `aeadEncrypt`: THE PIN IS TRANSPORT-SPECIFIC, not a blanket "native loses".
 *   Re-measured 2026-09 (median of 11 interleaved trials, raw surfaces):
 *   - **addon (napi)**: 0.89x @64B, 0.93x @512B, 0.86x @4KB → JS wins, so the
 *     static table stays `js` (which is what a NAPI/Node runtime gets);
 *   - **C-ABI (ffi)**: **2.02x** @64B, 1.94x @79B, 1.73x @512B, 1.47x @2KB,
 *     1.64x @4KB, 1.20x @16KB → native wins, so the op is in
 *     `runtime.ts` `FFI_WINS` and Bun gets the native path.
 *   The original 0.76x/0.69x/0.30x row was an addon-transport measurement that
 *   was applied framework-wide; `aeadDecrypt` was always native (1.35-2.44x on
 *   the C-ABI, 3.06x on napi).
 *
 * Remove an entry only after re-running `bun run bench:native:all` shows the
 * addon's path winning again (upstream `opImpl` re-tune) — and remember that
 * `FFI_WINS` ops are judged by the C-ABI gates, not by that addon-transport
 * report.
 */
const MEASURED_JS_WINS: ReadonlySet<string> = new Set(["createSchemaValidator", "aeadEncrypt"]);

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
 * Pinned-op name → the addon's ACTUAL export name, where napi's camelCase of
 * the Rust `fn` differs from the SELECTION op name.
 *
 * napi turns `jwt_sign_eddsa` into `jwtSignEddsa` (one capital), while the op
 * name is `jwtSignEdDsa` (camel-cased acronym, matching the wrapper's variable
 * names). Without this map the symbol check below looks up a method that does
 * not exist, returns false, and the "structurally pinned" op silently runs the
 * JS FALLBACK — which is what happened to EdDSA JWT signing/verification
 * (measured cost: sign 1.80x, verify 1.45x).
 */
const PINNED_SYMBOL_ALIASES: Readonly<Partial<Record<OpName, string>>> = Object.freeze({
  jwtSignEdDsa: "jwtSignEddsa",
  jwtVerifyEdDsa: "jwtVerifyEddsa",
});

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
  const name = PINNED_SYMBOL_ALIASES[op] ?? op;
  return typeof (addon as Record<string, unknown>)[name] === "function";
};

/**
 * The decision for `op`, read from castrum's benchmark-generated `opImpl`
 * (the single source of truth, owned by the addon library) refined by the
 * measured ignex-side overrides above — `BUN_WINS` (a Bun builtin beats the
 * native crossing) and `MEASURED_JS_WINS` (ignex's median audit contradicts
 * `opImpl`). Bound once at module load — the implementation never changes for
 * the life of the process.
 */
export const implFor = (op: OpName): ExecutionBackend =>
  (isBun() && BUN_WINS.has(op)) || MEASURED_JS_WINS.has(op)
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
 * - `queryPairs`: the packed query parse flips between 439B and 589B once the
 *   wrapper's UTF-8 encode is counted; below ~440B JS wins by up to 0.80×,
 *   above 589B native wins by 1.17–1.21× (3.3KB: 1.20×). Threshold set at 512B
 *   — the middle of the measured dead band, so neither side is claimed inside
 *   noise. The op additionally requires the decoder-compatibility probe
 *   (`decode-compat.ts`).
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
  queryPairs: Object.freeze({ jsBelowBytes: 512 }),
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
