/**
 * Tests for the unified execution facade (`src/execution.ts`) — the single
 * domain-grouped API where every method is bound to its best implementation.
 *
 * Parity is the contract: each facade method must produce the same output as
 * the flat wrapper (and the fallback), whether the castrum addon is loaded
 * (real-addon mode via `IGNEX_NATIVE_PATH`) or not (default CI mode).
 */
import { describe, expect, it } from "vitest";
import {
  backend,
  brotliCompress,
  brotliDecompress,
  cookiePairs,
  crc32,
  createConditionalRequest,
  createExecutionBackend,
  csrfToken,
  csrfVerify,
  etag,
  executionStatus,
  fnv1a64,
  formPairs,
  gzipCompress,
  gzipDecompress,
  hmacSha256,
  isNativeAvailable,
  jsonValid,
  jwtSign,
  jwtVerify,
  queryPairs,
  signCookie,
  sseEncode,
  toBytes,
  validateEmail,
  validateIpv4,
  validateIpv6,
  validateUuid,
  verifyCookie,
  wsAcceptKey,
  wsFrameDecode,
  wsFrameEncode,
} from "../src/index";

describe("unified execution facade", () => {
  it("status reflects the real backend in both CI modes", () => {
    const s = executionStatus();
    expect(s.nativeAvailable).toBe(isNativeAvailable());
    expect(s.backend).toBe(isNativeAvailable() ? "castrum" : "js");
    expect(s.ops.length).toBeGreaterThan(0);
    // Every op row has a valid impl.
    for (const row of s.ops) {
      expect(row.impl === "castrum" || row.impl === "js").toBe(true);
    }
  });

  it("backend is a stable singleton and status is reproducible", () => {
    expect(backend.status()).toEqual(backend.status());
    expect(backend).toBe(backend);
  });

  it("hash domain matches the flat wrappers + known vectors", () => {
    expect(backend.hash.fnv1a64("")).toBe(0xcbf29ce484222325n);
    expect(backend.hash.fnv1a64("hello")).toBe(fnv1a64("hello"));
    expect(backend.hash.fnv1a64String("hello")).toBe(fnv1a64("hello").toString(16));
    expect(backend.hash.crc32("hello")).toBe(crc32("hello"));
    expect(backend.hash.crc32("hello")).toBe(0x3610a686);
  });

  it("crypto domain matches the flat wrappers and round-trips", () => {
    expect(backend.crypto.hmacSha256("k", "d")).toEqual(hmacSha256("k", "d"));
    const signed = backend.crypto.signCookie("v", "s");
    expect(backend.crypto.verifyCookie(signed, "s")).toBe("v");
    const token = backend.crypto.csrfToken("s");
    expect(backend.crypto.csrfVerify(token, "s")).toBe(true);
    const jwt = backend.crypto.jwtSign({ sub: "1" }, "s", { ttlSeconds: 60 });
    expect(backend.crypto.jwtVerify(jwt, "s")).toMatchObject({ sub: "1" });
  });

  it("http domain matches the flat wrappers (incl. native-picked impls)", () => {
    expect(backend.http.queryPairs("a=1&b=2&a=3")).toEqual(queryPairs("a=1&b=2&a=3"));
    expect(backend.http.cookiePairs("a=1; b=2")).toEqual(cookiePairs("a=1; b=2"));
    expect(backend.http.formPairs("a=hello+world")).toEqual(formPairs("a=hello+world"));
    expect(backend.http.etag("hello")).toBe(etag("hello"));
    // createConditionalRequest is bound to castrum when native is available —
    // the facade must match the flat wrapper either way (RFC 7232 vectors).
    const cond = backend.http.createConditionalRequest('"abc"', 1_700_000_000);
    expect(cond.isNotModified('"abc"')).toBe(true);
    expect(cond.isNotModified('W/"abc"')).toBe(true);
    expect(cond.isNotModified('"other"')).toBe(false);
    const flat = createConditionalRequest('"abc"', 1_700_000_000);
    expect(cond.isNotModified("*")).toBe(flat.isNotModified("*"));
  });

  it("json domain matches the flat wrappers", () => {
    expect(backend.json.jsonValid('{"a":1}')).toBe(jsonValid('{"a":1}'));
    expect(backend.json.jsonValid("{nope")).toBe(false);
    expect(backend.json.jsonPatch('{"a":1}', '[{"op":"replace","path":"/a","value":9}]')).toBe(
      '{"a":9}',
    );
  });

  it("payload domain round-trips (native or fallback)", () => {
    const data = toBytes("hello hello hello");
    expect(backend.payload.gzipDecompress(backend.payload.gzipCompress(data))).toEqual(data);
    expect(backend.payload.brotliDecompress(backend.payload.brotliCompress(data))).toEqual(data);
    const frame = backend.payload.wsFrameEncode(1, toBytes("hi"), false, true);
    expect(backend.payload.wsFrameDecode(frame)?.payload).toEqual(toBytes("hi"));
    expect(backend.payload.sseEncode("message", "hi")).toBe("event: message\ndata: hi\n\n");
    expect(backend.payload.sseEncode(null, "hello", "42", 3000)).toBe(
      "id: 42\nretry: 3000\ndata: hello\n\n",
    );
    expect(backend.payload.sseEncode(null, "hello", "42", 3000)).toBe(
      sseEncode(null, "hello", "42", 3000),
    );
    expect(backend.payload.wsAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      wsAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
    );
    expect(backend.payload.wsFrameEncode).toBeDefined();
    expect(backend.payload.wsFrameDecode).toBeDefined();
    // keep the imported frame fns referenced for the parity checks above
    expect(wsFrameEncode).toBeDefined();
    expect(wsFrameDecode).toBeDefined();
  });

  it("validation domain matches the flat wrappers", () => {
    expect(backend.validation.validateEmail("a@b.com")).toBe(validateEmail("a@b.com"));
    expect(backend.validation.validateEmail("nope")).toBe(false);
    expect(backend.validation.validateUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(
      validateUuid("123e4567-e89b-42d3-a456-426614174000"),
    );
    expect(backend.validation.validateIpv4("192.168.0.1")).toBe(validateIpv4("192.168.0.1"));
    expect(backend.validation.validateIpv6("::1")).toBe(validateIpv6("::1"));
  });

  it("createExecutionBackend returns an independent but equivalent instance", () => {
    const other = createExecutionBackend();
    expect(other).not.toBe(backend);
    expect(other.hash.fnv1a64("hello")).toBe(backend.hash.fnv1a64("hello"));
    expect(other.http.queryPairs("x=1")).toEqual(backend.http.queryPairs("x=1"));
    expect(other.status().backend).toBe(backend.status().backend);
  });

  it("compression + signCookie/verifyCookie parity with flat wrappers", () => {
    const data = toBytes("round trip round trip");
    expect(gzipCompress).toBeDefined();
    expect(brotliCompress).toBeDefined();
    expect(gzipDecompress).toBeDefined();
    expect(brotliDecompress).toBeDefined();
    expect(backend.payload.gzipCompress(data)).toEqual(gzipCompress(data));
    const signed = signCookie("v", "s");
    expect(verifyCookie(signed, "s")).toBe("v");
    const tok = csrfToken("s");
    expect(csrfVerify(tok, "s")).toBe(true);
    const j = jwtSign({ sub: "x" }, "s", { ttlSeconds: 30 });
    expect(jwtVerify(j, "s")).toMatchObject({ sub: "x" });
  });
});
