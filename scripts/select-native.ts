#!/usr/bin/env bun
/**
 * Benchmark-driven native-vs-JS auto-selection for `@ignex/native`.
 *
 * Measures the RAW castrum addon implementation against the pure-TS
 * `*Fallback` for every op in the SELECTION table (NOT wrapper-vs-wrapper,
 * which reads as noise), computes `nativeRatio = native ops/s ÷ fallback
 * ops/s`, then compares each measurement against the current SELECTION
 * decision and reports drift.
 *
 * Usage:
 *   bun scripts/select-native.ts            # report + drift summary (exit 0)
 *   bun scripts/select-native.ts --check    # CI gate: exit 1 on drift
 *   bun scripts/select-native.ts --write    # persist bench/results/selection.json
 *
 * Selection rule (deterministic): native iff `nativeRatio >= 1.05`; js iff
 * `nativeRatio <= 0.95`; inside the band the current wiring is kept (parity —
 * avoid churn). Correctness is NOT decided here: the parity suite
 * (`packages/native/test/native.test.ts`, `bun run test:native:real`) gates
 * byte/behavior parity, and this script only picks the faster of two
 * equivalent implementations.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
  constants as zlibConstants,
} from "node:zlib";

import {
  aeadDecryptFallback,
  aeadEncryptFallback,
  cookiePairsFallback,
  createAcceptNegotiatorFallback,
  createConditionalRequestFallback,
  createRateLimiterFallback,
  csrfTokenFallback,
  csrfVerifyFallback,
  etagFallback,
  fnv1a64Fallback,
  formPairsFallback,
  getNative,
  isNativeAvailable,
  jsonPatchFallback,
  jwtSignFallback,
  jwtVerifyFallback,
  multipartParseFallback,
  parseAcceptEncodingFallback,
  parseMediaTypeFallback,
  passwordHashFallback,
  passwordVerifyFallback,
  queryPairsFallback,
  randomTokenFallback,
  renderTemplateFallback,
  SELECTION,
  signCookieFallback,
  sseEncodeFallback,
  validateEmailFallback,
  validateIpv4Fallback,
  validateIpv6Fallback,
  validateUuidFallback,
  verifyCookieFallback,
  wsFrameDecodeFallback,
  wsFrameEncodeFallback,
} from "../packages/native/src/index";
import type { NativeAddon } from "../packages/native/src/loader";
import { readPairsPacked } from "../packages/native/src/packed";
import {
  crc32 as crc32Fallback,
  ctEqual,
  decoder,
  encoder,
  hmacSha256Bytes,
} from "../packages/native/src/util";

const native = getNative();
const MODE = isNativeAvailable() ? "NATIVE" : "FALLBACK";

if (!native) {
  console.error(
    "select-native: castrum addon not loaded — cannot measure native. Install/build it or set IGNEX_NATIVE_PATH.",
  );
  process.exit(2);
}

// ── Inputs (large enough that FFI amortizes; matches native-bench) ──
const enc = encoder;
const dec = decoder;

const bigChunk = "x".repeat(64);
const queryBytes = enc.encode(
  `page=2&sort=asc&filter=price&filter=stock&chunk=${bigChunk}&q=${bigChunk}&name=Ada%20Lovelace`,
);
const cookieBytes = enc.encode(
  Array.from({ length: 12 }, (_, i) => `k${i}=v${bigChunk.slice(0, 40)};`).join(" "),
);
const formText = `name=Ada%20Lovelace&role=engineer&active=true&tags=a&tags=b&lang=en&chunk=${bigChunk}`;
const formBytes = enc.encode(formText);
const etagBytes = enc.encode(`hello world, etag sample ${bigChunk}`);
const mediaTypeText = "multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW";
const mediaTypeBytes = enc.encode(mediaTypeText);
const acceptText = "gzip, deflate, br;q=0.9, identity;q=0.1";
const acceptBytes = enc.encode(acceptText);
const jsonDocText = '{"id":1,"name":"widget","tags":["a","b","c"],"nested":{"x":true}}';
const jsonDocBytes = enc.encode(jsonDocText);
const jsonPatchDoc = '{"baz":"qux","foo":"bar"}';
const jsonPatchOps =
  '[{"op":"replace","path":"/baz","value":"boo"},{"op":"add","path":"/hello","value":["world"]}]';
const wsPayload = enc.encode(`ws payload ${bigChunk}`);
const sseDataBytes = enc.encode(`line0 ${bigChunk}\nline1 ${bigChunk}`);
const sseDataText = dec.decode(sseDataBytes);
const compressedGz = gzipSync(new Uint8Array(64).fill(7));
const compressedBr = brotliCompressSync(new Uint8Array(64).fill(7));
const wsFrameMasked = [0x37, 0xfa, 0x21, 0x3d];
const wsFrameBuf = (() => {
  const p = enc.encode(`frame payload ${bigChunk}`);
  const out = new Uint8Array(2 + 4 + p.length);
  out[0] = 0x81;
  out[1] = 0x80 | p.length;
  out.set(wsFrameMasked, 2);
  for (let i = 0; i < p.length; i++)
    out[2 + 4 + i] = (p[i] as number) ^ (wsFrameMasked[i & 3] as number);
  return out;
})();

const hmacKey = enc.encode("supersecretkey-32-bytes-for-hmac-512!");
const hmacData = enc.encode(`hmac data ${bigChunk}`);
const hmacSig = hmacSha256Bytes(hmacKey, hmacData);
const secret = enc.encode("cookie-secret-0123456789abcdef");
const signedValue = signCookieFallback("session=abc123", secret);
const csrfTok = csrfTokenFallback(secret);
const jwtSecret = enc.encode("jwt-secret-0123456789abcdef0123456789abcdef");
const jwtClaims = { sub: "user-1", role: "admin", iat: 1700000000 };
const jwtTok = jwtSignFallback(jwtClaims, jwtSecret, 3600, 1700000000);
const nowSecs = 1700000000;
const aeadKey = enc.encode("k".repeat(32));
const aeadNonce = enc.encode("n".repeat(12));
const aeadPlain = enc.encode(`aead plaintext ${bigChunk}`);
const aeadCipher = aeadEncryptFallback(aeadKey, aeadNonce, aeadPlain, "aes-256-gcm");
const salt = enc.encode("somesalt");
const phc = passwordHashFallback(enc.encode("hunter2"), salt);
const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
const mpBody = (() => {
  const parts: string[] = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="field1"\r\n\r\nvalue1\r\n`);
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n${"A".repeat(2048)}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return enc.encode(parts.join(""));
})();
const templateSrc = "Hello {{ name }}! You have {{ items.length }} items.";
const templateCtx = { name: "world", items: [1, 2, 3] };
const condEtag = enc.encode('"abc123"');
const acceptSupported = ["gzip", "br", "identity"];
const rateKey = "ip-1.2.3.4";
const rateNow = 1_700_000_000;

// Compiled-once instances (production usage: build at startup, reuse per
// request). Construction cost is excluded from the per-call measurement.
const rlNative = new native.RateLimiter(100, 60_000, null);
const rlJs = createRateLimiterFallback({ limit: 100, windowMs: 60_000 });
const tplNative = new native.TemplateRenderer(templateSrc);
const crNative = new native.ConditionalRequest(condEtag, 1700000000);
const crJs = createConditionalRequestFallback('"abc123"', 1700000000);
const anNative = new native.AcceptNegotiator(acceptSupported);
const anJs = createAcceptNegotiatorFallback(acceptSupported);

// ── Harness ─────────────────────────────────────────────────────

interface BenchOp {
  op: string;
  label: string;
  /** Raw native implementation (uses the addon directly). */
  native: (n: NativeAddon) => void;
  /** Pure-TS implementation. */
  fallback: () => void;
}

