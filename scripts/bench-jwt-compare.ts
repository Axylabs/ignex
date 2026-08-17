#!/usr/bin/env bun
/**
 * JWT encode/decode speed: castrum Rust vs Bun natives vs jose.
 *
 * Four implementations of EdDSA (Ed25519) compact JWT sign/verify:
 *
 *   castrum-rust   @ignex/native wrapper → castrum FFI (C-ABI under Bun)
 *   node-crypto    @ignex/native pure-TS fallback → node:crypto one-shot
 *                  (this IS Bun's native OpenSSL/BoringSSL binding)
 *   jose           the jose library (SignJWT / jwtVerify on WebCrypto)
 *   webcrypto-raw  hand-rolled compact JWT on crypto.subtle Ed25519
 *                  (the lowest-level "Bun native" path)
 *
 * "encode" = sign, "decode" = verify. Sync ops use the timed loop; async ops
 * (jose / webcrypto) use an await-per-op throughput loop — both measured as
 * ops/sec, median of TRIALS interleaved measurements.
 *
 * Usage:
 *   bun scripts/bench-jwt-compare.ts              # C-ABI (Bun, default)
 *   IGNEX_FFI_MODE=napi bun scripts/bench-jwt-compare.ts
 */
import { jwtVerify, SignJWT } from "jose";
import { getFfi } from "../packages/native/src/ffi";
import {
  generateEd25519Keypair,
  isNativeAvailable,
  jwtSignEdDsa,
  jwtSignEdDsaFallback,
  jwtVerifyEdDsa,
  jwtVerifyEdDsaFallback,
} from "../packages/native/src/index";

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** Median of samples. */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Ops/sec for a SYNC fn (warmup + timed loop). */
function opsPerSecSync(fn: () => unknown, durationMs = 250): number {
  for (let i = 0; i < 1_000; i++) fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

/** Ops/sec for an ASYNC fn (warmup + await-per-op throughput loop). */
async function opsPerSecAsync(fn: () => Promise<unknown>, durationMs = 250): Promise<number> {
  for (let i = 0; i < 500; i++) await fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    await fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

// ── Fixtures ────────────────────────────────────────────────────
const pair = generateEd25519Keypair();
const privDer = Buffer.from(pair.privateKey, "base64url");
const pubDer = Buffer.from(pair.publicKey, "base64url");
const NOW = 1_700_000_000;
const TTL = 3600;
const claims = {
  sub: "user-123",
  roles: ["admin"],
  permissions: ["users:read", "users:write", "orders:read"],
};

// WebCrypto keys (jose + raw path). Bun's WebCrypto is strict about Ed25519
// key usage: a private key must be imported with `["sign"]` only, a public key
// with `["verify"]` only.
const subtle = crypto.subtle;
const importPriv = () => subtle.importKey("pkcs8", privDer, { name: "Ed25519" }, true, ["sign"]);
const importPub = () => subtle.importKey("spki", pubDer, { name: "Ed25519" }, true, ["verify"]);

// Pre-signed tokens so verify benches a fixed token. castrum/node verify with
// a passed `nowSeconds` (fixed fixture clock); jose validates `exp` against the
// REAL clock, so the jose verify row uses a token signed at the real time.
const castrumToken = jwtSignEdDsa(claims, pair.privateKey, { ttlSeconds: TTL, nowSeconds: NOW });
const nodeToken = jwtSignEdDsaFallback(claims, privDer, TTL, NOW);
const realToken = jwtSignEdDsa(claims, pair.privateKey, { ttlSeconds: TTL });

// Hand-rolled WebCrypto JWT (compact EdDSA) — the "Bun native" raw path.
async function rawWebcryptoTok(key: CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const withTtl = { ...payload, iat: NOW, exp: NOW + TTL };
  const signingInput = `${b64url(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })))}.${b64url(enc.encode(JSON.stringify(withTtl)))}`;
  const sig = await subtle.sign("Ed25519", key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}
async function rawWebcryptoVerify(key: CryptoKey, token: string, now = NOW + 1): Promise<unknown> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const ok = await subtle.verify(
    "Ed25519",
    key,
    Buffer.from(s, "base64url"),
    enc.encode(`${h}.${p}`),
  );
  if (!ok) return null;
  const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  if (payload.exp != null && now >= (payload.exp as number)) return null;
  if (payload.iat != null && now < (payload.iat as number) - 60) return null;
  return payload;
}

const joseKey = await importPriv();
const josePub = await importPub();
const rawToken = await rawWebcryptoTok(joseKey, claims);
if (JSON.stringify(await rawWebcryptoVerify(josePub, rawToken)) !== JSON.stringify(claims)) {
  console.log("WARN: raw webcrypto self-verify failed");
}

const ffi = getFfi();
const TRIALS = 5;

interface Row {
  name: string;
  sync?: () => unknown;
  async?: () => Promise<unknown>;
}

const rows: Row[] = [
  {
    name: "castrum-rust encode",
    sync: () => jwtSignEdDsa(claims, pair.privateKey, { ttlSeconds: TTL, nowSeconds: NOW }),
  },
  { name: "node-crypto encode", sync: () => jwtSignEdDsaFallback(claims, privDer, TTL, NOW) },
  {
    name: "jose encode",
    async: () => new SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).sign(joseKey),
  },
  { name: "webcrypto-raw encode", async: () => rawWebcryptoTok(joseKey, claims) },
  {
    name: "castrum-rust decode",
    sync: () => jwtVerifyEdDsa(castrumToken, pair.publicKey, { nowSeconds: NOW + 1 }),
  },
  { name: "node-crypto decode", sync: () => jwtVerifyEdDsaFallback(nodeToken, pubDer, NOW + 1) },
  { name: "jose decode", async: () => jwtVerify(realToken, josePub, { algorithms: ["EdDSA"] }) },
  { name: "webcrypto-raw decode", async: () => rawWebcryptoVerify(josePub, rawToken) },
];

/** Measure one row (async or sync) → median ops/sec. */
async function measureRow(row: Row): Promise<number> {
  const samples: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    if (row.async) samples.push(await opsPerSecAsync(row.async));
    else if (row.sync) samples.push(opsPerSecSync(row.sync));
  }
  return median(samples);
}

