/**
 * @fileoverview Bind-time parity self-test for the C-ABI transport.
 *
 * Extracted from the pre-split `ffi.ts`: every C-ABI op must match the NAPI
 * addon (`getNative()`) on the same inputs — same cores, so a mismatch means
 * the binding or the addon is broken and ffi must not be trusted. `bind.ts`
 * runs this at dlopen time and falls back to NAPI (or throws) on failure.
 */
import { getNative, type NativeAddon } from "../loader";
import { eq, isHex } from "./helpers";
import type { FfiSurface } from "./types";

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

/**
 * Bind-time parity self-test: every C-ABI op must match the NAPI addon
 * (`getNative()`) on the same inputs — same cores, so a mismatch means the
 * binding or the addon is broken and ffi must not be trusted.
 */
export function selfTest(surface: FfiSurface): boolean {
  // Same addon file the ffi transport dlopens — byte-identical cores. loader.ts
  // does not import ffi, so there is no cycle.
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
    // Both transports now take bytes — the byte-exact `(ptr,len)` pair is used
    // on ffi (NUL-safe); napi has always taken bytes.
    check(fn, surface[fn](enc.encode(str)) === native[fn](enc.encode(str)));
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
