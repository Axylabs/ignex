#!/usr/bin/env bun
/**
 * Bun builtin vs current-impl microbenchmark — the DECISION SOURCE for
 * "use Bun internals when runtime = Bun".
 *
 * Every candidate in the "use Bun internals" effort gets a measured ratio here
 * before it is wired in (mirrors the `BUN_WINS` discipline from castrum's
 * `docs/bun-builtins-decision-matrix.md`). For each op we measure the Bun
 * native builtin against the implementation the code would otherwise run
 * (Node `node:*` or the pure-TS/native `@ignex/native` fallback) on
 * representative payloads, using a median of interleaved trials for noise
 * stability.
 *
 * Verdict rules (see `docs/bun-internals.md` for the resulting matrix):
 *   - ratio >= 1.05 → "bun wins"  — swap when byte-compatible.
 *   - ratio <= 0.95 → "keep"      — current impl stays.
 *   - otherwise      → "parity"   — swap when byte-compatible (no slowdown).
 *
 *   bun scripts/bench-bun-internals.ts
 *   bun scripts/bench-bun-internals.ts --json   # only write results JSON
 *
 * Runs on Node too (Bun rows are skipped when `Bun` is absent) so the
 * fallback columns stay verifiable anywhere.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync as nodeGzipSync } from "node:zlib";
import { bunGzipSync, isBunRuntime } from "../packages/native/src/bun";
import {
  crc32 as crc32Native,
  fnv1a64,
  fnv1a64Fallback,
  passwordHash,
  passwordHashFallback,
  passwordVerify,
} from "../packages/native/src/index";
import { crc32 as crc32Ts } from "../packages/native/src/util";

const enc = new TextEncoder();
const isBun = isBunRuntime();

// Structural view of the Bun surface used here (keeps the harness free of
// `any` and lets the `new`-constructor sites narrow cleanly).
interface BunBuiltins {
  file(path: string): { text(): Promise<string>; stat(): Promise<unknown> };
  write(path: string, data: string): Promise<number>;
  Glob: new (pattern: string) => { scan(opts?: { cwd?: string }): AsyncIterable<string> };
  escapeHTML(value: string): string;
  deepEquals(a: unknown, b: unknown, strict?: boolean): boolean;
  CryptoHasher: new (
    algo: string,
  ) => {
    update(data: string | Uint8Array): { digest(encoding?: string): string };
    digest(encoding?: string): string;
  };
  hash: { crc32(data: Uint8Array): number; wyhash(input: Uint8Array, seed?: number): bigint };
  password: {
    hashSync(password: string, options?: { algorithm?: string }): string;
    verifySync(hash: string, password: string): boolean;
  };
  spawnSync(cmds: readonly string[], options?: unknown): { stdout?: Buffer };
  env: Record<string, string | undefined>;
  semver: { satisfies(version: string, range: string): boolean };
  peek<T>(promise: Promise<T>): T | Promise<T>;
  version: string;
}
const B = (globalThis as unknown as { Bun?: BunBuiltins }).Bun;
const CryptoHasherCtor = B?.CryptoHasher;
const GlobCtor = B?.Glob;
const Password = B?.password;

// ── Inputs (representative of real usage) ─────────────────────────────
const smallText = `{"id":42,"name":"widget","tags":["a","b","c"],"active":true,"meta":{"k":"v"}}`;
const bigText = `payload ${"x".repeat(8 * 1024)}`;
const bigBytes = enc.encode(bigText);
const htmlInput = `<div class="a" title="&quot;x&quot;">hi & <b>there</b> 'y'</div>${"z".repeat(512)}`;
const deepA = { a: 1, b: [1, 2, 3], c: { d: "e", f: [true, false, null] }, g: "x".repeat(64) };
const deepB = JSON.parse(JSON.stringify(deepA)) as typeof deepA;
const wsKey = "dGhlIHNhbXBsZSBub25jZQ==";
const wsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const pw = "hunter2-ignex-bench";
const salt = enc.encode("somesalt1234");
const pwHashNative = passwordHash(pw, salt);
const pwHashScrypt = passwordHashFallback(enc.encode(pw), salt);
const semverRange = ">=1.4.0 <2.0.0";

// ── Temp fixtures for file-IO ops ─────────────────────────────────────
const tmpRoot = mkdtempSync(join(tmpdir(), "ignex-bun-internals-"));
const tmpFile = join(tmpRoot, "sample.txt");
const tmpDir = join(tmpRoot, "tree");
const tmpOut = join(tmpRoot, "out.bin");
writeFileSync(tmpFile, bigText, "utf8");
for (let d = 0; d < 3; d++) {
  const dir = join(tmpDir, `sub${d}`);
  mkdirSync(dir, { recursive: true });
  for (let f = 0; f < 20; f++) writeFileSync(join(dir, `file${f}.txt`), smallText, "utf8");
}

/** Recursive `.txt` scan via node:fs (the current `Bun.Glob` alternative). */
const scanNodeFs = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if ((entry.name ?? "").endsWith(".txt")) out.push(full);
    }
  };
  walk(dir);
  return out;
};

