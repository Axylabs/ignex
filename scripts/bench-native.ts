#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync } from "node:zlib";
/**
 * Native (addon) vs JS-fallback per-op benchmark — MEDIAN-based — for the
 * `@ignex/native` surface NOT covered by `scripts/bench-ffi.ts`.
 *
 * `bench-ffi.ts` measures the C-ABI scalar ops; this script covers the rest:
 *   - JSON Schema validation (`SchemaValidator.validate` vs Ajv) — the headline
 *   - the other compiled-once stateful classes (AcceptNegotiator,
 *     ConditionalRequest, RateLimiter, TemplateRenderer)
 *   - scalar crypto/codecs that go through NAPI on ignex (jwt, password,
 *     aead, gzip/brotli, sse, ws, multipart, media/accept, jsonPatch)
 *
 * For stateful classes the native instance is compiled ONCE and the steady-state
 * method is measured (compilation is a one-time cost — exactly how the wrappers
 * are used). For scalar ops the raw addon call is measured against the exact
 * `*Fallback` the wrapper would otherwise run. Median of interleaved trials for
 * noise stability. Proven winners (median >= 1.05) are candidates to wire.
 *
 *   bun scripts/bench-native.ts
 *   IGNEX_NATIVE=off ...                 # addon unavailable → skip native rows
 */
import Ajv from "ajv";
import { bunGunzipSync, bunGzipSync } from "../packages/native/src/bun";
import {
  aeadDecryptFallback,
  aeadEncryptFallback,
  createAcceptNegotiatorFallback,
  createConditionalRequestFallback,
  createRateLimiterFallback,
  jsonPatchFallback,
  jwtSignFallback,
  jwtVerifyFallback,
  multipartParseFallback,
  parseAcceptEncodingFallback,
  parseMediaTypeFallback,
  passwordHashFallback,
  renderTemplateFallback,
  sseEncodeFallback,
  wsFrameDecodeFallback,
  wsFrameEncodeFallback,
} from "../packages/native/src/index";
import { getNative } from "../packages/native/src/loader";

const native = getNative();
const enc = new TextEncoder();

