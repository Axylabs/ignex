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
import { getAddonPath, getNative } from "./loader";

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
  // validators
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
  // query/cookie header → JSON object TEXT (zero JS intermediate)
  queryToJson(input: Uint8Array): string;
  cookiesToJson(input: Uint8Array): string;
  // more cstring single-string outputs (engine-cloned) + buffer outputs
  wsAcceptKey(key: Uint8Array): string; // RFC 6455 accept (28 B)
  jwtSignBytes(claims: Uint8Array, secret: Uint8Array, ttl: number | null, now: number): string;
  /** Verify → parsed claims object (cstring claims JSON) or `null` on invalid. */
  jwtVerify(token: Uint8Array, secret: Uint8Array, now: number): unknown;
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
  /**
   * Heterogeneous task group — MANY different actions in ONE FFI call.
   * Input wire: `[u32 count]{[u8 op][u32 len][payload]}`; output wire:
   * `[u32 count]{[u32 len][result]}`. See `tasks.ts` for the typed builder.
   * `hint` = an upper bound on the output size (pre-sizes the buffer so the
   * C fn runs ONCE — growExact's too-small path would otherwise re-run every
   * task).
   */
  executeTasks(tasks: Uint8Array, hint?: number): Uint8Array;
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
function growExact(
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
 * Hard cap for variable-size native outputs. Generous enough to never reject a
 * realistic request (a 100MB form body parses to < 1GB packed) while still
 * bounding a runaway `needed` signal.
 */
const MAX_VAR_OUTPUT = 1024 * 1024 * 1024;

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
      castrum_validate_email: { args: ["ptr", "usize"], returns: "u8" },
      castrum_validate_uuid: { args: ["ptr", "usize"], returns: "u8" },
      castrum_validate_ipv4: { args: ["ptr", "usize"], returns: "u8" },
      castrum_validate_ipv6: { args: ["ptr", "usize"], returns: "u8" },
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
      castrum_query_to_json: { args: ["ptr", "usize"], returns: "cstring" },
      castrum_cookies_to_json: { args: ["ptr", "usize"], returns: "cstring" },
      castrum_ws_accept_key: { args: ["ptr", "usize"], returns: "cstring" },
      castrum_jwt_sign_bytes: {
        args: ["ptr", "usize", "ptr", "usize", "i64", "i64"],
        returns: "cstring",
      },
      castrum_jwt_verify: {
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
      castrum_execute_tasks: { args: ["ptr", "usize", "ptr", "usize"], returns: "usize" },
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

    // cstring-returning writer (engine clones the result string natively —
    // zero JS decode/alloc). `null` = real parse error (malformed %XX).
    const jsonStr =
      (raw: ((...a: unknown[]) => unknown) | undefined, label: string) =>
      (input: Uint8Array): string => {
        const v = raw?.(input, input.length) as string | null;
        if (typeof v !== "string") throw new Error(`${label}: parse failed`);
        return v;
      };

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
      validateEmail: (input) => Number(one(s.castrum_validate_email as RawIn, input)) === 1,
      validateUuid: (input) => Number(one(s.castrum_validate_uuid as RawIn, input)) === 1,
      validateIpv4: (input) => Number(one(s.castrum_validate_ipv4 as RawIn, input)) === 1,
      validateIpv6: (input) => Number(one(s.castrum_validate_ipv6 as RawIn, input)) === 1,

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
      // JSON-text writers return `cstring`: the ENGINE clones the result string
      // natively at the call (zero JS decode, zero allocation, zero growExact —
      // the Rust side owns a per-thread reused buffer). `null` = real parse
      // error (malformed %XX). This removes the decode side of the
      // encode→decode round trip for these single-string outputs.
      queryToJson: jsonStr(s.castrum_query_to_json, "query"),
      cookiesToJson: jsonStr(s.castrum_cookies_to_json, "cookies"),
      // More cstring single-string outputs (engine clones the string natively).
      wsAcceptKey: (key) => {
        const v = cstr(s.castrum_ws_accept_key)(key, key.length);
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
        return v === null ? null : JSON.parse(v);
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
      executeTasks: (tasks, hint) => {
        // growExact fits perfectly: the C fn returns the EXACT total needed
        // when the buffer is too small (never a doubling re-run loop). With a
        // good `hint` (tasks.ts computes the per-op output bound) the first
        // attempt fits and the group runs ONCE.
        const execute = s.castrum_execute_tasks as Raw4;
        return growExact(
          (out) => Number(execute(tasks, tasks.length, out, out.length)),
          Math.max(64, hint ?? tasks.length * 2),
          16 * 1024 * 1024,
          "execute tasks: output buffer too small",
        );
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

  const eq = (a: Uint8Array | null, b: Uint8Array | null): boolean =>
    a != null &&
    b != null &&
    a.length === b.length &&
    Buffer.from(a).toString("hex") === Buffer.from(b).toString("hex");

  const isHex = (a: Uint8Array): boolean => /^[0-9a-f]+$/.test(Buffer.from(a).toString());

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
    const input = enc.encode(
      fn === "validateEmail"
        ? "ada@example.com"
        : fn === "validateUuid"
          ? "123e4567-e89b-12d3-a456-426614174000"
          : fn === "validateIpv4"
            ? "192.168.0.1"
            : "2001:db8::1",
    );
    check(fn, surface[fn](input) === native[fn](input));
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

  // cstring JSON writers: the engine clones the string natively — assert the
  // exact text (not bytes), and that malformed %XX is a real error (throws).
  {
    const q = surface.queryToJson(enc.encode("a=1&b=hello%20world"));
    check("queryToJson", q === '{"a":"1","b":"hello world"}');
    const c = surface.cookiesToJson(enc.encode("sid=abc; theme=dark"));
    check("cookiesToJson", c === '{"sid":"abc","theme":"dark"}');
    let threw = false;
    try {
      surface.queryToJson(enc.encode("a=%ZZ"));
    } catch {
      threw = true;
    }
    check("queryToJson-malformed-throws", threw);
  }
  // wsAcceptKey (cstring): RFC 6455 test vector.
  check(
    "wsAcceptKey",
    surface.wsAcceptKey(enc.encode("dGhlIHNhbXBsZSBub25jZQ==")) ===
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" &&
      eq(
        enc.encode(surface.wsAcceptKey(enc.encode("dGhlIHNhbXBsZSBub25jZQ=="))),
        native.wsAcceptKey(enc.encode("dGhlIHNhbXBsZSBub25jZQ==")),
      ),
  );
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

  // Task-group parity: one executeTasks call must match the per-op NAPI scalar
  // results byte-for-byte (op tags from tasks.ts: 0 fnv1a64, 3 validateEmail,
  // 7 hmacSha256, 10 verifyCookie, 15 queryParsePacked).
  check(
    "executeTasks",
    (() => {
      const packTaskList = (items: Array<[number, Uint8Array]>): Uint8Array => {
        let total = 4;
        for (const [, p] of items) total += 1 + 4 + p.length;
        const buf = new Uint8Array(total);
        const dv = new DataView(buf.buffer);
        dv.setUint32(0, items.length, true);
        let pos = 4;
        for (const [tag, payload] of items) {
          buf[pos] = tag;
          pos += 1;
          dv.setUint32(pos, payload.length, true);
          pos += 4;
          buf.set(payload, pos);
          pos += payload.length;
        }
        return buf;
      };
      const lenAt = (buf: Uint8Array, at: number): number =>
        new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(at, true);
      const tKey = enc.encode("k".repeat(32));
      const tData = enc.encode("hello world");
      const tSecret = enc.encode("s".repeat(32));
      const tSigned = surface.signCookie(tData, tSecret); // cstring (string)
      const tSignedBytes = enc.encode(tSigned);
      const hmacPayload = (() => {
        const b = new Uint8Array(4 + tKey.length + tData.length);
        const dv = new DataView(b.buffer);
        dv.setUint32(0, tKey.length, true);
        b.set(tKey, 4);
        b.set(tData, 4 + tKey.length);
        return b;
      })();
      const vcPayload = (() => {
        const b = new Uint8Array(4 + tSignedBytes.length + tSecret.length);
        const dv = new DataView(b.buffer);
        dv.setUint32(0, tSignedBytes.length, true);
        b.set(tSignedBytes, 4);
        b.set(tSecret, 4 + tSignedBytes.length);
        return b;
      })();
      const tOut = surface.executeTasks(
        packTaskList([
          [0, tData],
          [3, enc.encode("ada@example.com")],
          [7, hmacPayload],
          [10, vcPayload],
          [15, q],
        ]),
      );
      const tCount = lenAt(tOut, 0);
      let tp = 4;
      const results: Uint8Array[] = [];
      for (let i = 0; i < tCount; i++) {
        const len = lenAt(tOut, tp);
        tp += 4;
        results.push(tOut.subarray(tp, tp + len));
        tp += len;
      }
      const [fnv, email, mac, cookie, query] = results as [
        Uint8Array,
        Uint8Array,
        Uint8Array,
        Uint8Array,
        Uint8Array,
      ];
      return (
        results.length === 5 &&
        fnv.length === 8 &&
        new DataView(fnv.buffer, fnv.byteOffset).getBigUint64(0, true) === native.fnv1a64(tData) &&
        email[0] === (native.validateEmail(enc.encode("ada@example.com")) ? 1 : 0) &&
        eq(mac, native.hmacSha256(tKey, tData)) &&
        cookie.length > 0 &&
        eq(cookie, native.verifyCookie(tSignedBytes, tSecret)) &&
        eq(query, native.queryParsePacked(q))
      );
    })(),
  );

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
