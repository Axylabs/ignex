/**
 * Parity tests for `@ignus/native`.
 *
 * These run against the pure-TS fallbacks by default (the addon is optional).
 * They lock the wire formats (cookie, CSRF, JWT, ETag, SSE, WS) to the native
 * addon's documented behavior, so behavior is identical with or without Rust.
 * Set `IGNUS_NATIVE_PATH` (or install `castrum`) to run the same suite against
 * the real addon.
 */
import { describe, expect, it } from "vitest";
import {
  aeadDecrypt,
  aeadEncrypt,
  brotliCompress,
  brotliDecompress,
  crc32,
  createAcceptNegotiator,
  createConditionalRequest,
  createNativePipeline,
  createRateLimiter,
  createRateLimiterFallback,
  createSchemaValidator,
  csrfToken,
  csrfVerify,
  etag,
  fnv1a64,
  fnv1a64Fallback,
  formPairs,
  gzipCompress,
  gzipDecompress,
  hmacSha256,
  hmacSha256Verify,
  initNative,
  isNativeAvailable,
  jsonPatch,
  jsonValid,
  jwtSign,
  jwtVerify,
  mediaTypeMatches,
  parseAcceptEncoding,
  parseForm,
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

  it("password hash/verify round-trips (argon2id native / scrypt fallback)", () => {
    const phc = passwordHash("hunter2", "static-salt-0123456789");
    expect(phc.startsWith("$argon2id$") || phc.startsWith("$scrypt$")).toBe(true);
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

describe("form parsing", () => {
  it("parses x-www-form-urlencoded bodies (decoding + last-wins)", () => {
    expect(formPairs("a=1&b=two%20words&c=&a=2")).toEqual([
      ["a", "1"],
      ["b", "two words"],
      ["c", ""],
      ["a", "2"],
    ]);
    expect(parseForm("a=1&b=two%20words&c=&a=2")).toEqual({ a: "2", b: "two words", c: "" });
    expect(parseForm("x=hello+world")).toEqual({ x: "hello world" });
    expect(parseForm("")).toEqual({});
  });
});

describe("conditional requests", () => {
  it("304 semantics match castrum ConditionalRequest (RFC 7232)", () => {
    const cond = createConditionalRequest('"abc123"', 1_700_000_000);
    // If-None-Match: exact, weak-prefixed, and `*` all match.
    expect(cond.isNotModified('"abc123"')).toBe(true);
    expect(cond.isNotModified('W/"abc123"')).toBe(true);
    expect(cond.isNotModified('"other", "abc123"')).toBe(true);
    expect(cond.isNotModified("*")).toBe(true);
    // Mismatch → not modified is false, and IMS is ignored when INM present.
    expect(cond.isNotModified('"other"', "Sun, 06 Nov 1994 08:49:37 GMT")).toBe(false);
    // No INM → IMS decides (>= lastModified).
    const ims = new Date(1_700_000_000 * 1000).toUTCString();
    expect(cond.isNotModified(null, ims)).toBe(true);
    expect(cond.isNotModified(null, "Sun, 06 Nov 1994 08:49:37 GMT")).toBe(false);
  });

  it("lastModifiedSecs 0 disables If-Modified-Since", () => {
    const cond = createConditionalRequest('"abc"', 0);
    const ims = new Date(1_700_000_000 * 1000).toUTCString();
    expect(cond.isNotModified(null, ims)).toBe(false);
  });
});

describe("accept negotiation", () => {
  it("negotiates by specificity, then q, then client order", () => {
    const neg = createAcceptNegotiator(["gzip", "br"]);
    // Exact beats wildcard at equal q.
    expect(neg.negotiate("gzip, *;q=0.1")).toBe("gzip");
    // Wildcard only matches the first supported entry.
    expect(neg.negotiate("*;q=1")).toBe("gzip");
    // q ordering picks br when the wildcard (gzip) is deprioritized.
    expect(neg.negotiate("br;q=0.9, *;q=0.5")).toBe("br");
    // q=0 excludes.
    expect(neg.negotiate("gzip;q=0, *;q=1")).toBe("br");
    // Unsupported → null.
    expect(neg.negotiate("deflate")).toBeNull();
    // Empty header → first supported.
    expect(neg.negotiate("")).toBe("gzip");
  });
});

describe("json schema", () => {
  it("returns a validator when native is available (null otherwise)", () => {
    const v = createSchemaValidator(
      '{"type":"object","properties":{"a":{"type":"number"}},"required":["a"]}',
    );
    if (v) {
      expect(v.validate('{"a":1}')).toBe(true);
      expect(v.validate('{"a":"x"}')).toBe(false);
    } else {
      expect(v).toBeNull();
    }
  });
});

describe("pipeline bridge", () => {
  it("resolves to null when the native pipeline is unavailable (never throws)", async () => {
    const pipeline = await createNativePipeline({});
    if (isNativeAvailable()) {
      expect(pipeline).not.toBeNull();
    } else {
      expect(pipeline).toBeNull();
    }
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

describe("loader / eager init", () => {
  it("initNative is idempotent and never throws", () => {
    const first = initNative();
    const second = initNative({ threads: 1 });
    expect(first.available).toBe(isNativeAvailable());
    expect(second.available).toBe(first.available);
    // available=true implies a positive (or zero) rayon thread count
    if (first.available) {
      expect(first.rayonThreads).toBeGreaterThanOrEqual(0);
    } else {
      expect(first.rayonThreads).toBe(0);
    }
  });
});

describe("rate limiter", () => {
  it("allows up to limit then denies, and resets after the window", () => {
    const now = Date.now();
    const nativeLim = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const fallbackLim = createRateLimiterFallback({ limit: 2, windowMs: 60_000 });

    // Both paths: 2 allowed, 3rd denied, different key unaffected.
    for (const lim of [nativeLim, fallbackLim]) {
      expect(lim.check("a", now).allowed).toBe(true);
      expect(lim.check("a", now).allowed).toBe(true);
      expect(lim.check("a", now).allowed).toBe(false);
      expect(lim.check("b", now).allowed).toBe(true);
      const denied = lim.check("a", now);
      expect(denied.remaining).toBe(0);
      expect(denied.resetMs).toBeGreaterThan(now);
    }
  });

  it("recovers after the window elapses (both paths)", () => {
    const now = Date.now();
    for (const lim of [
      createRateLimiter({ limit: 1, windowMs: 60_000 }),
      createRateLimiterFallback({ limit: 1, windowMs: 60_000 }),
    ]) {
      expect(lim.check("k", now).allowed).toBe(true);
      expect(lim.check("k", now).allowed).toBe(false);
      // After two full windows the budget resets.
      expect(lim.check("k", now + 120_000).allowed).toBe(true);
    }
  });

  it("zero limit denies everything; independent instances are isolated", () => {
    const zero = createRateLimiter({ limit: 0, windowMs: 60_000 });
    expect(zero.check("x", Date.now()).allowed).toBe(false);
    expect(
      createRateLimiterFallback({ limit: 0, windowMs: 60_000 }).check("x", Date.now()).allowed,
    ).toBe(false);

    const a = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const b = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(a.check("same", Date.now()).allowed).toBe(true);
    expect(b.check("same", Date.now()).allowed).toBe(true);
  });
});

describe("validation", () => {
  it("validates common inputs", () => {
    expect(validateEmail("a@b.com")).toBe(true);
    expect(validateEmail("nope")).toBe(false);
    // Native parity: castrum accepts version-4 UUIDs only.
    expect(validateUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(validateUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    expect(validateUuid("not-a-uuid")).toBe(false);
    expect(validateIpv4("192.168.0.1")).toBe(true);
    expect(validateIpv4("999.1.1.1")).toBe(false);
    expect(validateIpv6("::1")).toBe(true);
    expect(validateIpv6("not-an-ip")).toBe(false);
  });
});
