/**
 * C-ABI (`bun:ffi`) transport — the PRIMARY native path under Bun.
 *
 * The castrum cdylib exports `#[no_mangle] extern "C"` symbols (`rust/ffi.rs`)
 * that Bun JIT-compiles down to direct native calls (~10-20ns crossing) vs the
 * ~100-350ns of a Node-API call. This module `dlopen`s the SAME `.node` the
 * NAPI loader `require`s (`loader.getAddonPath()`) and binds the hot, stateless
 * scalar ops ignex's wrappers need — byte-identical cores, byte-identical
 * contracts. NAPI becomes the fallback (Node, forced `IGNEX_FFI_MODE=napi`, or
 * a failed bind-time self-test).
 *
 * Safety mirrors castrum's `src/native/ffi.ts`:
 *   - Lazily bound (no dlopen until first use).
 *   - A bind-time SELF-TEST asserts ffi output === NAPI output for every bound
 *     op; any mismatch disables ffi (falls back to NAPI/JS).
 *   - Variable-size outputs use the C ABI's "needed" convention: `0` = real
 *     error (throw), `w > cap` = exact required size (allocate once, retry),
 *     else `w` = written bytes — never a doubling re-run loop.
 *
 * Environment:
 *   IGNEX_FFI_MODE = auto | ffi | napi   (default auto: ffi on Bun, napi else)
 *   IGNEX_NATIVE=off disables ffi too (getFfi() returns null).
 */
import { createRequire } from "node:module";
import { getAddonPath, getNative, type NativeAddon } from "./loader";

/** Transport selection for the C-ABI fast path. */
export type FfiMode = "auto" | "ffi" | "napi";

