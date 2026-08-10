/**
 * Parity tests for `@flux/native`.
 *
 * These run against the pure-TS fallbacks by default (the addon is optional).
 * They lock the wire formats (cookie, CSRF, JWT, ETag, SSE, WS) to the native
 * addon's documented behavior, so behavior is identical with or without Rust.
 * Set `FLUX_NATIVE_PATH` (or install `castrum`) to run the same suite against
 * the real addon.
 */
import { describe, expect, it } from "vitest";
import {
  aeadDecrypt,
  aeadEncrypt,
  brotliCompress,
  brotliDecompress,
  crc32,
  csrfToken,
  csrfVerify,
  etag,
  fnv1a64,
  fnv1a64Fallback,
  gzipCompress,
  gzipDecompress,
  hmacSha256,
  hmacSha256Verify,
  jsonPatch,
  jsonValid,
  jwtSign,
  jwtVerify,
  mediaTypeMatches,
  parseAcceptEncoding,
  parseMediaType,
  parseQuery,
  passwordHash,
  passwordVerify,
  randomToken,
  renderTemplate,
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

const SECRET = "s3cret-value";

describe("hash", () => {
  it("fnv1a64 matches known FNV-1a 64 vectors", () => {
    expect(fnv1a64("")).toBe(0xcbf29ce484222325n);
    expect(fnv1a64("a")).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64Fallback(toBytes("hello"))).toBe(0xa430d84680aabd0bn);
    expect(fnv1a64("hello")).toBe(fnv1a64Fallback(toBytes("hello")));
  });

  it("crc32 matches known vectors", () => {
    expect(crc32("")).toBe(0);
    expect(crc32("hello")).toBe(0x3610a686);
  });
});

describe("hmac", () => {
  it("signs and verifies", () => {
    const sig = hmacSha256(SECRET, "payload");
    expect(hmacSha256Verify(SECRET, "payload", sig)).toBe(true);
    expect(hmacSha256Verify(SECRET, "tampered", sig)).toBe(false);
    expect(hmacSha256Verify("wrong-secret", "payload", sig)).toBe(false);
  });
});

describe("signed cookies", () => {
  it("uses value.<64-hex> format and round-trips", () => {
    const signed = signCookie("session=abc", SECRET);
    expect(signed.startsWith("session=abc.")).toBe(true);
    expect(signed.length).toBe("session=abc".length + 1 + 64);
    expect(verifyCookie(signed, SECRET)).toBe("session=abc");
  });

  it("rejects tampering and wrong secrets", () => {
    const signed = signCookie("v=1", SECRET);
    const tampered = signed.slice(0, -1) + (signed.endsWith("0") ? "1" : "0");
    expect(verifyCookie(tampered, SECRET)).toBeNull();
    expect(verifyCookie(signed, "other")).toBeNull();
    expect(verifyCookie("no-dot", SECRET)).toBeNull();
  });
});

