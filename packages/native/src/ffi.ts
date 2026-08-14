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
  // crypto (raw bytes, same wire contracts as the NAPI surface)
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array; // 64 lowercase-hex
  hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean;
  signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array; // `value.<64hex>`
  verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | null; // value | null
  csrfToken(secret: Uint8Array): Uint8Array; // 129 B: 64rnd-hex.<64sig-hex>
  csrfVerify(token: Uint8Array, secret: Uint8Array): boolean;
  // http
  etag(data: Uint8Array, weak?: boolean): Uint8Array; // `"<8hex>"` strong / `W/"…"` weak
  randomToken(byteLen: number): Uint8Array; // byteLen*2 hex chars
  // pair parsers → packed pairs wire (`[u32 count]{[u32 len][bytes]}`)
  queryParsePacked(input: Uint8Array): Uint8Array;
  cookieParsePacked(input: Uint8Array): Uint8Array;
  formParsePacked(input: Uint8Array): Uint8Array;
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
type Raw5 = (a: Uint8Array, al: number, b: Uint8Array, bl: number, c: number) => number | bigint;
type Raw6 = (
  a: Uint8Array,
  al: number,
  b: Uint8Array,
  bl: number,
  c: Uint8Array,
  cl: number,
) => number | bigint;
type Raw3 = (n: number, out: Uint8Array, ol: number) => number | bigint;

let cached: FfiSurface | null | undefined;

const isBun = (): boolean => typeof process.versions.bun === "string";

const resolveFfiMode = (): FfiMode => {
  const raw = process.env.IGNEX_FFI_MODE;
  return raw === "ffi" || raw === "napi" ? raw : "auto";
};

/**
 * Write with the C ABI's "needed" convention (`0` = error, `w > cap` = exact
 * required size → allocate once + retry, else `w` = written count).
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
      castrum_sign_cookie: {
        args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      castrum_verify_cookie: {
        args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      castrum_csrf_token: { args: ["ptr", "usize", "ptr", "usize"], returns: "usize" },
      castrum_csrf_verify: { args: ["ptr", "usize", "ptr", "usize"], returns: "u8" },
      castrum_etag: { args: ["ptr", "usize", "ptr", "usize", "u8"], returns: "usize" },
      castrum_random_token: { args: ["u32", "ptr", "usize"], returns: "usize" },
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
      castrum_execute_tasks: { args: ["ptr", "usize", "ptr", "usize"], returns: "usize" },
    });

    const s = symbols as Record<string, (...a: unknown[]) => number | bigint>;
    const one = (raw: RawIn, v: Uint8Array): number | bigint => raw(v, v.length);
    // Pair-parse packed output. The C fns return `0` when the out buffer is too
    // small (no "needed-size" hint, unlike the growExact fns), so size exactly:
    //   output = 4 (count) + Σ(8 + name_len + value_len) ≤ 4 + 8·L + L = 9L + 4
    // where L = input length (Σ name+value bytes never exceeds the input).
    const packedWrite = (raw: Raw4, input: Uint8Array, label: string): Uint8Array => {
      const out = new Uint8Array(input.length * 9 + 4);
      const w = Number(raw(input, input.length, out, out.length));
      if (w === 0) throw new Error(`${label}: parse failed or output buffer too small`);
      return out.subarray(0, w);
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
        const out = new Uint8Array(value.length + 65); // `value.<64hex>`
        const w = Number(
          (s.castrum_sign_cookie as Raw6)(
            value,
            value.length,
            secret,
            secret.length,
            out,
            out.length,
          ),
        );
        if (w === 0) throw new Error("sign cookie: output buffer too small");
        return out.subarray(0, w);
      },
      verifyCookie: (signed, secret) => {
        const out = new Uint8Array(signed.length);
        const w = Number(
          (s.castrum_verify_cookie as Raw6)(
            signed,
            signed.length,
            secret,
            secret.length,
            out,
            out.length,
          ),
        );
        return w === 0 ? null : out.subarray(0, w);
      },
      csrfToken: (secret) => {
        const out = new Uint8Array(129); // 64rnd-hex.<64sig-hex>
        const w = Number((s.castrum_csrf_token as Raw4)(secret, secret.length, out, out.length));
        if (w === 0) throw new Error("csrf token: output buffer too small or random source failed");
        return out.subarray(0, w);
      },
      csrfVerify: (token, secret) =>
        Number((s.castrum_csrf_verify as Raw4)(token, token.length, secret, secret.length)) === 1,

      etag: (data, weak) => {
        const out = new Uint8Array(12); // 10 strong / 12 weak
        const w = Number(
          (s.castrum_etag as Raw5)(data, data.length, out, out.length, weak ? 1 : 0),
        );
        if (w === 0) throw new Error("etag: output buffer too small");
        return out.subarray(0, w);
      },
      randomToken: (byteLen) => {
        const out = new Uint8Array(byteLen * 2); // hex chars
        const w = Number((s.castrum_random_token as Raw3)(byteLen, out, out.length));
        if (w === 0 && byteLen !== 0) {
          throw new Error("random token: output buffer too small or random source failed");
        }
        return out.subarray(0, w);
      },

      queryParsePacked: (input) =>
        packedWrite(s.castrum_query_parse_packed as Raw4, input, "query"),
      cookieParsePacked: (input) =>
        packedWrite(s.castrum_cookie_parse_packed as Raw4, input, "cookie"),
      formParsePacked: (input) => packedWrite(s.castrum_form_parse_packed as Raw4, input, "form"),
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
  const signed = surface.signCookie(data, secret);
  check("signCookie", eq(signed, native.signCookie(data, secret)));
  const fv = surface.verifyCookie(signed, secret);
  const nv = native.verifyCookie(signed, secret);
  check("verifyCookie", fv != null && nv != null && eq(fv, nv));
  const token = surface.csrfToken(secret);
  // csrfToken/randomToken are RANDOM — no byte equality. Check format + cross-verify.
  check(
    "csrfToken-format",
    token.length === 129 && isHex(token.subarray(0, 64)) && token[64] === 46,
  );
  check("csrfVerify", surface.csrfVerify(token, secret) && native.csrfVerify(token, secret));
  check("etag", eq(surface.etag(data), native.etag(data)));
  const rt = surface.randomToken(8);
  check("randomToken", rt.length === 16 && isHex(rt));
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
      const tSigned = surface.signCookie(tData, tSecret);
      const hmacPayload = (() => {
        const b = new Uint8Array(4 + tKey.length + tData.length);
        const dv = new DataView(b.buffer);
        dv.setUint32(0, tKey.length, true);
        b.set(tKey, 4);
        b.set(tData, 4 + tKey.length);
        return b;
      })();
      const vcPayload = (() => {
        const b = new Uint8Array(4 + tSigned.length + tSecret.length);
        const dv = new DataView(b.buffer);
        dv.setUint32(0, tSigned.length, true);
        b.set(tSigned, 4);
        b.set(tSecret, 4 + tSigned.length);
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
        eq(cookie, native.verifyCookie(tSigned, tSecret)) &&
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