/** The C-ABI-bound surface (a focused subset of the castrum scalar cores). */
export interface FfiSurface {
  readonly ffiMode: "ffi";
  // hash
  fnv1a64(input: Uint8Array): bigint;
  crc32(input: Uint8Array): number;
  // json
  jsonValid(input: Uint8Array): boolean;
  // validators — C-ABI `cstring` ARG (the engine transcodes the JS string to a
  // call-scoped NUL-terminated buffer in-engine, so the JS side does ZERO
  // `encoder.encode` work). NAPI still takes bytes; the wrapper branches.
  validateEmail(input: string): boolean;
  validateUuid(input: string): boolean;
  validateIpv4(input: string): boolean;
  validateIpv6(input: string): boolean;
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

// Raw C-ABI symbol signatures (`usize`/`u64`/`u32` returns surface as bigint).
type RawIn = (a: Uint8Array, al: number) => number | bigint;
type Raw4 = (a: Uint8Array, al: number, b: Uint8Array, bl: number) => number | bigint;
type Raw5 = (a: Uint8Array, al: number, b: number, c: Uint8Array, cl: number) => number | bigint;
type Raw6 = (
  a: Uint8Array,
  al: number,
  b: Uint8Array,
  bl: number,
  c: Uint8Array,
  cl: number,
) => number | bigint;
type Raw9 = (
  a: Uint8Array,
  al: number,
  b: Uint8Array,
  bl: number,
  c: Uint8Array,
  cl: number,
  d: number,
  e: Uint8Array,
  el: number,
) => number | bigint;

let cached: FfiSurface | null | undefined;

const isBun = (): boolean => typeof process.versions.bun === "string";

const resolveFfiMode = (): FfiMode => {
  const raw = process.env.IGNEX_FFI_MODE;
  return raw === "ffi" || raw === "napi" ? raw : "auto";
};

/**
 * Write with the C ABI's "needed" convention (`0` = error, `w > cap` = exact
 * required size → allocate once + retry, else `w` = written count).
 *
 * `initial` should be a TIGHT bound covering the common case in ONE call (the
 * whole point vs a `len*9`/`len*8` worst-case pre-size): on the rare miss the
 * C fn reports the EXACT size and this allocates once and retries — never a
 * doubling re-run loop.
 */
export function growExact(
  write: (out: Uint8Array) => number,
  initial: number,
  max: number,
  error: string,
): Uint8Array {
  let cap = Math.min(Math.max(initial, 16), max);
  for (;;) {
    const out = new Uint8Array(cap);
    const w = Number(write(out));
    if (w === 0) throw new Error(error);
    if (w <= out.length) return out.subarray(0, w);
    if (w > max) throw new Error(error);
    cap = Math.min(w, max);
  }
}

/**
 * Default cap for variable-size native outputs. Bounds a single FFI call's
 * worst-case allocation — a lying addon misreporting `needed` near the cap is
 * a memory-exhaustion DoS, and the old 1 GiB ceiling was far too generous.
 * 128 MiB aligns with the generated server's default `maxRequestBodySize` and
 * stays well under the former ceiling. Overridable via `IGNEX_MAX_VAR_OUTPUT`
 * (bytes) for apps that legitimately need larger variable-size native outputs.
 */
const DEFAULT_MAX_VAR_OUTPUT = 128 * 1024 * 1024;
const MAX_VAR_OUTPUT = (() => {
  const raw = process.env.IGNEX_MAX_VAR_OUTPUT;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_MAX_VAR_OUTPUT;
})();

/**
 * Parse the cstring claims JSON the C-ABI returns. `null`/empty → `null`
 * (invalid token); malformed JSON → `null` too, matching the pure-TS fallbacks
 * (`crypto.ts`/`ed25519.ts` guard with try/catch). A castrum bug emitting
 * malformed claims must not throw synchronously out of the FFI wrapper — it
 * would surface as a 500 (or worse) instead of a clean `null` rejection.
 */
const safeJsonParse = (v: string | null): unknown => {
  if (v === null || v === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** Byte-equality helper for the bind-time parity self-test. */
const eq = (a: Uint8Array | null, b: Uint8Array | null): boolean =>
  a != null &&
  b != null &&
  a.length === b.length &&
  Buffer.from(a).toString("hex") === Buffer.from(b).toString("hex");

/** True when `a` is a lowercase-hex string (in bytes). */
const isHex = (a: Uint8Array): boolean => /^[0-9a-f]+$/.test(Buffer.from(a).toString());

/**
 * Bind-time Ed25519 / EdDSA-JWT parity checks (extracted from {@link selfTest}
 * to keep its cognitive complexity under the lint limit — same checks, same
 * semantics). Keypair generation is RANDOM — no byte parity possible. Instead
 * verify the DER format on both transports, then CROSS-verify: a signature
 * made with the ffi keypair must verify through NAPI (and vice versa), proving
 * both transports speak the same PKCS#8/SPKI DER + EdDSA wire formats.
 */
function selfTestEd25519(
  surface: FfiSurface,
  native: NativeAddon,
  enc: TextEncoder,
  data: Uint8Array,
  check: (name: string, cond: boolean) => void,
): void {
  const fPair = surface.generateEd25519Keypair();
  const fPriv = new Uint8Array(Buffer.from(fPair.privateKey, "base64url"));
  const fPub = new Uint8Array(Buffer.from(fPair.publicKey, "base64url"));
  const nPair = native.generateEd25519Keypair();
  const nPriv = new Uint8Array(Buffer.from(nPair.privateKey, "base64url"));
  const nPub = new Uint8Array(Buffer.from(nPair.publicKey, "base64url"));
  check("generateEd25519Keypair-format", fPriv.length === 48 && fPub.length === 44);
  check("generateEd25519Keypair-napi-format", nPriv.length === 48 && nPub.length === 44);
  const fSig = surface.ed25519Sign(data, fPriv);
  check("ed25519Sign", eq(fSig, native.ed25519Sign(data, fPriv)));
  check("ed25519Verify-cross", native.ed25519Verify(data, fSig, fPub));
  check(
    "ed25519Verify",
    surface.ed25519Verify(data, fSig, fPub) &&
      !surface.ed25519Verify(enc.encode("tampered"), fSig, fPub),
  );
  const claims = enc.encode('{"sub":"user-1","roles":["admin"]}');
  const etok = surface.jwtSignEddsa(claims, fPriv, 60, 1_700_000_000);
  check("jwtSignEddsa", typeof etok === "string" && etok.split(".").length === 3);
  const eTok = native.jwtSignEddsa(claims, fPriv, 60, 1_700_000_000);
  check("jwtSignEddsa-napi-parity", eq(enc.encode(etok), eTok));
  const ev = surface.jwtVerifyEddsa(enc.encode(etok), fPub, 1_700_000_030);
  check("jwtVerifyEddsa", (ev as Record<string, unknown>)?.sub === "user-1");
  check(
    "jwtVerifyEddsa-expired",
    surface.jwtVerifyEddsa(enc.encode(etok), fPub, 1_700_000_100) === null,
  );
  check(
    "jwtVerifyEddsa-napi-parity",
    JSON.stringify(ev) ===
      JSON.stringify(native.jwtVerifyEddsa(enc.encode(etok), fPub, 1_700_000_030)),
  );
}

/** Current transport mode in effect (`ffi` only when actually bound). */
export const getFfiMode = (): FfiMode => resolveFfiMode();

/** True when the C-ABI transport is live (bound + self-test passed). */
export const isFfiActive = (): boolean => getFfi() !== null;

let bound = false;
function bind(): FfiSurface | null {
  if (bound) return cached ?? null;
  bound = true;
  if (process.env.IGNEX_NATIVE === "off") return null;
  const mode = resolveFfiMode();
  if (!isBun() || mode === "napi") return null;

  const path = getAddonPath();
  if (!path) return null;

  // Minimal structural type for `bun:ffi`'s `dlopen` — avoids a
  // `typeof import("bun:ffi")` annotation so the CLI/root tsconfigs (which
  // don't always ship Bun's module types) still typecheck. The actual module is
  // required dynamically at runtime (Bun-only; guarded by isBun()).
  type DlopenFn = (
    path: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => { symbols: Record<string, (...a: unknown[]) => number | bigint>; close(): void };

  let dlopen: DlopenFn;
  try {
    // `bun:ffi` is Bun-only — require it dynamically so Node never trips on
    // the bare specifier (this branch already guarded by isBun()).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = createRequire(import.meta.url)("bun:ffi") as { dlopen: DlopenFn };
    dlopen = mod.dlopen;
  } catch {
    return null;
  }

  try {
    const { symbols } = dlopen(path, {
      castrum_fnv1a64: { args: ["ptr", "usize"], returns: "u64" },
      castrum_crc32: { args: ["ptr", "usize"], returns: "u32" },
      castrum_json_valid: { args: ["ptr", "usize"], returns: "u8" },
      // Validators take a `cstring` ARG (castrum cstring-arg fast path ~76-82%)
      // — the engine transcodes the JS string in-engine (zero JS encode).
      castrum_validate_email: { args: ["cstring"], returns: "u8" },
      castrum_validate_uuid: { args: ["cstring"], returns: "u8" },
      castrum_validate_ipv4: { args: ["cstring"], returns: "u8" },
      castrum_validate_ipv6: { args: ["cstring"], returns: "u8" },
      castrum_hmac_sha256: {
        args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      castrum_hmac_sha256_verify: {
        args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
        returns: "u8",
      },
      castrum_sign_cookie: { args: ["ptr", "usize", "ptr", "usize"], returns: "cstring" },
      castrum_verify_cookie: { args: ["ptr", "usize", "ptr", "usize"], returns: "cstring" },
      castrum_csrf_token: { args: ["ptr", "usize"], returns: "cstring" },
      castrum_csrf_verify: { args: ["ptr", "usize", "ptr", "usize"], returns: "u8" },
      castrum_etag: { args: ["ptr", "usize", "u8"], returns: "cstring" },
      castrum_random_token: { args: ["u32"], returns: "cstring" },
      castrum_query_parse_packed: {
        args: ["ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      castrum_cookie_parse_packed: {
        args: ["ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      castrum_form_parse_packed: {
        args: ["ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      // `ws_accept_key` takes a `cstring` ARG + returns `cstring` (engine-cloned).
      castrum_ws_accept_key: { args: ["cstring"], returns: "cstring" },
      castrum_jwt_sign_bytes: {
        args: ["ptr", "usize", "ptr", "usize", "i64", "i64"],
        returns: "cstring",
      },
      castrum_jwt_verify: {
        args: ["ptr", "usize", "ptr", "usize", "i64"],
        returns: "cstring",
      },
      // Ed25519 / EdDSA JWT (RBAC auth)
      castrum_ed25519_generate_keypair: { args: ["ptr", "usize"], returns: "usize" },
      castrum_ed25519_sign: {
        args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      castrum_ed25519_verify: {
        args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
        returns: "u8",
      },
      castrum_jwt_eddsa_sign: {
        args: ["ptr", "usize", "ptr", "usize", "i64", "i64"],
        returns: "cstring",
      },
      castrum_jwt_eddsa_verify: {
        args: ["ptr", "usize", "ptr", "usize", "i64"],
        returns: "cstring",
      },
      castrum_brotli_compress: {
        args: ["ptr", "usize", "u32", "ptr", "usize"],
        returns: "usize",
      },
      castrum_brotli_decompress: {
        args: ["ptr", "usize", "usize", "ptr", "usize"],
        returns: "usize",
      },
      castrum_aead_encrypt: {
        args: ["ptr", "usize", "ptr", "usize", "ptr", "usize", "u8", "ptr", "usize"],
        returns: "usize",
      },
      castrum_aead_decrypt: {
        args: ["ptr", "usize", "ptr", "usize", "ptr", "usize", "u8", "ptr", "usize"],
        returns: "usize",
      },
    });

    const s = symbols as Record<string, (...a: unknown[]) => number | bigint>;
    const one = (raw: RawIn, v: Uint8Array): number | bigint => raw(v, v.length);
    // Pair-parse packed output. The C fns now use the needed-size convention
    // (exact required size on a too-small buffer, `0` = real parse error), so
    // JS starts with a TIGHT initial bound (≈ typical packed output, NOT the
    // 9× worst case) and growExact's once — exactly — on the rare miss. No
    // per-request `len*9+4` over-allocation.
    const packedWrite = (raw: Raw4, input: Uint8Array, label: string): Uint8Array =>
      growExact(
        (out) => Number(raw(input, input.length, out, out.length)),
        input.length * 4 + 16,
        MAX_VAR_OUTPUT,
        `${label}: parse failed`,
      );

    // Generic cstring-returning symbol → string (null → null). The engine
    // clones the result string natively at the call — zero JS decode/alloc.
    const cstr =
      (raw: ((...a: unknown[]) => unknown) | undefined) =>
      (...args: unknown[]): string | null => {
        const v = raw?.(...args) as string | null;
        return typeof v === "string" ? v : null;
      };

    const surface: FfiSurface = {
      ffiMode: "ffi",
      fnv1a64: (input) => BigInt(one(s.castrum_fnv1a64 as RawIn, input)),
      crc32: (input) => Number(one(s.castrum_crc32 as RawIn, input)) >>> 0,
      jsonValid: (input) => Number(one(s.castrum_json_valid as RawIn, input)) === 1,
      // C-ABI validators take a `cstring` ARG — pass the JS string directly
      // (the engine transcodes in-engine; zero JS encode). `null` → false.
      validateEmail: (input) => Number(s.castrum_validate_email?.(input) ?? 0) === 1,
      validateUuid: (input) => Number(s.castrum_validate_uuid?.(input) ?? 0) === 1,
      validateIpv4: (input) => Number(s.castrum_validate_ipv4?.(input) ?? 0) === 1,
      validateIpv6: (input) => Number(s.castrum_validate_ipv6?.(input) ?? 0) === 1,

      hmacSha256: (key, data) => {
        const out = new Uint8Array(64); // 64 lowercase-hex chars
        const w = Number(
          (s.castrum_hmac_sha256 as Raw6)(key, key.length, data, data.length, out, out.length),
        );
        if (w === 0) throw new Error("hmac sha256: output buffer too small");
        return out.subarray(0, w);
      },
      hmacSha256Verify: (key, data, sig) =>
        Number(
          (s.castrum_hmac_sha256_verify as Raw6)(
            key,
            key.length,
            data,
            data.length,
            sig,
            sig.length,
          ),
        ) === 1,
      signCookie: (value, secret) => {
        const v = cstr(s.castrum_sign_cookie)(value, value.length, secret, secret.length);
        if (v === null) throw new Error("sign cookie: failed");
        return v;
      },
      verifyCookie: (signed, secret) =>
        cstr(s.castrum_verify_cookie)(signed, signed.length, secret, secret.length),
      csrfToken: (secret) => {
        const v = cstr(s.castrum_csrf_token)(secret, secret.length);
        if (v === null) throw new Error("csrf token: failed or random source failed");
        return v;
      },
      csrfVerify: (token, secret) =>
        Number((s.castrum_csrf_verify as Raw4)(token, token.length, secret, secret.length)) === 1,

      etag: (data, weak) => {
        const v = cstr(s.castrum_etag)(data, data.length, weak ? 1 : 0);
        if (v === null) throw new Error("etag: failed");
        return v;
      },
      randomToken: (byteLen) => {
        const v = cstr(s.castrum_random_token)(byteLen);
        if (v === null && byteLen !== 0) {
          throw new Error("random token: failed or random source failed");
        }
        return v ?? "";
      },

      queryParsePacked: (input) =>
        packedWrite(s.castrum_query_parse_packed as Raw4, input, "query"),
      cookieParsePacked: (input) =>
        packedWrite(s.castrum_cookie_parse_packed as Raw4, input, "cookie"),
      formParsePacked: (input) => packedWrite(s.castrum_form_parse_packed as Raw4, input, "form"),
      // More cstring single-string outputs (engine clones the string natively).
      // `ws_accept_key` takes a `cstring` ARG — pass the raw key string (the
      // engine transcodes in-engine; zero JS encode).
      wsAcceptKey: (key) => {
        const v = cstr(s.castrum_ws_accept_key)(key);
        if (v === null) throw new Error("ws accept key: failed");
        return v;
      },
      jwtSignBytes: (claims, secret, ttl, now) => {
        // C-ABI ttl is an i64 (no null) — null means "no TTL" → 0.
        const v = cstr(s.castrum_jwt_sign_bytes)(
          claims,
          claims.length,
          secret,
          secret.length,
          ttl ?? 0,
          now,
        );
        if (v === null) throw new Error("jwt sign: failed");
        return v;
      },
      jwtVerify: (token, secret, now) => {
        // cstring claims JSON (null = invalid) → parsed object, matching NAPI.
        const v = cstr(s.castrum_jwt_verify)(token, token.length, secret, secret.length, now);
        return safeJsonParse(v);
      },
      // Ed25519 / EdDSA JWT. Keypair gen returns packed `[u32 privLen][priv]
      // [u32 pubLen][pub]` (needed-size convention) — decode to base64url DER.
      generateEd25519Keypair: () => {
        const out = growExact(
          (buf) => Number(s.castrum_ed25519_generate_keypair?.(buf, buf.length) ?? 0),
          100,
          MAX_VAR_OUTPUT,
          "ed25519 keypair generation failed",
        );
        const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
        const privLen = dv.getUint32(0, true);
        const priv = out.subarray(4, 4 + privLen);
        const pubStart = 4 + privLen;
        const pubLen = dv.getUint32(pubStart, true);
        const pub = out.subarray(pubStart + 4, pubStart + 4 + pubLen);
        const b64 = (b: Uint8Array): string =>
          Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64url");
        return { privateKey: b64(priv), publicKey: b64(pub) };
      },
      ed25519Sign: (msg, privateKey) => {
        // C ABI args: (key, klen, msg, mlen, out, out_cap) — key first.
        const out = new Uint8Array(64);
        const w = Number(
          (s.castrum_ed25519_sign as Raw6)(
            privateKey,
            privateKey.length,
            msg,
            msg.length,
            out,
            out.length,
          ),
        );
        if (w === 0) throw new Error("ed25519 sign: failed (invalid private key)");
        return out.subarray(0, w);
      },
      ed25519Verify: (msg, signature, publicKey) =>
        // C ABI args: (key, klen, msg, mlen, sig, slen) — key first.
        Number(
          (s.castrum_ed25519_verify as Raw6)(
            publicKey,
            publicKey.length,
            msg,
            msg.length,
            signature,
            signature.length,
          ),
        ) === 1,
      jwtSignEddsa: (claims, privateKey, ttl, now) => {
        const v = cstr(s.castrum_jwt_eddsa_sign)(
          claims,
          claims.length,
          privateKey,
          privateKey.length,
          ttl ?? 0,
          now,
        );
        if (v === null) throw new Error("eddsa jwt sign: failed");
        return v;
      },
      jwtVerifyEddsa: (token, publicKey, now) => {
        // cstring claims JSON (null = invalid) → parsed object, matching NAPI.
        const v = cstr(s.castrum_jwt_eddsa_verify)(
          token,
          token.length,
          publicKey,
          publicKey.length,
          now,
        );
        return safeJsonParse(v);
      },
      // Brotli: needed-size convention → growExact (exact retry once).
      brotliCompress: (data, quality) =>
        growExact(
          (out) =>
            Number(
              (s.castrum_brotli_compress as Raw5)(data, data.length, quality, out, out.length),
            ),
          Math.max(64, data.length),
          MAX_VAR_OUTPUT,
          "brotli compress failed",
        ),
      brotliDecompress: (data, maxSize) =>
        growExact(
          (out) =>
            Number(
              (s.castrum_brotli_decompress as Raw5)(
                data,
                data.length,
                // NAPI wrapper passes no maxSize → default to a large cap.
                maxSize ?? 1 << 30,
                out,
                out.length,
              ),
            ),
          Math.max(64, data.length),
          MAX_VAR_OUTPUT,
          "brotli decompress failed",
        ),
      // AEAD: fixed pre-size (ct = plaintext + 16 tag); 0 = error / auth fail.
      aeadEncrypt: (key, nonce, plaintext, algorithm) => {
        const out = new Uint8Array(plaintext.length + 16);
        const w = Number(
          (s.castrum_aead_encrypt as Raw9)(
            key,
            key.length,
            nonce,
            nonce.length,
            plaintext,
            plaintext.length,
            algorithm === "chacha20-poly1305" ? 1 : 0,
            out,
            out.length,
          ),
        );
        if (w === 0) throw new Error("aead encrypt failed");
        return out.subarray(0, w);
      },
      aeadDecrypt: (key, nonce, ciphertext, algorithm) => {
        const out = new Uint8Array(ciphertext.length);
        const w = Number(
          (s.castrum_aead_decrypt as Raw9)(
            key,
            key.length,
            nonce,
            nonce.length,
            ciphertext,
            ciphertext.length,
            algorithm === "chacha20-poly1305" ? 1 : 0,
            out,
            out.length,
          ),
        );
        return w === 0 ? null : out.subarray(0, w);
      },
    };

    if (!selfTest(surface)) {
      if (mode === "ffi") {
        throw new Error(
          "IGNEX_FFI_MODE=ffi: the bun:ffi bind-time self-test failed — the C-ABI " +
            "transport cannot be trusted on this Bun/addon combination. Unset " +
            "IGNEX_FFI_MODE (or use auto) to fall back to NAPI.",
        );
      }
      return null;
    }
    cached = surface;
    return surface;
  } catch (err) {
    if (mode === "ffi") {
      // Explicit ffi requested and it failed — surface the failure loudly.
      const cause = err instanceof Error ? `: ${err.message}` : `: ${String(err)}`;
      throw new Error(`IGNEX_FFI_MODE=ffi: failed to bind bun:ffi${cause}`);
    }
    return null;
  }
}

/**
 * Bind-time parity self-test: every C-ABI op must match the NAPI addon
 * (`getNative()`) on the same inputs — same cores, so a mismatch means the
 * binding or the addon is broken and ffi must not be trusted.
 */
function selfTest(surface: FfiSurface): boolean {
  // Same addon file the ffi transport dlopens — byte-identical cores. loader.ts
  // does not import ffi.ts, so there is no cycle.
  const native = getNative();
  if (!native) return false;
  const enc = new TextEncoder();
  const key = enc.encode("k".repeat(32));
  const data = enc.encode("hello world");
  const secret = enc.encode("s".repeat(32));

  const failures: string[] = [];
  const check = (name: string, cond: boolean): void => {
    if (!cond) failures.push(name);
  };

  check("fnv1a64", surface.fnv1a64(data) === native.fnv1a64(data));
  check("crc32", surface.crc32(data) === native.crc32(data));
  check(
    "jsonValid",
    surface.jsonValid(enc.encode('{"a":1}')) === native.jsonValid(enc.encode('{"a":1}')),
  );
  for (const fn of ["validateEmail", "validateUuid", "validateIpv4", "validateIpv6"] as const) {
    const str =
      fn === "validateEmail"
        ? "ada@example.com"
        : fn === "validateUuid"
          ? "123e4567-e89b-12d3-a456-426614174000"
          : fn === "validateIpv4"
            ? "192.168.0.1"
            : "2001:db8::1";
    // FFI takes a `cstring` (JS string); NAPI takes bytes.
    check(fn, surface[fn](str) === native[fn](enc.encode(str)));
  }
  check("hmacSha256", eq(surface.hmacSha256(key, data), native.hmacSha256(key, data)));
  const sig = surface.hmacSha256(key, data);
  check(
    "hmacSha256Verify",
    surface.hmacSha256Verify(key, data, sig) && native.hmacSha256Verify(key, data, sig),
  );
  const signed = surface.signCookie(data, secret); // cstring (string)
  const signedBytes = enc.encode(signed);
  check("signCookie", eq(signedBytes, native.signCookie(data, secret)));
  const fv = surface.verifyCookie(signedBytes, secret);
  const nv = native.verifyCookie(signedBytes, secret);
  check("verifyCookie", fv != null && nv != null && eq(enc.encode(fv), nv));
  const token = surface.csrfToken(secret); // cstring (string)
  // csrfToken/randomToken are RANDOM — no byte equality. Check format + cross-verify.
  check(
    "csrfToken-format",
    token.length === 129 && isHex(enc.encode(token.slice(0, 64))) && token[64] === ".",
  );
  check(
    "csrfVerify",
    surface.csrfVerify(enc.encode(token), secret) && native.csrfVerify(enc.encode(token), secret),
  );
  check("etag", eq(enc.encode(surface.etag(data)), native.etag(data)));
  const rt = surface.randomToken(8); // cstring (string)
  check("randomToken", rt.length === 16 && isHex(enc.encode(rt)));
  const q = enc.encode("a=1&b=2");
  check("queryParsePacked", eq(surface.queryParsePacked(q), native.queryParsePacked(q)));
  check(
    "cookieParsePacked",
    eq(
      surface.cookieParsePacked(enc.encode("a=1; b=2")),
      native.cookieParsePacked(enc.encode("a=1; b=2")),
    ),
  );
  check(
    "formParsePacked",
    eq(
      surface.formParsePacked(enc.encode("a=1&b=2")),
      native.formParsePacked(enc.encode("a=1&b=2")),
    ),
  );

  // wsAcceptKey (cstring ARG + cstring return): RFC 6455 test vector. FFI takes
  // the raw key string; NAPI takes bytes.
  {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    check(
      "wsAcceptKey",
      surface.wsAcceptKey(key) === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" &&
        eq(enc.encode(surface.wsAcceptKey(key)), native.wsAcceptKey(enc.encode(key))),
    );
  }
  // jwtSignBytes (cstring) round-trips through NAPI verify.
  {
    const claims = enc.encode('{"sub":"user-1"}');
    const jtok = surface.jwtSignBytes(claims, secret, 60, 1_700_000_000);
    check("jwtSignBytes", typeof jtok === "string" && jtok.split(".").length === 3);
    const nTok = native.jwtSignBytes(claims, secret, 60, 1_700_000_000);
    check("jwtSignBytes-napi-parity", eq(enc.encode(jtok), nTok));
    // jwtVerify: cstring claims → parsed object; expired/tampered → null.
    const jv = surface.jwtVerify(enc.encode(jtok), secret, 1_700_000_030);
    check("jwtVerify", (jv as Record<string, unknown>)?.sub === "user-1");
    check("jwtVerify-expired", surface.jwtVerify(enc.encode(jtok), secret, 1_700_000_100) === null);
    check(
      "jwtVerify-napi-parity",
      JSON.stringify(jv) ===
        JSON.stringify(native.jwtVerify(enc.encode(jtok), secret, 1_700_000_030)),
    );
  }
  // Ed25519 / EdDSA JWT parity (extracted to keep selfTest's complexity in
  // check — see selfTestEd25519).
  selfTestEd25519(surface, native, enc, data, check);
  // brotli roundtrip + parity with NAPI.
  {
    const c = surface.brotliCompress(data, 6);
    const n = native.brotliCompress(data);
    check("brotliCompress", c.length > 0 && n.length > 0);
    check(
      "brotliDecompress",
      eq(surface.brotliDecompress(c, 1 << 20), data) && eq(native.brotliDecompress(n), data),
    );
  }
  // aead encrypt/decrypt parity + roundtrip (AES-256-GCM, alg 0).
  {
    const nonce = enc.encode("n".repeat(12));
    const ct = surface.aeadEncrypt(key, nonce, data, "aes-256-gcm");
    check("aeadEncrypt", eq(ct, native.aeadEncrypt(key, nonce, data, "aes-256-gcm")));
    check(
      "aeadDecrypt",
      eq(surface.aeadDecrypt(key, nonce, ct, "aes-256-gcm"), data) &&
        surface.aeadDecrypt(key, nonce, new Uint8Array(ct.length), "aes-256-gcm") === null,
    );
  }

  // NOTE: the former task-group (`castrum_execute_tasks`) parity check was
  // removed — castrum dropped the symbol and the JS `runTasks` wrapper was
  // deleted (it had no production consumers and degraded to a per-task loop).

  if (failures.length > 0 && process.env.IGNEX_FFI_MODE === "ffi") {
    console.error("[ignex-native] ffi self-test failures:", failures.join(", "));
  }
  return failures.length === 0;
}

/**
 * The C-ABI surface (`null` when unavailable — Node, forced napi, missing
 * addon, or a failed bind-time self-test). Cached; never throws in auto mode.
 */
export const getFfi = (): FfiSurface | null => {
  if (cached !== undefined) return cached;
  cached = bind();
  return cached;
};

// ── Per-route native stack (lazily bound, additive) ───────────────

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

let routeCached: FfiRouteSurface | null | undefined;

/** Lazy bind of the per-route C-ABI surface (`null` when the addon lacks it). */
export const getFfiRoute = (): FfiRouteSurface | null => {
  if (routeCached !== undefined) return routeCached;
  routeCached = null;
  if (process.env.IGNEX_NATIVE === "off") return null;

  const path = getAddonPath();
  if (!path) return null;

  type DlopenFn = (
    path: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => { symbols: Record<string, (...a: unknown[]) => number | bigint | undefined>; close(): void };

  let dlopen: DlopenFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = createRequire(import.meta.url)("bun:ffi") as { dlopen: DlopenFn };
    dlopen = mod.dlopen;
  } catch {
    return null;
  }

  try {
    const { symbols } = dlopen(path, {
      castrum_route_compile: { args: ["ptr", "usize"], returns: "u64" },
      castrum_route_run: {
        args: ["u64", "ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      castrum_route_destroy: { args: ["u64"], returns: "void" },
    });
    const s = symbols as Record<string, (...a: unknown[]) => number | bigint | undefined>;
    // Treat a PARTIAL binding (some symbols present, others silently
    // `undefined` → always-0 results) as "surface absent" so the JS prelude
    // remains the fallback instead of a half-working native path.
    const required = [
      "castrum_route_compile",
      "castrum_route_run",
      "castrum_route_destroy",
    ] as const;
    if (required.some((name) => typeof s[name] !== "function")) return null;
    routeCached = {
      routeCompile: (descriptor) =>
        BigInt(s.castrum_route_compile?.(descriptor, descriptor.length) ?? 0n),
      routeRun: (handle, frame, out) =>
        Number(s.castrum_route_run?.(handle, frame, frame.length, out, out.length) ?? 0),
      routeDestroy: (handle) => {
        s.castrum_route_destroy?.(handle);
      },
    };
  } catch {
    // Addon lacks the route surface — not an error.
    routeCached = null;
  }
  return routeCached;
};

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
   * `ifModifiedSince` are `cstring` ARGs (zero JS encode); presence is gated
   * by the flags byte, so absent headers pass `null` and are never read.
   */
  conditionalIsNotModified(
    inner: number,
    ifNoneMatch: string | null,
    ifModifiedSince: string | null,
  ): boolean;
}

let instancesCached: FfiInstancesSurface | null | undefined;

/** Lazy bind of the opaque-handle instance C-ABI surface (`null` when absent). */
export const getFfiInstances = (): FfiInstancesSurface | null => {
  if (instancesCached !== undefined) return instancesCached;
  instancesCached = null;
  if (process.env.IGNEX_NATIVE === "off") return null;

  const path = getAddonPath();
  if (!path) return null;

  type DlopenFn = (
    path: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => { symbols: Record<string, (...a: unknown[]) => number | bigint | undefined>; close(): void };

  let dlopen: DlopenFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = createRequire(import.meta.url)("bun:ffi") as { dlopen: DlopenFn };
    dlopen = mod.dlopen;
  } catch {
    return null;
  }

  try {
    const { symbols } = dlopen(path, {
      castrum_schema_validator_validate: { args: ["u64", "ptr", "usize"], returns: "u8" },
      castrum_template_render: {
        args: ["u64", "ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      // `header` is a `cstring` ARG — the engine transcodes the JS string
      // in-engine (zero JS encode), matching the validator/ws_accept_key
      // pattern. C-ABI returns a cstring (engine-cloned, zero JS decode).
      castrum_accept_negotiator_negotiate: {
        args: ["u64", "cstring"],
        returns: "cstring",
      },
      castrum_accept_negotiator_negotiate_server: {
        args: ["u64", "cstring"],
        returns: "cstring",
      },
      // `ifNoneMatch`/`ifModifiedSince` are `cstring` ARGs (zero JS encode);
      // presence is gated by the flags byte, so absent headers pass `""` (the
      // raw symbol never sees `null`) and are never read on the Rust side.
      castrum_conditional_is_not_modified: {
        args: ["u64", "cstring", "cstring", "u8"],
        returns: "u8",
      },
    });
    const s = symbols as Record<string, (...a: unknown[]) => number | bigint | undefined>;
    // Partial binding → treat the surface as absent (see getFfiRoute).
    const required = [
      "castrum_schema_validator_validate",
      "castrum_template_render",
      "castrum_accept_negotiator_negotiate",
      "castrum_conditional_is_not_modified",
    ] as const;
    if (required.some((name) => typeof s[name] !== "function")) return null;
    instancesCached = {
      schemaValidatorValidate: (inner, doc) =>
        Number(s.castrum_schema_validator_validate?.(inner, doc, doc.length) ?? 0) === 1,
      templateRender: (inner, context, out) =>
        Number(s.castrum_template_render?.(inner, context, context.length, out, out.length) ?? 0),
      acceptNegotiatorNegotiate: (inner, header) => {
        // `header` is a `cstring` ARG — pass the JS string directly.
        const v = s.castrum_accept_negotiator_negotiate?.(inner, header);
        return typeof v === "string" ? v : null;
      },
      acceptNegotiatorNegotiateServer: (inner, header) => {
        const fn = s.castrum_accept_negotiator_negotiate_server;
        if (typeof fn !== "function") return undefined;
        const v = fn(inner, header);
        return typeof v === "string" ? v : null;
      },
      conditionalIsNotModified: (inner, ifNoneMatch, ifModifiedSince) =>
        Number(
          s.castrum_conditional_is_not_modified?.(
            inner,
            // cstring ARGs: pass "" for absent headers — Rust only reads the
            // pointer when the corresponding flags bit is set (never null).
            ifNoneMatch ?? "",
            ifModifiedSince ?? "",
            (ifNoneMatch ? 1 : 0) | (ifModifiedSince ? 2 : 0),
          ) ?? 0,
        ) === 1,
    };
  } catch {
    // Addon lacks the instance surface — not an error.
    instancesCached = null;
  }
  return instancesCached;
};

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

/** Empty view passed for absent optional byte sections (body/rid). */
const EMPTY_VIEW = new Uint8Array(0);

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

let ingressCached: FfiIngressSurface | null | undefined;

/**
 * Probe whether this Bun accepts the `buffer`/`buffer_length` ABI pair in
 * `dlopen` (an earlier canary threw "invalid ABI type" for it). When supported
 * we bind every `(ptr,len)` pair as `(buffer, buffer_length)` — the engine
 * reads ptr + byteLength off the SAME view at call time (atomic snapshot, one
 * JS arg instead of two); otherwise we fall back to explicit `(ptr, usize)`.
 */
function probeBufferLength(
  dlopen: (
    path: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => { symbols: Record<string, (...a: unknown[]) => unknown>; close(): void },
  path: string,
): boolean {
  try {
    const { symbols, close } = dlopen(path, {
      castrum_crc32: {
        args: ["buffer", "buffer_length"] as unknown as readonly string[],
        returns: "u32",
      },
    });
    const view = new Uint8Array([1, 2, 3]);
    const out = symbols.castrum_crc32?.(view, view);
    close();
    return typeof out === "number" && out >= 0;
  } catch {
    return false;
  }
}

/** Lazy bind of the ingress C-ABI surface (`null` when absent). */
export const getFfiIngress = (): FfiIngressSurface | null => {
  if (ingressCached !== undefined) return ingressCached;
  ingressCached = null;
  if (process.env.IGNEX_NATIVE === "off") return null;

  const path = getAddonPath();
  if (!path) return null;

  type DlopenFn = (
    path: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => { symbols: Record<string, (...a: unknown[]) => number | bigint | undefined>; close(): void };

  let dlopen: DlopenFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = createRequire(import.meta.url)("bun:ffi") as { dlopen: DlopenFn };
    dlopen = mod.dlopen;
  } catch {
    return null;
  }

  try {
    const useBufferLength = probeBufferLength(
      dlopen as (
        p: string,
        s: Record<string, { args: readonly string[]; returns: string }>,
      ) => {
        symbols: Record<string, (...a: unknown[]) => unknown>;
        close(): void;
      },
      path,
    );
    // Convert `(ptr, usize)` pairs → `(buffer, buffer_length)` when supported
    // (scalar args like the `usize` inner handle pass through unchanged).
    const abi = (shape: readonly string[]): readonly string[] => {
      if (!useBufferLength) return shape;
      const out: string[] = [];
      for (let i = 0; i < shape.length; i++) {
        // len-bound loop → `shape[i]` is always defined (noUncheckedIndexedAccess).
        const t = shape[i] as string;
        if (t === "ptr") {
          out.push("buffer", "buffer_length");
          i++;
        } else {
          out.push(t);
        }
      }
      return out;
    };
    const { symbols } = dlopen(path, {
      castrum_ingress_handle_components: {
        args: abi([
          "usize",
          "u8",
          "cstring",
          "cstring",
          "ptr",
          "usize",
          "ptr",
          "usize",
          "ptr",
          "usize",
          "ptr",
          "usize",
        ]),
        returns: "usize",
      },
      castrum_ingress_handle_packed: {
        args: abi(["usize", "ptr", "usize", "ptr", "usize", "ptr", "usize"]),
        returns: "usize",
      },
      castrum_ingress_layout: { args: abi(["ptr", "usize"]), returns: "usize" },
    });
    const s = symbols as Record<string, (...a: unknown[]) => number | bigint | undefined>;
    // Partial binding → treat the surface as absent (see getFfiRoute).
    const required = [
      "castrum_ingress_handle_components",
      "castrum_ingress_handle_packed",
      "castrum_ingress_layout",
    ] as const;
    if (required.some((name) => typeof s[name] !== "function")) return null;
    // Under `buffer`/`buffer_length` the length slot is the SAME view (the
    // engine reads its byteLength); under `(ptr,len)` it's the explicit length.
    // Bind-time constant → the JIT folds the branch away.
    const lenOrView = (v: Uint8Array): Uint8Array | number => (useBufferLength ? v : v.length);
    ingressCached = {
      ingressHandleComponents(inner, methodKind, url, ip, rid, headers, body, out) {
        return Number(
          s.castrum_ingress_handle_components?.(
            inner,
            methodKind,
            url,
            ip,
            rid,
            lenOrView(rid),
            headers,
            lenOrView(headers),
            body ?? EMPTY_VIEW,
            body ? lenOrView(body) : lenOrView(EMPTY_VIEW),
            out,
            lenOrView(out),
          ) ?? 0,
        );
      },
      ingressHandlePacked(inner, input, body, out) {
        return Number(
          s.castrum_ingress_handle_packed?.(
            inner,
            input,
            lenOrView(input),
            body ?? EMPTY_VIEW,
            body ? lenOrView(body) : lenOrView(EMPTY_VIEW),
            out,
            lenOrView(out),
          ) ?? 0,
        );
      },
      ingressLayout(out) {
        return Number(s.castrum_ingress_layout?.(out, lenOrView(out)) ?? 0);
      },
    };
  } catch {
    // Addon lacks the ingress surface — not an error.
    ingressCached = null;
  }
  return ingressCached;
};