describe("csrf", () => {
  it("produces <64-hex>.<64-hex> tokens that verify", () => {
    const token = csrfToken(SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect(csrfVerify(token, SECRET)).toBe(true);
    expect(csrfVerify(token, "other")).toBe(false);
    expect(csrfVerify("bad.token", SECRET)).toBe(false);
  });
});

describe("jwt", () => {
  it("signs and verifies HS256 with iat/exp injection", () => {
    const now = 1_700_000_000;
    const token = jwtSign({ sub: "42", role: "admin" }, SECRET, {
      ttlSeconds: 3600,
      nowSeconds: now,
    });
    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    const claims = jwtVerify(token, SECRET, { nowSeconds: now + 60 }) as Record<string, unknown>;
    expect(claims.sub).toBe("42");
    expect(claims.iat).toBe(now);
    expect(claims.exp).toBe(now + 3600);
  });

  it("rejects expired, future-iat, tampered and wrong-alg tokens", () => {
    const now = 1_700_000_000;
    const token = jwtSign({ sub: "1" }, SECRET, { ttlSeconds: 60, nowSeconds: now });
    expect(jwtVerify(token, SECRET, { nowSeconds: now + 61 })).toBeNull();
    expect(jwtVerify(token, SECRET, { nowSeconds: now + 10_000 })).toBeNull();

    const futureIat = jwtSign({ sub: "1", iat: now + 500 }, SECRET, { nowSeconds: now });
    expect(jwtVerify(futureIat, SECRET, { nowSeconds: now })).toBeNull();

    const [h, p, s] = token.split(".");
    const tampered = `${h}.${p}.${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
    expect(jwtVerify(tampered, SECRET, { nowSeconds: now })).toBeNull();
    expect(jwtVerify(token, "wrong", { nowSeconds: now })).toBeNull();

    // Non-HS256 header must be rejected (alg-confusion guard).
    const hs512 = `${Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" })).toString("base64url")}.${p}.${s}`;
    expect(jwtVerify(hs512, SECRET, { nowSeconds: now })).toBeNull();
  });
});

describe("random tokens & passwords", () => {
  it("randomToken returns 2x hex", () => {
    expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomToken(32)).toHaveLength(64);
  });

  it("password hash/verify round-trips on the scrypt path", () => {
    const phc = passwordHash("hunter2", "static-salt-0123456789");
    expect(phc.startsWith("$scrypt$")).toBe(true);
    expect(passwordVerify("hunter2", phc)).toBe(true);
    expect(passwordVerify("wrong", phc)).toBe(false);
  });
});

describe("aead", () => {
  it("AES-256-GCM round-trips and rejects tampering", () => {
    const key = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(12).fill(1);
    const cipher = aeadEncrypt(key, nonce, toBytes("secret message"));
    expect(cipher.length).toBe(14 + 16);
    expect(toBytes("secret message")).toEqual(aeadDecrypt(key, nonce, cipher));
    const tampered = cipher.slice();
    tampered[0] ^= 0xff;
    expect(aeadDecrypt(key, nonce, tampered)).toBeNull();
  });
});

describe("http", () => {
  it("parses query strings (decoding + last-wins)", () => {
    expect(parseQuery("a=1&b=two%20words&c=&a=2")).toEqual({ a: "2", b: "two words", c: "" });
  });

  it("parses media types and matches wildcards", () => {
    expect(parseMediaType('text/html; charset="utf-8"')).toMatchObject({
      mediaType: "text/html",
      charset: "utf-8",
    });
    expect(mediaTypeMatches("application/json; charset=utf-8", "application/*")).toBe(true);
    expect(mediaTypeMatches("application/json", "*/*")).toBe(true);
    expect(mediaTypeMatches("text/html", "application/json")).toBe(false);
  });

  it("generates crc32-based etags", () => {
    expect(etag("hello")).toBe('"3610a686"');
    expect(etag("hello", true)).toBe('W/"3610a686"');
  });

  it("parses Accept-Encoding with q values", () => {
    const prefs = parseAcceptEncoding("gzip, deflate;q=0.9, *;q=0.5");
    expect(prefs).toEqual([
      { encoding: "gzip", q: 1, order: 0 },
      { encoding: "deflate", q: 0.9, order: 1 },
      { encoding: "*", q: 0.5, order: 2 },
    ]);
  });
});

describe("json", () => {
  it("validates and patches", () => {
    expect(jsonValid('{"a":1}')).toBe(true);
    expect(jsonValid("{nope")).toBe(false);
    expect(
      JSON.parse(
        jsonPatch(
          '{"a":1,"b":2}',
          '[{"op":"replace","path":"/a","value":9},{"op":"add","path":"/c","value":3},{"op":"remove","path":"/b"}]',
        ),
      ),
    ).toEqual({ a: 9, c: 3 });
  });
});

describe("payload", () => {
  it("gzip/brotli round-trip", () => {
    const data = toBytes("hello hello hello hello hello");
    expect(gzipDecompress(gzipCompress(data))).toEqual(data);
    expect(brotliDecompress(brotliCompress(data))).toEqual(data);
  });

  it("encodes SSE events per spec (event line omitted when null)", () => {
    expect(sseEncode(null, "hello", "42", 3000)).toBe("id: 42\nretry: 3000\ndata: hello\n\n");
    expect(sseEncode("message", "hello\nworld")).toBe(
      "event: message\ndata: hello\ndata: world\n\n",
    );
  });

  it("ws frames encode/decode deterministically", () => {
    const frame = wsFrameEncode(1, toBytes("hi"), false, true);
    expect(wsFrameDecode(frame)).toEqual({ fin: true, opcode: 1, payload: toBytes("hi") });
    const masked = wsFrameEncode(1, toBytes("abc"), true, true);
    const decoded = wsFrameDecode(masked);
    expect(decoded).not.toBeNull();
    expect(decoded?.payload).toEqual(toBytes("abc"));
  });

  it("wsAcceptKey matches RFC 6455 example", () => {
    expect(wsAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

describe("templates", () => {
  it("interpolates, branches and loops (fallback subset)", () => {
    expect(renderTemplate("Hello {{ name }}!", { name: "world" })).toBe("Hello world!");
    expect(renderTemplate("{% if ok %}Y{% else %}N{% endif %}", { ok: true })).toBe("Y");
    expect(renderTemplate("{% for x in xs %}{{ x }},{% endfor %}", { xs: [1, 2, 3] })).toBe(
      "1,2,3,",
    );
    expect(renderTemplate("{{ title | upper }}", { title: "hi" })).toBe("HI");
  });
});

describe("validation", () => {
  it("validates common inputs", () => {
    expect(validateEmail("a@b.com")).toBe(true);
    expect(validateEmail("nope")).toBe(false);
    expect(validateUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(validateUuid("not-a-uuid")).toBe(false);
    expect(validateIpv4("192.168.0.1")).toBe(true);
    expect(validateIpv4("999.1.1.1")).toBe(false);
    expect(validateIpv6("::1")).toBe(true);
    expect(validateIpv6("not-an-ip")).toBe(false);
  });
});