/** Format an ops/sec ratio (xN.NN or `-`). */
const ratioText = (a: number, b: number): string =>
  Number.isFinite(a) && b > 0 ? `x${(a / b).toFixed(2)}` : "-";

async function run(): Promise<void> {
  const mode = isNativeAvailable()
    ? ffi
      ? "NATIVE (C-ABI ffi live)"
      : "NATIVE (NAPI)"
    : "FALLBACK (no addon)";
  console.log(`mode: ${mode}\n`);
  console.log(`EdDSA JWT encode/decode — ops/sec, median of ${TRIALS} interleaved trials\n`);

  const results: Array<{ name: string; ops: number }> = [];
  for (const row of rows) results.push({ name: row.name, ops: await measureRow(row) });

  const byName = (n: string): number => results.find((r) => r.name === n)?.ops ?? 0;
  const pad = (s: string, w: number): string => s.padEnd(w);
  console.log(
    `${pad("impl", 24)} ${pad("ops/s", 12)} ${pad("vs castrum", 11)} ${pad("vs node", 10)}`,
  );
  for (const r of results) {
    const isEncode = r.name.includes("encode");
    const base = byName(isEncode ? "castrum-rust encode" : "castrum-rust decode");
    const node = byName(isEncode ? "node-crypto encode" : "node-crypto decode");
    console.log(
      `${pad(r.name, 24)} ${pad(String(Math.round(r.ops)), 12)} ${pad(ratioText(r.ops, base), 11)} ${pad(ratioText(r.ops, node), 10)}`,
    );
  }
  console.log(
    "\nNotes: higher ops/s is better. castrum-rust = @ignex/native → castrum FFI. node-crypto = @ignex/native fallback (Bun node:crypto). jose = SignJWT/jwtVerify. webcrypto-raw = hand-rolled on crypto.subtle.",
  );
}

await run();