// ── Measurement helpers ───────────────────────────────────────────────
const WIN_LABEL = 1.05;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Ops/sec for a sync fn (warmup + timed loop). */
function opsPerSec(fn: () => unknown, durationMs = 120, warmup = 200): number {
  for (let i = 0; i < warmup; i++) fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

/** Ops/sec for an async fn (warmup + timed loop of awaited calls). */
async function opsPerSecAsync(
  fn: () => Promise<unknown>,
  durationMs = 120,
  warmup = 50,
): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    await fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

interface BenchOp {
  name: string;
  bun: (() => unknown) | null;
  current: () => unknown;
  /** KDFs / compressors / spawn are expensive — tiny warmup, tiny window. */
  expensive?: boolean;
  /** Async ops (file IO / password). */
  async?: boolean;
}

const ops: BenchOp[] = [
  // ── File IO: Bun.file/Bun.write vs node:fs/promises ────────────────
  {
    name: "fileReadText (8KB)",
    bun: () => B?.file(tmpFile)?.text(),
    current: () => readFile(tmpFile, "utf8"),
    async: true,
  },
  {
    name: "fileWrite (8KB)",
    bun: () => B?.write(tmpOut, bigText),
    current: () => writeFile(tmpOut, bigText, "utf8"),
    async: true,
  },
  {
    name: "fileStat (size/mtime)",
    bun: () => B?.file(tmpFile)?.stat(),
    current: () => stat(tmpFile),
    async: true,
  },
  {
    name: "dirScan (Bun.Glob vs readdir)",
    bun: async () => {
      if (!GlobCtor) return [];
      const glob = new GlobCtor("**/*.txt");
      const out: string[] = [];
      for await (const match of glob.scan({ cwd: tmpDir })) out.push(match);
      return out;
    },
    current: () => scanNodeFs(tmpDir),
    async: true,
  },
  // ── String / JSON helpers ──────────────────────────────────────────
  {
    name: "escapeHTML (512B)",
    bun: () => B?.escapeHTML(htmlInput),
    current: () => escapeHtml(htmlInput),
  },
  {
    name: "deepEquals (nested JSON)",
    bun: () => B?.deepEquals(deepA, deepB, true),
    current: () => deepEqual(deepA, deepB),
  },
  // ── Crypto ─────────────────────────────────────────────────────────
  {
    name: "sha1 → base64 (WS accept)",
    bun: () => {
      if (!CryptoHasherCtor) return "";
      return new CryptoHasherCtor("sha1").update(wsKey + wsGuid).digest("base64");
    },
    current: () => createHash("sha1").update(`${wsKey}${wsGuid}`).digest("base64"),
  },
  {
    name: "randomBytes (16B CSPRNG)",
    bun: () => {
      const out = new Uint8Array(16);
      crypto.getRandomValues(out);
      return out;
    },
    current: () => randomBytes(16),
  },
  {
    name: "gzip (8KB, level 6)",
    bun: () => bunGzipSync?.(bigBytes, 6),
    current: () => nodeGzipSync(bigBytes, { level: 6 }),
    expensive: true,
  },
  // ── Hashing ────────────────────────────────────────────────────────
  {
    name: "wyhash vs fnv1a64 (cache key)",
    bun: () => B?.hash.wyhash(bigBytes),
    current: () => fnv1a64(bigText).toString(16),
  },
  {
    name: "wyhash vs fnv1a64-fallback (cache key)",
    bun: () => B?.hash.wyhash(bigBytes),
    current: () => fnv1a64Fallback(bigBytes).toString(16),
  },
  {
    name: "crc32 (Bun vs native)",
    bun: () => B?.hash.crc32(bigBytes),
    current: () => crc32Native(bigBytes),
  },
  {
    name: "crc32 (Bun vs TS table)",
    bun: () => B?.hash.crc32(bigBytes),
    current: () => crc32Ts(bigBytes),
  },
  // ── Passwords (sync variants) ──────────────────────────────────────
  {
    name: "passwordHash (argon2id: Bun vs native)",
    bun: () => {
      if (!Password) return "";
      return Password.hashSync(pw, { algorithm: "argon2id" });
    },
    current: () => passwordHash(pw, salt),
    expensive: true,
  },
  {
    name: "passwordHash (Bun argon2id vs scrypt fallback)",
    bun: () => {
      if (!Password) return "";
      return Password.hashSync(pw, { algorithm: "argon2id" });
    },
    current: () => passwordHashFallback(enc.encode(pw), salt),
    expensive: true,
  },
  {
    name: "passwordVerify (argon2id: Bun vs native)",
    bun: () => {
      if (!Password) return false;
      return Password.verifySync(pwHashNative, pw);
    },
    current: () => passwordVerify(pwHashNative, pw),
    expensive: true,
  },
  {
    name: "passwordVerify (scrypt: Bun vs fallback)",
    bun: () => {
      if (!Password) return false;
      return Password.verifySync(pwHashScrypt, pw);
    },
    current: () => passwordVerify(pwHashScrypt, pw),
    expensive: true,
  },
  // ── Process / env / misc ───────────────────────────────────────────
  {
    name: "spawnSync echo (capture)",
    bun: () => B?.spawnSync(["echo", "hi"])?.stdout,
    current: () => spawnSync("echo", ["hi"]).stdout,
    expensive: true,
  },
  {
    name: "env read (Bun.env vs process.env)",
    bun: () => B?.env.PATH,
    current: () => process.env.PATH,
  },
  {
    name: "semver.satisfies vs manual compare",
    bun: () => B?.semver.satisfies("1.4.5", semverRange),
    current: () => semverSatisfies("1.4.5", semverRange),
  },
  {
    name: "peek resolved promise",
    bun: () => {
      const p = Promise.resolve(42);
      return B?.peek(p);
    },
    current: () => {
      const p = Promise.resolve(42);
      return p;
    },
  },
];

// ── Current implementations (byte-identical references for the bench) ──
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    a != null &&
    b != null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
};