/** Measure ops/sec (adaptive warmup + timed loop). */
function opsPerSec(fn: () => void, durationMs = 200): number {
  const w0 = performance.now();
  let i = 0;
  while (performance.now() - w0 < 8 && i < 10000) {
    fn();
    i++;
  }
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

const NATIVE_WIN = 1.05; // native chosen when it wins by ≥5%
const NATIVE_LOSS = 0.95; // native dropped when it loses by ≥5%
// `--check` (CI gate) only fails on DECISIVE drift — ops whose measured ratio
// sits inside the parity band are left pinned, so run-to-run noise on
// FFI-bound ops (e.g. verifyCookie 0.82–1.15x) does not cause flip-flopping.
const DECISIVE_WIN = 1.18; // native must win >18% to flip a js-wired op
const DECISIVE_LOSS = 0.85; // native must lose >15% to flip a castrum-wired op
const TRIALS = 3; // median of 3 interleaved samples for noise stability

interface Measured {
  op: string;
  nativeOps: number;
  fallbackOps: number;
  ratio: number;
  current: string;
  recommended: string;
  drift: boolean;
  delta: string;
}

/** Median of a numeric array (noise-stable center for FFI microbenchmarks). */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

// ── Specs ───────────────────────────────────────────────────────

const n = native;
const OPS: BenchOp[] = [
  // hash
  {
    op: "fnv1a64",
    label: "fnv1a64",
    native: (x) => x.fnv1a64(etagBytes),
    fallback: () => fnv1a64Fallback(etagBytes),
  },
  {
    op: "crc32",
    label: "crc32",
    native: (x) => x.crc32(etagBytes),
    fallback: () => crc32Fallback(etagBytes),
  },
  // crypto
  {
    op: "hmacSha256",
    label: "hmacSha256",
    native: (x) => x.hmacSha256(hmacKey, hmacData),
    fallback: () => hmacSha256Bytes(hmacKey, hmacData),
  },
  {
    op: "hmacSha256Verify",
    label: "hmacSha256Verify",
    native: (x) => x.hmacSha256Verify(hmacKey, hmacData, hmacSig),
    fallback: () => ctEqual(hmacSha256Bytes(hmacKey, hmacData), hmacSig),
  },
  {
    op: "signCookie",
    label: "signCookie",
    native: (x) => x.signCookie(enc.encode("session=abc123"), secret),
    fallback: () => signCookieFallback("session=abc123", secret),
  },
  {
    op: "verifyCookie",
    label: "verifyCookie",
    native: (x) => x.verifyCookie(enc.encode(signedValue), secret),
    fallback: () => verifyCookieFallback(signedValue, secret),
  },
  {
    op: "csrfToken",
    label: "csrfToken",
    native: (x) => x.csrfToken(secret),
    fallback: () => csrfTokenFallback(secret),
  },
  {
    op: "csrfVerify",
    label: "csrfVerify",
    native: (x) => x.csrfVerify(enc.encode(csrfTok), secret),
    fallback: () => csrfVerifyFallback(csrfTok, secret),
  },
  {
    op: "jwtSign",
    label: "jwtSign",
    native: (x) => x.jwtSign(jwtClaims, jwtSecret, 3600, nowSecs),
    fallback: () => jwtSignFallback(jwtClaims, jwtSecret, 3600, nowSecs),
  },
  {
    op: "jwtVerify",
    label: "jwtVerify",
    native: (x) => x.jwtVerify(enc.encode(jwtTok), jwtSecret, nowSecs),
    fallback: () => jwtVerifyFallback(jwtTok, jwtSecret, nowSecs),
  },
  {
    op: "randomToken",
    label: "randomToken",
    native: (x) => x.randomToken(16),
    fallback: () => randomTokenFallback(16),
  },
  {
    op: "passwordHash",
    label: "passwordHash",
    native: (x) => x.passwordHash(enc.encode("hunter2"), salt, null),
    fallback: () => passwordHashFallback(enc.encode("hunter2"), salt),
  },
  {
    op: "passwordVerify",
    label: "passwordVerify",
    native: (x) => x.passwordVerify(enc.encode("hunter2"), enc.encode(phc)),
    fallback: () => passwordVerifyFallback(enc.encode("hunter2"), phc),
  },
  {
    op: "aeadEncrypt",
    label: "aeadEncrypt",
    native: (x) => x.aeadEncrypt(aeadKey, aeadNonce, aeadPlain, "aes-256-gcm"),
    fallback: () => aeadEncryptFallback(aeadKey, aeadNonce, aeadPlain, "aes-256-gcm"),
  },
  {
    op: "aeadDecrypt",
    label: "aeadDecrypt",
    native: (x) => x.aeadDecrypt(aeadKey, aeadNonce, aeadCipher, "aes-256-gcm"),
    fallback: () => aeadDecryptFallback(aeadKey, aeadNonce, aeadCipher, "aes-256-gcm"),
  },
  // http parsers (native cost includes the JS unpack — the real wrapper cost)
  {
    op: "queryPairs",
    label: "queryPairs",
    native: (x) => readPairsPacked(x.queryParsePacked(queryBytes)),
    fallback: () => queryPairsFallback(queryBytes),
  },
  {
    op: "cookiePairs",
    label: "cookiePairs",
    native: (x) => readPairsPacked(x.cookieParsePacked(cookieBytes)),
    fallback: () => cookiePairsFallback(cookieBytes),
  },
  {
    op: "formPairs",
    label: "formPairs",
    native: (x) => readPairsPacked(x.formParsePacked(formBytes)),
    fallback: () => formPairsFallback(formBytes),
  },
  {
    op: "etag",
    label: "etag",
    native: (x) => x.etag(etagBytes, false),
    fallback: () => etagFallback(etagBytes, false),
  },
  {
    op: "multipartParse",
    label: "multipartParse",
    native: (x) => x.multipartParse(mpBody, enc.encode(boundary), null),
    fallback: () => multipartParseFallback(mpBody, boundary),
  },
  {
    op: "parseMediaType",
    label: "parseMediaType",
    native: (x) => x.parseMediaType(mediaTypeBytes),
    fallback: () => parseMediaTypeFallback(mediaTypeText),
  },
  {
    op: "parseAcceptEncoding",
    label: "parseAcceptEncoding",
    native: (x) => x.parseAcceptEncoding(acceptBytes),
    fallback: () => parseAcceptEncodingFallback(acceptText),
  },
  {
    op: "createConditionalRequest",
    label: "createConditionalRequest",
    native: () => crNative.isNotModified(condEtag, null),
    fallback: () => crJs.isNotModified('"abc123"', null),
  },
  {
    op: "createAcceptNegotiator",
    label: "createAcceptNegotiator",
    native: () => anNative.negotiate(acceptBytes),
    fallback: () => anJs.negotiate(acceptText),
  },
  // json
  {
    op: "jsonValid",
    label: "jsonValid",
    native: (x) => x.jsonValid(jsonDocBytes),
    fallback: () => {
      try {
        JSON.parse(jsonDocText);
        return true;
      } catch {
        return false;
      }
    },
  },
  {
    op: "jsonPatch",
    label: "jsonPatch",
    native: (x) => x.jsonPatch(enc.encode(jsonPatchDoc), enc.encode(jsonPatchOps)),
    fallback: () => jsonPatchFallback(jsonPatchDoc, jsonPatchOps),
  },
  // payload
  {
    op: "gzipCompress",
    label: "gzipCompress",
    native: (x) => x.gzipCompress(jsonDocBytes, 6),
    fallback: () => gzipSync(jsonDocBytes, { level: 6 }),
  },
  {
    op: "gzipDecompress",
    label: "gzipDecompress",
    native: (x) => x.gzipDecompress(compressedGz),
    fallback: () => gunzipSync(compressedGz),
  },
  {
    op: "brotliCompress",
    label: "brotliCompress",
    native: (x) => x.brotliCompress(jsonDocBytes, 5),
    fallback: () =>
      brotliCompressSync(jsonDocBytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
  },
  {
    op: "brotliDecompress",
    label: "brotliDecompress",
    native: (x) => x.brotliDecompress(compressedBr),
    fallback: () => brotliDecompressSync(compressedBr),
  },
  {
    op: "sseEncode",
    label: "sseEncode",
    native: (x) => x.sseEncodeEvent("message", sseDataBytes, "42", null),
    fallback: () => sseEncodeFallback("message", sseDataText, "42", null),
  },
  {
    op: "wsFrameEncode",
    label: "wsFrameEncode",
    native: (x) => x.wsFrameEncode(1, wsPayload, false, true),
    fallback: () => wsFrameEncodeFallback(1, wsPayload, false, true),
  },
  {
    op: "wsFrameDecode",
    label: "wsFrameDecode",
    native: (x) => x.wsFrameDecode(wsFrameBuf),
    fallback: () => wsFrameDecodeFallback(wsFrameBuf),
  },
  {
    op: "wsAcceptKey",
    label: "wsAcceptKey",
    native: (x) => x.wsAcceptKey(enc.encode("dGhlIHNhbXBsZSBub25jZQ==")),
    fallback: () =>
      createHash("sha1")
        .update("dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64"),
  },
  // validation
  {
    op: "validateEmail",
    label: "validateEmail",
    native: (x) => x.validateEmail(enc.encode("ada@example.com")),
    fallback: () => validateEmailFallback("ada@example.com"),
  },
  {
    op: "validateUuid",
    label: "validateUuid",
    native: (x) => x.validateUuid(enc.encode("123e4567-e89b-12d3-a456-426614174000")),
    fallback: () => validateUuidFallback("123e4567-e89b-12d3-a456-426614174000"),
  },
  {
    op: "validateIpv4",
    label: "validateIpv4",
    native: (x) => x.validateIpv4(enc.encode("192.168.0.1")),
    fallback: () => validateIpv4Fallback("192.168.0.1"),
  },
  {
    op: "validateIpv6",
    label: "validateIpv6",
    native: (x) => x.validateIpv6(enc.encode("2001:db8::1")),
    fallback: () => validateIpv6Fallback("2001:db8::1"),
  },
  // ratelimit (compiled once)
  {
    op: "createRateLimiter",
    label: "createRateLimiter.check",
    native: () => rlNative.check(rateKey, rateNow),
    fallback: () => rlJs.check(rateKey, rateNow),
  },
  // template (compiled once)
  {
    op: "renderTemplate",
    label: "renderTemplate.render",
    native: () => tplNative.render(templateCtx),
    fallback: () => renderTemplateFallback(templateSrc, templateCtx),
  },
];

// ── Run ─────────────────────────────────────────────────────────

const results: Measured[] = [];
for (const op of OPS) {
  // Median of interleaved trials: dampens JSC/noise so borderline ops (which
  // swing ±20% run-to-run) read as parity instead of flip-flopping.
  const nativeSamples: number[] = [];
  const fallbackSamples: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    nativeSamples.push(opsPerSec(() => op.native(n)));
    fallbackSamples.push(opsPerSec(op.fallback));
  }
  const nativeOps = median(nativeSamples);
  const fallbackOps = median(fallbackSamples);
  const ratio = fallbackOps > 0 ? nativeOps / fallbackOps : Number.NaN;
  const decision = SELECTION[op.op as keyof typeof SELECTION];
  const current = decision?.impl ?? "unknown";
  const recommended = !Number.isFinite(ratio)
    ? current
    : ratio >= NATIVE_WIN
      ? "castrum"
      : ratio <= NATIVE_LOSS
        ? "js"
        : current;
  const decisive =
    (current === "castrum" && Number.isFinite(ratio) && ratio < DECISIVE_LOSS) ||
    (current === "js" && Number.isFinite(ratio) && ratio > DECISIVE_WIN);
  const delta = recommended !== current ? ` → ${recommended}` : "";
  results.push({
    op: op.op,
    nativeOps,
    fallbackOps,
    ratio,
    current,
    recommended,
    drift: decisive,
    delta,
  });
}

// ── Report ──────────────────────────────────────────────────────

const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "n/a");
const pad = (s: string, w: number): string => s.padEnd(w);

