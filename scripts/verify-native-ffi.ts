/**
 * Verify the C-ABI scalar writers (`castrum_query_parse_packed`,
 * `castrum_cookie_parse_packed`, `castrum_form_parse_packed`) end-to-end under
 * plain Bun — where `bun:ffi` dlopen works (vitest workers do not expose it,
 * so the FFI transport is not exercised there).
 *
 * This is the parity gate for the Section-C sweep + the cstring-return fix:
 * the pair writers use the needed-size convention (exact required size on a
 * too-small buffer instead of `0`) with the `packedWrite` growExact wrapper.
 * NOTE: the `castrum_query_to_json` / `castrum_cookies_to_json` writers were
 * REMOVED by castrum — those ops are JS-only now (http/queryToJson.ts), so
 * this script no longer checks them. It asserts:
 *   1. byte-parity with the JS fallbacks on the parity vectors, AND
 *   2. the growExact path is actually exercised — a pathological input whose
 *      packed output exceeds the wrapper's TIGHT initial bound
 *      (`len*4+16` / `len*4+64`) forces the miss, and the exact-size retry
 *      still lands byte-identical to the JS fallback.
 *
 * Usage:
 *   IGNEX_NATIVE_PATH=/path/to/castrum.linux-x64-gnu.node bun scripts/verify-native-ffi.ts
 *
 * Exits 0 when the FFI surface is unavailable (graceful null fallback is the
 * contract) or when it is available and all parity + growExact checks pass.
 * Exits 1 on any mismatch.
 */
import {
  aeadDecrypt,
  aeadEncrypt,
  brotliCompress,
  brotliDecompress,
  cookiePairs,
  createAcceptNegotiator,
  createConditionalRequest,
  createNativeIngress,
  createSchemaValidator,
  createTemplate,
  csrfToken,
  csrfVerify,
  csrfVerifyFallback,
  ed25519Sign,
  ed25519Verify,
  etag,
  etagFallback,
  formPairs,
  generateEd25519Keypair,
  getFfi,
  jwtSign,
  jwtSignEdDsa,
  jwtVerifyEdDsa,
  queryPairs,
  randomToken,
  readPairsPacked,
  signCookie,
  signCookieFallback,
  verifyCookie,
  wsAcceptKey,
} from "@ignex/native";

const ffi = getFfi();
if (ffi === null) {
  console.log("FFI surface unavailable — graceful null fallback OK (no bun:ffi / addon).");
  process.exit(0);
}

const encoder = new TextEncoder();
const enc = (s: string): Uint8Array => encoder.encode(s);

let failures = 0;
let checks = 0;

/** Compare a native writer (via the normal wrapper) against a JS fallback. */
const expectParity = (label: string, native: () => unknown, fallback: () => unknown): void => {
  checks++;
  const n = native();
  const f = fallback();
  const eq = JSON.stringify(n) === JSON.stringify(f);
  if (!eq) {
    failures++;
    console.log(`FAIL ${label}`);
    console.log(`  native  : ${JSON.stringify(n)}`);
    console.log(`  fallback: ${JSON.stringify(f)}`);
  }
};

/** Byte equality for two `Uint8Array`s. */
const eqBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === (b[i] as number));

const { queryParsePacked, cookieParsePacked, formParsePacked } = ffi;

// ── 1. Byte parity through the public wrappers ────────────────────
const QUERY_CASES = [
  "a=1&b=hello%20world&c=2",
  "u=%E2%9C%93", // UTF-8 ✓
  "p=a+b", // + → space
  "k=%2B", // %2B → literal +
  "k&k2=", // empty value
  "page=1&limit=20&sort=desc&filter[a]=x&filter[b]=y",
  `q=${"x".repeat(512)}`, // large single value
  "a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a&a", // forces growExact (30 × 1-byte keys)
];
const COOKIE_CASES = [
  "sid=abc123; theme=dark",
  'a=1; "quoted"=val;  spaced = x ',
  "empty=; bare",
  "session=abc; prefs=%7B%22lang%22%3A%22en%22%7D",
];
const FORM_CASES = [
  "name=John%20Doe&age=30",
  "a=b&a=c", // duplicate keys
  "x=1&y=2&z=3&w=4&v=5",
];