// ── Inputs (representative of real usage; ≥64B so native work amortizes) ──
const bigChunk = "x".repeat(64);
const jsonSchema = JSON.stringify({
  type: "object",
  properties: { id: { type: "number" }, name: { type: "string" }, tags: { type: "array" } },
  required: ["id", "name"],
});
const schemaDoc = JSON.stringify({ id: 1, name: "widget", tags: ["a", "b"] });
const schemaBytes = enc.encode(jsonSchema);
const schemaDocBytes = enc.encode(schemaDoc);
const acceptBytes = enc.encode("gzip, deflate, br;q=0.9, identity;q=0.1");
const acceptText = "gzip, deflate, br;q=0.9, identity;q=0.1";
const mediaTypeText = "multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW";
const mediaTypeBytes = enc.encode(mediaTypeText);
const jwtSecret = enc.encode("secret-key-material-0123456789abcdef");
const jwtClaims = { sub: "1234567890", name: "Ada Lovelace", role: "engineer" };
const jwtToken = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
  JSON.stringify({ ...jwtClaims, iat: 1_700_000_000, exp: 1_700_000_000 + 3600 }),
)}.${b64url("0123456789abcdef0123456789abcdef")}`;
const jwtTokenBytes = enc.encode(jwtToken);
const aeadKey = enc.encode("k".repeat(32));
const aeadNonce = enc.encode("n".repeat(12));
const aeadPlain = enc.encode(`aead plaintext ${bigChunk}`);
const aeadCipher = enc.encode("c".repeat(64 + 16));
const wsPayload = enc.encode(`ws payload ${bigChunk}`);
const wsMasked = [0x37, 0xfa, 0x21, 0x3d] as const;
const wsFrameBuf = (() => {
  const p = enc.encode(`frame payload ${bigChunk}`);
  const out = new Uint8Array(2 + 4 + p.length);
  out[0] = 0x81;
  out[1] = 0x80 | p.length;
  out.set(wsMasked, 2);
  for (let i = 0; i < p.length; i++) out[2 + 4 + i] = (p[i] ?? 0) ^ (wsMasked[i & 3] ?? 0);
  return out;
})();
const compressedGz = gzipSync(new Uint8Array(128).fill(7));
const compressedBr = brotliCompressSync(new Uint8Array(128).fill(7));
const wsAcceptKeyText = "dGhlIHNhbXBsZSBub25jZQ==";
const mpBody = enc.encode(
  `------WebKitFormBoundary7MA4YWxkTrZu0gW\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW--\r\n`,
);
const mpBoundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
const sseData = enc.encode(`line0 ${bigChunk}\nline1 ${bigChunk}`);
const templateSrc = "Hello {{ name }}! You have {{ count }} messages.";
const templateCtx = { name: "Ada", count: 42 };
const patchDoc = '{"baz":"qux","foo":"bar"}';
const patchOps =
  '[{"op":"replace","path":"/baz","value":"boo"},{"op":"add","path":"/hello","value":["world"]}]';
const rateKey = "user:42";
const rateNow = 1_700_000_000;

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

/** Median of interleaved samples (noise-stable center for FFI microbenchmarks). */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Ops/sec for a sync fn (warmup + timed loop). */
function opsPerSec(fn: () => void, durationMs = 120, warmup = 200): number {
  for (let i = 0; i < warmup; i++) fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

interface BenchOp {
  name: string;
  native: () => unknown;
  js: () => unknown;
  /** KDFs / compressors are expensive — tiny warmup, tiny window. */
  expensive?: boolean;
}

const WIN = 1.05;

// ── Compiled-once stateful instances (steady-state method, the real usage) ──
const schemaValidator = native ? new native.SchemaValidator(schemaBytes) : null;
const acceptNegotiator = native ? new native.AcceptNegotiator(["gzip", "br", "identity"]) : null;
const conditionalReq = native
  ? new native.ConditionalRequest(enc.encode('"abc123"'), 1_700_000_000)
  : null;
const rateLimiter = native ? new native.RateLimiter(100, 60_000, null) : null;
const templateRenderer = native ? new native.TemplateRenderer(templateSrc) : null;

// Non-null handles — the closures below only ever run under the `!native` guard
// inside `run()`, so a null surface never reaches them. `as` keeps the
// noNonNullAssertion lint happy (the `!` operator is banned).
const addon = native as NonNullable<typeof native>;
const sv = schemaValidator as NonNullable<typeof schemaValidator>;
const an = acceptNegotiator as NonNullable<typeof acceptNegotiator>;
const cr = conditionalReq as NonNullable<typeof conditionalReq>;
const rl = rateLimiter as NonNullable<typeof rateLimiter>;
const tr = templateRenderer as NonNullable<typeof templateRenderer>;
const bunGzip = bunGzipSync as (data: Uint8Array, level?: number) => Uint8Array;
const bunGunzip = bunGunzipSync as (data: Uint8Array) => Uint8Array;

// Ajv — the core oracle / the JS path schema validation would otherwise run.
const ajv = new Ajv({ strict: false });
const ajvValidate = ajv.compile(JSON.parse(jsonSchema) as object) as (data: unknown) => boolean;
const schemaDocObj = JSON.parse(schemaDoc);

const ops: BenchOp[] = [
  // ── JSON Schema validation (the headline) ─────────────────────────
  {
    name: "jsonSchemaValidate (native vs Ajv)",
    native: () => sv.validate(schemaDocBytes),
    js: () => ajvValidate(schemaDocObj),
  },
  // ── Compiled-once stateful classes ───────────────────────────────
  {
    name: "acceptNegotiate (class method)",
    native: () => an.negotiate(acceptBytes),
    js: () => acceptNegotiatorJs.negotiate(acceptText),
  },
  {
    name: "conditional (class method)",
    native: () => cr.isNotModified(enc.encode('"abc123"'), null),
    js: () => conditionalJs.isNotModified('"abc123"', null),
  },
  {
    name: "rateLimit.check (class method)",
    native: () => rl.check(rateKey, rateNow),
    js: () => rateLimiterJs.check(rateKey, rateNow),
  },
  {
    name: "templateRender (class method)",
    native: () => tr.render(templateCtx),
    js: () => renderTemplateFallback(templateSrc, templateCtx),
  },
  // ── Scalar crypto / codecs ────────────────────────────────────────
  {
    name: "jwtSign",
    native: () => addon.jwtSign(jwtClaims, jwtSecret, 3600, 1_700_000_000),
    js: () => jwtSignFallback(jwtClaims, jwtSecret, 3600, 1_700_000_000),
  },
  {
    name: "jwtVerify",
    native: () => addon.jwtVerify(jwtTokenBytes, jwtSecret, 1_700_000_000),
    js: () => jwtVerifyFallback(jwtToken, jwtSecret, 1_700_000_000),
  },
  {
    name: "passwordHash",
    native: () => addon.passwordHash(enc.encode("hunter2"), enc.encode("somesalt1234"), null),
    js: () => passwordHashFallback(enc.encode("hunter2"), enc.encode("somesalt1234")),
    expensive: true,
  },
  {
    name: "aeadEncrypt",
    native: () => addon.aeadEncrypt(aeadKey, aeadNonce, aeadPlain, "aes-256-gcm"),
    js: () => aeadEncryptFallback(aeadKey, aeadNonce, aeadPlain, "aes-256-gcm"),
  },
  {
    name: "aeadDecrypt",
    native: () => addon.aeadDecrypt(aeadKey, aeadNonce, aeadCipher, "aes-256-gcm"),
    js: () => aeadDecryptFallback(aeadKey, aeadNonce, aeadCipher, "aes-256-gcm"),
  },
  // ── Compression: rust addon vs Bun builtin (the current Bun path) ──
  {
    name: "gzipCompress (rust vs Bun.gzip)",
    native: () => addon.gzipCompress(schemaDocBytes, 6),
    js: () => bunGzip(schemaDocBytes, 6),
  },
  {
    name: "gzipDecompress (rust vs Bun.gunzip)",
    native: () => addon.gzipDecompress(compressedGz),
    js: () => bunGunzip(compressedGz),
  },
  {
    name: "brotliCompress (rust vs node)",
    native: () => addon.brotliCompress(schemaDocBytes, 5),
    js: () =>
      brotliCompressSync(schemaDocBytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
  },
  {
    name: "brotliDecompress (rust vs node)",
    native: () => addon.brotliDecompress(compressedBr),
    js: () => brotliDecompressSync(compressedBr),
  },
  // ── SSE / WS / multipart / parsing ────────────────────────────────
  {
    name: "sseEncode",
    native: () => addon.sseEncodeEvent("message", sseData, "42", null),
    js: () => sseEncodeFallback("message", sseData, "42", null),
  },
  {
    name: "wsFrameEncode",
    native: () => addon.wsFrameEncode(1, wsPayload, false, true),
    js: () => wsFrameEncodeFallback(1, wsPayload, false, true),
  },
  {
    name: "wsFrameDecode",
    native: () => addon.wsFrameDecode(wsFrameBuf),
    js: () => wsFrameDecodeFallback(wsFrameBuf),
  },
  {
    name: "wsAcceptKey",
    native: () => addon.wsAcceptKey(enc.encode(wsAcceptKeyText)),
    js: () =>
      createHash("sha1")
        .update(`${wsAcceptKeyText}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64"),
  },
  {
    name: "multipartParse",
    native: () => addon.multipartParse(mpBody, enc.encode(mpBoundary), null),
    js: () => multipartParseFallback(mpBody, mpBoundary),
  },
  {
    name: "parseMediaType",
    native: () => addon.parseMediaType(mediaTypeBytes),
    js: () => parseMediaTypeFallback(mediaTypeText),
  },
  {
    name: "parseAcceptEncoding",
    native: () => addon.parseAcceptEncoding(acceptBytes),
    js: () => parseAcceptEncodingFallback(acceptText),
  },
  {
    name: "jsonPatch",
    native: () => addon.jsonPatch(enc.encode(patchDoc), enc.encode(patchOps)),
    js: () => jsonPatchFallback(patchDoc, patchOps),
  },
];