console.log(
  `mode: ${MODE} — auto-selection scan (win ≥${NATIVE_WIN.toFixed(2)}x, loss ≤${NATIVE_LOSS.toFixed(2)}x)\n`,
);
console.log(
  `${pad("op", 26)} ${pad("native", 10)} ${pad("fallback", 10)} ${pad("ratio", 8)} ${pad("wired", 9)} ${pad("rec", 9)} drift`,
);
for (const r of results) {
  console.log(
    `${pad(r.op, 26)} ${pad(String(Math.round(r.nativeOps)), 10)} ${pad(
      String(Math.round(r.fallbackOps)),
      10,
    )} ${pad(fmt(r.ratio), 8)} ${pad(r.current, 9)} ${pad(r.recommended, 9)} ${r.drift ? "◀ DRIFT" : ""}`,
  );
}

const driftOps = results.filter((r) => r.drift);
console.log(`\n${results.length} ops measured, ${driftOps.length} drift from current wiring.`);
for (const r of driftOps) {
  console.log(
    `  - ${r.op}: wired ${r.current}, measured ${fmt(r.ratio)}x → recommend ${r.recommended}`,
  );
}

if (process.argv.includes("--write")) {
  const outDir = join(process.cwd(), "bench", "results");
  mkdirSync(outDir, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    winThreshold: NATIVE_WIN,
    lossThreshold: NATIVE_LOSS,
    results: results.map((r) => ({
      op: r.op,
      nativeOps: Math.round(r.nativeOps),
      fallbackOps: Math.round(r.fallbackOps),
      nativeRatio: Number.isFinite(r.ratio) ? Number(r.ratio.toFixed(3)) : null,
      wired: r.current,
      recommended: r.recommended,
    })),
  };
  const file = join(outDir, "selection.json");
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${file}`);
}

if (process.argv.includes("--check") && driftOps.length > 0) {
  console.error(
    "\nselect-native --check: SELECTION drift detected — update selection.ts or re-measure.",
  );
  process.exit(1);
}
process.exit(0);
