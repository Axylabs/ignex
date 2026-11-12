/**
 * @fileoverview Ignex's API adapter over castrum's self-tested `BunFFI`
 * surface. No runtime detection, symbol map, dlopen, or native self-test lives
 * here; only return-shape and naming differences are adapted.
 */

import type { BunFFI } from "@ignex/castrum/native";
import { safeJsonParse } from "../helpers";
import type { FfiSurface } from "../types";

/** Adapt castrum's native bridge to Ignex's existing FFI call surface. */
export const buildSurface = (ffi: BunFFI): FfiSurface => {
  return {
    ffiMode: "ffi",
    fnv1a64: (input) => ffi.fnv1a64(input),
    crc32: (input) => ffi.crc32(input) >>> 0,
    jsonValid: (input) => ffi.jsonValid(input),
    validateEmail: (input) => ffi.validateEmailBytes(input),
    validateUuid: (input) => ffi.validateUuidBytes(input),
    validateIpv4: (input) => ffi.validateIpv4Bytes(input),
    validateIpv6: (input) => ffi.validateIpv6Bytes(input),

    hmacSha256: (key, data) => {
      const out = new Uint8Array(64);
      const written = ffi.hmacSha256Into(key, data, out);
      if (written === 0) throw new Error("hmac sha256: output buffer too small");
      return out.subarray(0, written);
    },
    hmacSha256Verify: (key, data, sig) => ffi.hmacSha256Verify(key, data, sig),
    signCookie: (value, secret) => ffi.signCookie(value, secret),
    verifyCookie: (signed, secret) => ffi.verifyCookie(signed, secret),
    csrfToken: (secret) => ffi.csrfToken(secret),
    csrfVerify: (token, secret) => ffi.csrfVerify(token, secret),

    etag: (data, weak) => ffi.etag(data, weak),
    randomToken: (byteLen) => ffi.randomToken(byteLen),

    queryParsePacked: (input) => ffi.queryParsePacked(input),
    cookieParsePacked: (input) => ffi.cookieParsePacked(input),
    formParsePacked: (input) => ffi.formParsePacked(input),
    wsAcceptKey: (key) => ffi.wsAcceptKey(key),
    jwtSignBytes: (claims, secret, ttl, now) => ffi.jwtSignBytes(claims, secret, ttl ?? 0, now),
    jwtVerify: (token, secret, now) => safeJsonParse(ffi.jwtVerify(token, secret, now)),

    generateEd25519Keypair: () => {
      const pair = ffi.ed25519GenerateKeypair();
      const b64 = (bytes: Uint8Array): string =>
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
      return { privateKey: b64(pair.privateKey), publicKey: b64(pair.publicKey) };
    },
    ed25519Sign: (msg, privateKey) => ffi.ed25519Sign(msg, privateKey),
    ed25519Verify: (msg, signature, publicKey) => ffi.ed25519Verify(msg, signature, publicKey),
    jwtSignEddsa: (claims, privateKey, ttl, now) => {
      const token = ffi.jwtEdDSASign(claims, privateKey, ttl ?? 0, now);
      if (token === null) throw new Error("eddsa jwt sign: failed");
      return token;
    },
    jwtVerifyEddsa: (token, publicKey, now) =>
      safeJsonParse(ffi.jwtEdDSAVerify(token, publicKey, now)),

    brotliCompress: (data, quality) => ffi.brotliCompress(data, quality),
    brotliDecompress: (data, maxSize) => ffi.brotliDecompress(data, maxSize),
    aeadEncrypt: (key, nonce, plaintext, algorithm) =>
      ffi.aeadEncrypt(key, nonce, plaintext, algorithm === "chacha20-poly1305" ? 1 : 0),
    aeadDecrypt: (key, nonce, ciphertext, algorithm) =>
      ffi.aeadDecrypt(key, nonce, ciphertext, algorithm === "chacha20-poly1305" ? 1 : 0),
  };
};