/** Minimal semver range check (`>=X <Y` form) — the current manual approach. */
const semverSatisfies = (version: string, range: string): boolean => {
  const [vMajor = 0, vMinor = 0, vPatch = 0] = version.split(".").map((n) => Number(n));
  const lower = />=(\d+)\.(\d+)\.(\d+)/.exec(range);
  const upper = /<(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (lower) {
    const [lm, lmn, lp] = [Number(lower[1]), Number(lower[2]), Number(lower[3])];
    if (
      vMajor < lm ||
      (vMajor === lm && (vMinor < lmn || (vMinor === lmn && (vPatch ?? 0) < lp)))
    ) {
      return false;
    }
  }
  if (upper) {
    const [um, umn, up] = [Number(upper[1]), Number(upper[2]), Number(upper[3])];
    if (
      vMajor > um ||
      (vMajor === um && (vMinor > umn || (vMinor === umn && (vPatch ?? 0) >= up)))
    ) {
      return false;
    }
  }
  return true;
};

const TRIALS = 5;
const SWAP_AT = 1.0;

interface Result {
  name: string;
  bun: number;
  current: number;
  ratio: number;
  verdict: string;
}

/** Benchmark one op (median of interleaved trials; tolerant of throws). */
async function benchOp(op: BenchOp): Promise<Result> {
  const warmup = op.expensive ? 3 : 200;
  const durationMs = op.expensive ? 60 : 120;
  const bS: number[] = [];
  const cS: number[] = [];
  let errored = false;
  for (let t = 0; t < TRIALS; t++) {
    try {
      if (op.async) {
        if (op.bun)
          bS.push(
            await opsPerSecAsync(op.bun as () => Promise<unknown>, durationMs, Math.max(5, warmup)),
          );
        cS.push(
          await opsPerSecAsync(
            op.current as () => Promise<unknown>,
            durationMs,
            Math.max(5, warmup),
          ),
        );
      } else {
        if (op.bun) bS.push(opsPerSec(op.bun, durationMs, warmup));
        cS.push(opsPerSec(op.current, durationMs, warmup));
      }
    } catch {
      errored = true;
      break;
    }
  }
  const bun = op.bun ? median(bS) : Number.NaN;
  const current = median(cS);
  const ratio = Number.isFinite(bun) ? bun / current : Number.NaN;
  const verdict = errored
    ? "error"
    : !Number.isFinite(ratio)
      ? "n/a"
      : ratio >= WIN_LABEL
        ? "bun wins"
        : ratio <= 1 / WIN_LABEL
          ? "keep"
          : "parity";
  return { name: op.name, bun, current, ratio, verdict };
}

async function run(): Promise<void> {
  if (!isBun) {
    console.log("Bun unavailable — only `current` columns measured (no swap decisions).");
  }
  console.log(
    `Bun builtin vs current impl (median of ${TRIALS} interleaved trials; swap-at ≥${SWAP_AT.toFixed(2)}x, label-at ≥${WIN_LABEL.toFixed(2)}x):\n`,
  );
  console.log(
    `${"op".padEnd(36)} ${"bun".padStart(10)} ${"current".padStart(10)} ${"ratio".padStart(8)} verdict`,
  );

  const results: Result[] = [];
  for (const op of ops) {
    const result = await benchOp(op);
    results.push(result);
    const errNote = result.verdict === "error" ? " (incompatible/throws — see matrix)" : "";
    const bunCell = Number.isFinite(result.bun) ? String(Math.round(result.bun)) : "-";
    const curCell = String(Math.round(result.current));
    const ratioCell = Number.isFinite(result.ratio) ? result.ratio.toFixed(2) : "-";
    console.log(
      `${result.name.padEnd(36)} ${bunCell.padStart(10)} ${curCell.padStart(10)} ${ratioCell.padStart(8)} ${result.verdict}${errNote}`,
    );
  }

  const out = {
    generated: new Date().toISOString(),
    runtime: `bun ${B?.version ?? "unknown"}`,
    trials: TRIALS,
    swapAt: SWAP_AT,
    results,
  };
  const outPath = resolve("bench/results/bun-internals.json");
  mkdirSync(resolve("bench/results"), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nwrote ${outPath}`);
}

void run();
