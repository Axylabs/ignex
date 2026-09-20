/**
 * @fileoverview C-ABI primary surface bind — the `bun:ffi` dlopen of the
 * castrum scalar cores plus the lazy singleton accessors.
 *
 * Extracted from the pre-split `ffi.ts` (move-only): `bind()` builds the
 * {@link FfiSurface} from dlopened symbols, runs the bind-time parity
 * self-test, and falls back to NAPI in auto mode when the transport cannot be
 * trusted. `getFfi()` is the cached accessor; `isFfiActive()` is the
 * boolean probe used by the fallback selection across `@ignex/native`.
 */

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

import { createRequire } from "node:module";
import { getAddonPath } from "../loader";
import { reportDegradation } from "../telemetry";
import { decoder } from "../util";
import { growExact, isBun, MAX_VAR_OUTPUT, resolveFfiMode, safeJsonParse } from "./helpers";
import { selfTest } from "./self-test";
import type { FfiSurface } from "./types";

let cached: FfiSurface | null | undefined;

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
      // Validators: the byte-exact `(ptr,len)` pair is PREFERRED (NUL-safe and
      // faster — castrum measured email 236→110ns, uuid 153→50ns, ipv4
      // 118→37ns). The `cstring` symbols stay bound as a fallback for an addon
      // predating 0.9.6; the surface method picks the byte pair when present.
      castrum_validate_email_bytes: { args: ["ptr", "usize"], returns: "u8" },
      castrum_validate_uuid_bytes: { args: ["ptr", "usize"], returns: "u8" },
      castrum_validate_ipv4_bytes: { args: ["ptr", "usize"], returns: "u8" },
      castrum_validate_ipv6_bytes: { args: ["ptr", "usize"], returns: "u8" },
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
    // Byte-input validator: prefer the NUL-safe `(ptr,len)` C-ABI symbol; only
    // an addon predating 0.9.6 lacks it, and then the `cstring` ARG is used
    // (which truncates at an embedded U+0000 — the bug the byte pair fixes).
    const validator = (
      byteFn: ((...a: unknown[]) => number | bigint) | undefined,
      cstrFn: ((...a: unknown[]) => number | bigint) | undefined,
      input: Uint8Array,
    ): boolean => {
      if (typeof byteFn === "function") return Number(byteFn(input, input.length)) === 1;
      if (typeof cstrFn === "function") return Number(cstrFn(decoder.decode(input))) === 1;
      return false;
    };
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
      // Byte-exact validators: the `(ptr,len)` pair preserves an embedded
      // U+0000 instead of truncating at it. Only an addon predating the byte
      // symbols falls back to the `cstring` ARG (decoding the bytes first).
      validateEmail: (input) =>
        validator(s.castrum_validate_email_bytes, s.castrum_validate_email, input),
      validateUuid: (input) =>
        validator(s.castrum_validate_uuid_bytes, s.castrum_validate_uuid, input),
      validateIpv4: (input) =>
        validator(s.castrum_validate_ipv4_bytes, s.castrum_validate_ipv4, input),
      validateIpv6: (input) =>
        validator(s.castrum_validate_ipv6_bytes, s.castrum_validate_ipv6, input),

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
      // Auto mode: degrade to NAPI, but never silently — a host where bun:ffi
      // breaks (e.g. after a Bun upgrade) would otherwise permanently run
      // ~10-350ns/op slower with zero signal.
      reportDegradation(
        "self-test-failed",
        "ffi.bind",
        "bun:ffi bind-time self-test failed — C-ABI transport disabled, NAPI owns native ops",
      );
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
    reportDegradation(
      "call-failed",
      "ffi.bind",
      `bun:ffi dlopen/bind failed — C-ABI transport disabled, NAPI owns native ops${
        err instanceof Error ? `: ${err.message}` : ""
      }`,
    );
    return null;
  }
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