for (const q of QUERY_CASES) {
  const bytes = enc(q);
  expectParity(
    `queryPairs "${q.slice(0, 40)}"`,
    () => readPairsPacked(queryParsePacked(bytes)),
    () => queryPairs(q),
  );
}
for (const c of COOKIE_CASES) {
  const bytes = enc(c);
  expectParity(
    `cookiePairs "${c.slice(0, 40)}"`,
    () => readPairsPacked(cookieParsePacked(bytes)),
    () => cookiePairs(c),
  );
}
for (const f of FORM_CASES) {
  expectParity(
    `formPairs "${f.slice(0, 40)}"`,
    () => readPairsPacked(formParsePacked(enc(f))),
    () => formPairs(f),
  );
}

// ── 1b. cstring-returning scalar ops (engine-cloned strings) ──────
// The 5 ops converted to `cstring` return: signCookie/verifyCookie/csrfToken/
// randomToken/etag now cross as plain strings — zero JS decode/alloc. Verify
// byte-parity with the JS fallbacks, the sign→verify roundtrip, tamper→null,
// and the format invariants.
{
  const SECRET = "s".repeat(32);
  const secBytes = enc(SECRET);
  const VALUES = ["session=abc", "theme=dark", "x", "", "a=b&c=d"];
  for (const value of VALUES) {
    expectParity(
      `signCookie "${value || "<empty>"}"`,
      () => signCookie(value, SECRET),
      () => signCookieFallback(value, secBytes),
    );
    const signed = signCookie(value, SECRET);
    checks++;
    if (verifyCookie(signed, SECRET) !== value) {
      failures++;
      console.log(`FAIL verifyCookie roundtrip for ${JSON.stringify(value)}`);
    }
    // Tamper the last sig char → null.
    checks++;
    const tampered = signed.slice(0, -1) + (signed.endsWith("0") ? "1" : "0");
    if (verifyCookie(tampered, SECRET) !== null) {
      failures++;
      console.log(`FAIL verifyCookie tamper for ${JSON.stringify(value)}`);
    }
  }
  // Direct FFI surface also returns strings.
  const sVal = enc("session=abc");
  expectParity(
    "ffi.signCookie",
    () => ffi.signCookie(sVal, secBytes),
    () => signCookieFallback("session=abc", secBytes),
  );
  checks++;
  const ffiSigned = ffi.signCookie(sVal, secBytes);
  if (
    typeof ffiSigned !== "string" ||
    ffi.verifyCookie(enc(ffiSigned), secBytes) !== "session=abc"
  ) {
    failures++;
    console.log("FAIL ffi.signCookie/verifyCookie are NOT cstring strings");
  }

  // CSRF: 129 chars `64hex.64hex`, cross-verify, wrong-secret fails.
  checks++;
  const token = csrfToken(SECRET);
  if (!(token.length === 129 && token[64] === ".")) {
    failures++;
    console.log(`FAIL csrfToken format: ${token.length}`);
  }
  expectParity(
    "csrfVerify",
    () => csrfVerify(token, SECRET),
    () => csrfVerifyFallback(token, enc(SECRET)),
  );
  checks++;
  if (csrfVerify(token, "x".repeat(32)) !== false) {
    failures++;
    console.log("FAIL csrfVerify wrong secret");
  }
  expectParity(
    "ffi.csrfToken",
    () => ffi.csrfToken(secBytes).length === 129,
    () => true,
  );

  // randomToken: 2×byteLen lowercase hex.
  checks++;
  const rt = randomToken(16);
  if (!(rt.length === 32 && /^[0-9a-f]+$/.test(rt))) {
    failures++;
    console.log(`FAIL randomToken format: ${rt.length}`);
  }
  checks++;
  const ffiRt = ffi.randomToken(16);
  if (typeof ffiRt !== "string" || !/^[0-9a-f]{32}$/.test(ffiRt)) {
    failures++;
    console.log("FAIL ffi.randomToken is NOT a 32-hex cstring string");
  }

  // ETag strong + weak parity.
  const eData = "hello world";
  const eBytes = enc(eData);
  expectParity(
    "etag strong",
    () => etag(eData),
    () => etagFallback(eBytes, false),
  );
  expectParity(
    "etag weak",
    () => etag(eData, true),
    () => etagFallback(eBytes, true),
  );
  expectParity(
    "ffi.etag",
    () => ffi.etag(eBytes),
    () => etagFallback(eBytes, false),
  );

  // ── 1c. Newly-bound C-ABI ops: wsAcceptKey, jwtSign, brotli, aead ──
  // wsAcceptKey (cstring): RFC 6455 test vector (deterministic) + ffi surface.
  const WS_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
  checks++;
  if (wsAcceptKey(WS_KEY) !== "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") {
    failures++;
    console.log("FAIL wsAcceptKey RFC vector");
  }
  expectParity(
    "ffi.wsAcceptKey",
    () => ffi.wsAcceptKey(WS_KEY),
    () => "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );

  // jwtSign (cstring): compact-JWT format (exactly 2 dots).
  const jTok = jwtSign({ sub: "user-1" }, SECRET, { ttlSeconds: 60, nowSeconds: 1_700_000_000 });
  checks++;
  if (typeof jTok !== "string" || jTok.split(".").length !== 3) {
    failures++;
    console.log("FAIL jwtSign format");
  }
  checks++;
  const ffiJwt = ffi.jwtSignBytes(enc('{"sub":"user-1"}'), enc(SECRET), 60, 1_700_000_000);
  if (typeof ffiJwt !== "string" || ffiJwt.split(".").length !== 3) {
    failures++;
    console.log("FAIL ffi.jwtSignBytes format");
  }

  // Ed25519 / EdDSA JWT (RBAC auth): DER format + cross-transport verify.
  // Keypair generation is RANDOM, so no byte parity — verify the DER shapes
  // on the ffi surface, then sign with the ffi keypair and verify through the
  // public wrappers (which prefer the ffi surface when live), plus an EdDSA
  // JWT sign→verify round trip + tamper/expiry rejection.
  const pair = generateEd25519Keypair();
  const priv = new Uint8Array(Buffer.from(pair.privateKey, "base64url"));
  const pub = new Uint8Array(Buffer.from(pair.publicKey, "base64url"));
  checks++;
  if (priv.length !== 48 || pub.length !== 44) {
    failures++;
    console.log(`FAIL ed25519 keypair DER lengths: priv=${priv.length} pub=${pub.length}`);
  }
  const sig = ed25519Sign(enc("integration plan"), pair.privateKey);
  checks++;
  if (sig.length !== 64 || !ed25519Verify(enc("integration plan"), sig, pair.publicKey)) {
    failures++;
    console.log("FAIL ed25519 sign/verify round trip");
  }
  checks++;
  if (ed25519Verify(enc("tampered"), sig, pair.publicKey)) {
    failures++;
    console.log("FAIL ed25519 verify should reject tampered message");
  }
  const eTok = jwtSignEdDsa({ sub: "user-1", roles: ["admin"] }, pair.privateKey, {
    ttlSeconds: 60,
    nowSeconds: 1_700_000_000,
  });
  checks++;
  if (typeof eTok !== "string" || eTok.split(".").length !== 3) {
    failures++;
    console.log("FAIL EdDSA jwt token format");
  }
  checks++;
  const eClaims = jwtVerifyEdDsa(eTok, pair.publicKey, { nowSeconds: 1_700_000_030 });
  if ((eClaims as Record<string, unknown>)?.sub !== "user-1") {
    failures++;
    console.log("FAIL EdDSA jwt verify");
  }
  checks++;
  if (jwtVerifyEdDsa(eTok, pair.publicKey, { nowSeconds: 1_700_000_100 }) !== null) {
    failures++;
    console.log("FAIL EdDSA jwt should be expired");
  }

  // brotli roundtrip via public wrappers + ffi surface.
  const bData = enc("hello world".repeat(50));
  const bC = brotliCompress(bData, 6);
  checks++;
  if (!(bC.length > 0 && eqBytes(brotliDecompress(bC), bData))) {
    failures++;
    console.log("FAIL brotli roundtrip (public)");
  }
  checks++;
  const bC2 = ffi.brotliCompress(bData, 6);
  if (!(bC2.length > 0 && eqBytes(ffi.brotliDecompress(bC2, 1 << 20), bData))) {
    failures++;
    console.log("FAIL brotli roundtrip (ffi)");
  }

  // aead encrypt/decrypt roundtrip + auth-fail null.
  const aKey = enc("k".repeat(32));
  const aNonce = enc("n".repeat(12));
  const aCt = aeadEncrypt(aKey, aNonce, bData, "aes-256-gcm");
  checks++;
  const aPt = aeadDecrypt(aKey, aNonce, aCt, "aes-256-gcm");
  if (!(aPt != null && eqBytes(aPt, bData))) {
    failures++;
    console.log("FAIL aead roundtrip");
  }
  checks++;
  if (aeadDecrypt(aKey, aNonce, new Uint8Array(aCt.length), "aes-256-gcm") !== null) {
    failures++;
    console.log("FAIL aead auth-fail should be null");
  }
  checks++;
  const ffiPt = ffi.aeadDecrypt(aKey, aNonce, aCt, "aes-256-gcm");
  if (!(ffiPt != null && eqBytes(ffiPt, bData))) {
    failures++;
    console.log("FAIL ffi.aead roundtrip");
  }
}

// ── 2. growExact path was exercised on the pathological vector ────
// The 30 × "a&" query above overflows the wrapper's `len*4+16` initial bound
// (output 9 bytes/pair ≫ 4×input), so the needed-size signal + exact retry
// MUST have run for both the packed and JSON writers to land the right bytes.
// Parity in section 1 already proves correctness; this just asserts the miss
// actually happened (not silently swallowed by a lucky oversized first guess).
{
  checks++;
  const pathological = QUERY_CASES[QUERY_CASES.length - 1];
  const bytes = enc(pathological);
  const packed = queryParsePacked(bytes);
  const initial = bytes.length * 4 + 16;
  if (packed.length <= initial) {
    failures++;
    console.log(
      `FAIL growExact: pathological query fit the initial ${initial}-byte buffer (packed=${packed.length}) — the needed-size path did NOT run.`,
    );
  } else {
    console.log(
      `growExact exercised: pathological query needed ${packed.length} bytes (> initial ${initial}) → exact-size retry landed.`,
    );
  }
}

// ── 2. Opaque-handle instance ops (opaque-handle C-ABI fast path) ──
// castrum's Phase-6 instances evaluate per-call ops through `castrum_*` C-ABI
// symbols via `innerPtr()`. Verify the public wrappers (which now route to the
// C-ABI when the instance surface is live) match the NAPI/JS semantics.
{
  // SchemaValidator: validate against the compiled schema on valid/invalid docs.
  const svFfi = createSchemaValidator(
    JSON.stringify({ type: "object", required: ["a"], properties: { a: { type: "number" } } }),
  );
  if (!svFfi) {
    checks++;
    failures++;
    console.log("FAIL instance: createSchemaValidator returned null");
  } else {
    for (const [label, doc, expect] of [
      ["valid", '{"a":1}', true],
      ["missing-required", "{}", false],
      ["invalid-json", "nope", false],
    ] as const) {
      checks++;
      if (svFfi.validate(doc) !== expect) {
        failures++;
        console.log(`FAIL SchemaValidator.validate ${label}: got ${svFfi.validate(doc)}`);
      }
    }
  }

  // TemplateRenderer: render with a pre-serialized JSON context.
  checks++;
  const tpl = createTemplate("Hello {{ name }}!");
  if (tpl({ name: "world" }) !== "Hello world!") {
    failures++;
    console.log(`FAIL TemplateRenderer.render: got ${tpl({ name: "world" })}`);
  }

  // AcceptNegotiator: negotiate a supported + an unsupported header.
  checks++;
  const an = createAcceptNegotiator(["gzip", "br"]);
  if (an.negotiate("gzip, deflate;q=0.5") !== "gzip") {
    failures++;
    console.log("FAIL AcceptNegotiator.negotiate gzip");
  }
  checks++;
  if (an.negotiate("deflate") !== null) {
    failures++;
    console.log("FAIL AcceptNegotiator.negotiate no-match");
  }

  // ConditionalRequest: RFC 7232 vectors (If-None-Match precedence, weak
  // compare, `*`, If-Modified-Since).
  {
    const cr = createConditionalRequest('"abc123"', 784111777);
    const cases: Array<[string | null, string | null, boolean]> = [
      ['"abc123"', null, true],
      ['W/"abc123"', null, true],
      ["*", null, true],
      ['"xyz", "other"', null, false],
      [null, "Sun, 06 Nov 1994 08:49:37 GMT", true],
      [null, "Sun, 06 Nov 1994 08:49:36 GMT", false],
      [null, null, false],
    ];
    for (const [inm, ims, expect] of cases) {
      checks++;
      const got = cr.isNotModified(inm, ims);
      if (got !== expect) {
        failures++;
        console.log(`FAIL ConditionalRequest.isNotModified ${inm} / ${ims}: got ${got}`);
      }
    }
  }
}

// ── 3. Direct C-ABI ingress pipeline (`createNativeIngress`) ──────
// One `castrum_ingress_handle_components` call per request (cstring url/ip, no
// JS encode/decode) driving the full native pipeline. Verify the normalized
// outcome: non-terminal OK, rate-limit terminal (429 + ratelimit-*), CORS
// preflight terminal (204 + access-control-*), query-limit terminal.
{
  const limitsOpts = {
    limits: {
      maxUrlBytes: 65536,
      maxQueryBytes: 16384,
      maxCookieBytes: 8192,
      maxHeadersBytes: 65536,
      maxHeaders: 100,
    },
  };
  const secRuntime = {
    securityHeaders: [
      ["x-frame-options", "DENY"],
      ["x-content-type-options", "nosniff"],
      ["referrer-policy", "no-referrer"],
    ] as [string, string][],
  };

  const ing = createNativeIngress(limitsOpts, secRuntime);
  if (!ing) {
    checks++;
    failures++;
    console.log("FAIL ingress: createNativeIngress returned null");
  } else {
    // OK path — non-terminal.
    checks++;
    const ok = await ing.preprocess(
      new Request("http://localhost:3000/api/users?page=1", { method: "GET" }),
      "127.0.0.1",
    );
    if (ok.terminal || !ok.result?.ok) {
      failures++;
      console.log(
        `FAIL ingress ok-path: terminal=${ok.terminal} result=${JSON.stringify(ok.result)}`,
      );
    }

    // Security headers on a terminal response (rate-limit).
    checks++;
    const rl = createNativeIngress({ rateLimit: { limit: 1, windowMs: 60000 } }, secRuntime);
    if (!rl) {
      failures++;
      console.log("FAIL ingress: rate-limit instance null");
    } else {
      const rr = new Request("http://localhost:3000/x", { method: "GET" });
      await rl.preprocess(rr, "127.0.0.1");
      const t = await rl.preprocess(rr, "127.0.0.1");
      if (
        !t.terminal ||
        t.response?.status !== 429 ||
        t.response.headers.get("ratelimit-limit") !== "1" ||
        t.response.headers.get("x-frame-options") !== "DENY"
      ) {
        failures++;
        console.log(
          `FAIL ingress rate-limit terminal: ${JSON.stringify({ status: t.response?.status, rl: t.response?.headers.get("ratelimit-limit"), sec: t.response?.headers.get("x-frame-options") })}`,
        );
      }
    }

    // CORS preflight terminal (204 + echo headers).
    checks++;
    const cors = createNativeIngress({
      cors: {
        allowOrigin: ["https://app.example.com"],
        allowMethods: ["GET"],
        allowCredentials: true,
      },
    });
    if (!cors) {
      failures++;
      console.log("FAIL ingress: CORS instance null");
    } else {
      const pre = await cors.preprocess(
        new Request("http://localhost:3000/api", {
          method: "OPTIONS",
          headers: { origin: "https://app.example.com", "access-control-request-method": "GET" },
        }),
        "127.0.0.1",
      );
      if (
        !pre.terminal ||
        pre.response?.status !== 204 ||
        pre.response.headers.get("access-control-allow-origin") !== "https://app.example.com"
      ) {
        failures++;
        console.log(
          `FAIL ingress CORS preflight: ${JSON.stringify({ status: pre.response?.status, origin: pre.response?.headers.get("access-control-allow-origin") })}`,
        );
      }
    }

    // Query-limit enforcement (parseQuery on).
    checks++;
    const pq = createNativeIngress({ parseQuery: true, limits: { maxQueryBytes: 1024 } });
    if (!pq) {
      failures++;
      console.log("FAIL ingress: query-limit instance null");
    } else {
      const q = await pq.preprocess(
        new Request(`http://localhost:3000/api?q=${"a".repeat(5000)}`, { method: "GET" }),
        "127.0.0.1",
      );
      if (!q.terminal) {
        failures++;
        console.log("FAIL ingress query-limit: expected terminal");
      }
    }
  }
}

if (failures > 0) {
  console.error(`\nverify-native-ffi: ${failures}/${checks} checks FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${checks} C-ABI FFI parity + growExact checks passed.`);