// ── JS fallback instances (the REAL wrapper fallbacks, compiled once) ──
const acceptNegotiatorJs = createAcceptNegotiatorFallback(["gzip", "br", "identity"]);
const conditionalJs = createConditionalRequestFallback('"abc123"', 1_700_000_000);
const rateLimiterJs = createRateLimiterFallback({ limit: 100, windowMs: 60_000 });

const TRIALS = 5;

function run(): void {
  if (!native) {
    console.log("addon unavailable (IGNEX_NATIVE=off) — no native rows.");
  }
  console.log(
    `native(addon) vs JS fallback (median of ${TRIALS} interleaved trials; win ≥${WIN.toFixed(2)}x):\n`,
  );
  console.log(
    `${"op".padEnd(34)} ${"native".padStart(10)} ${"js".padStart(10)} ${"ratio".padStart(8)} verdict`,
  );
  const rows: Array<{ name: string; n: number; j: number; ratio: number }> = [];
  for (const op of ops) {
    if (!native) {
      rows.push({ name: op.name, n: Number.NaN, j: opsPerSec(op.js), ratio: Number.NaN });
      continue;
    }
    const nS: number[] = [];
    const jS: number[] = [];
    const warmup = op.expensive ? 3 : 200;
    const durationMs = op.expensive ? 60 : 120;
    for (let t = 0; t < TRIALS; t++) {
      nS.push(opsPerSec(op.native, durationMs, warmup));
      jS.push(opsPerSec(op.js, durationMs, warmup));
    }
    const n = median(nS);
    const j = median(jS);
    rows.push({ name: op.name, n, j, ratio: n / j });
  }
  for (const r of rows) {
    const verdict = Number.isFinite(r.ratio)
      ? r.ratio >= WIN
        ? "◀ native wins"
        : r.ratio <= 1 / WIN
          ? "js stays"
          : "parity"
      : "n/a";
    console.log(
      `${r.name.padEnd(34)} ${(Number.isFinite(r.n) ? String(Math.round(r.n)) : "-").padStart(10)} ${String(Math.round(r.j)).padStart(10)} ${(Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : "-").padStart(8)} ${verdict}`,
    );
  }
}

run();
