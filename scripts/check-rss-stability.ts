#!/usr/bin/env bun
/**
 * RSS-stability probe (WS3).
 *
 * Loads the COMPILED server in-process, drives steady-state GET /health load
 * for ~3 minutes, and samples RSS every 5 seconds with a FULL forced GC
 * (`Bun.gc(true)`) before each sample so transient churn (the bench's fetch
 * buffers, minor-GC timing) settles out — the same settle protocol
 * bench-allocations uses. The leak signal is END drift: final settled RSS
 * vs the warmup-plateau settled RSS. Exits non-zero when end drift exceeds
 * the configured threshold (20% by default). Peak drift (transient spikes)
 * is reported for information only.
 *
 * Threshold rationale (tuned once, 2026-09-18): instantaneous RSS under
 * minor GC oscillates ±20% on Bun, so a peak-vs-plateau check false-fails
 * on noise; post-full-GC settled RSS is stable to ~±4% on this workload,
 * so 20% end-drift is a genuine leak signal.
 *
 * Usage:
 *   bun scripts/check-rss-stability.ts
 *   bun scripts/check-rss-stability.ts --duration-secs 180 --threshold 0.2
 *   bun scripts/check-rss-stability.ts --json
 */
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const getNum = (flag: string, fallback: number): number => {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

// ── Tunables ───────────────────────────────────────────────────────────
const DEFAULT_SERVER = resolve(import.meta.dir, "../packages/app/dist/__server.js");
const SAMPLE_INTERVAL_SECS = 5;
const DURATION_SECS = getNum("--duration-secs", 180); // 3 min default
const WARMUP_SAMPLES = 4; // first 4 samples (20s) define the "plateau"
const THRESHOLD = getNum("--threshold", 0.2); // 20% max drift over plateau

const serverPath = DEFAULT_SERVER;
try {
  statSync(serverPath);
} catch {
  console.error(
    `[check-rss] compiled server not found: ${serverPath}\nBuild it first: bun run build`,
  );
  process.exit(1);
}

const appDir = resolve(dirname(serverPath), "..");
process.chdir(appDir);
try {
  process.loadEnvFile(join(appDir, ".env"));
} catch {
  /* optional */
}

process.env.PORT ??= "9211";
process.env.SESSION_SECRET ??= "bench-rss-secret";

const mod = await import(pathToFileURL(serverPath).href);
const server = mod as { default?: { port: number; stop: () => void } };
if (!server?.default) {
  console.error("[check-rss] no server exported");
  process.exit(1);
}

const base = `http://127.0.0.1:${server.default.port}/health`;
const rssSamples: number[] = [];
const timestamps: number[] = [];
const startTs = Date.now();

const sampleRss = (): number => {
  // Force a FULL GC so the sample reflects the server's settled retained
  // state, not the bench's fetch-buffer churn (same protocol as
  // bench-allocations).
  if (typeof Bun !== "undefined") Bun.gc(true);
  return process.memoryUsage().rss;
};

// ── Steady-state load loop ─────────────────────────────────────────────
// Drive ~1000 req/s by issuing requests as fast as possible and sleeping
// briefly if we overshoot. We don't need exact rate — just enough load to
// keep the server busy while we sample.
const DURATION_MS = DURATION_SECS * 1000;
const SAMPLE_MS = SAMPLE_INTERVAL_SECS * 1000;

console.log(
  `[check-rss] measuring for ${DURATION_SECS}s — ` +
    `${WARMUP_SAMPLES} warmup samples, threshold ${(THRESHOLD * 100).toFixed(0)}%`,
);

let inFlight = 0;
const CONCURRENCY = 16;

const driveOne = async (): Promise<void> => {
  const res = await fetch(base);
  await res.arrayBuffer();
};

// Keep a steady load: fire CONCURRENCY requests, then kick off the next
// batch as each finishes.
const loadLoop = (async () => {
  while (Date.now() - startTs < DURATION_MS) {
    if (inFlight < CONCURRENCY) {
      inFlight++;
      driveOne().finally(() => {
        inFlight--;
      });
    } else {
      await new Promise((r) => setTimeout(r, 1));
    }
  }
})();

// ── Sampling loop ──────────────────────────────────────────────────────
while (Date.now() - startTs < DURATION_MS + SAMPLE_MS) {
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  const rss = sampleRss();
  rssSamples.push(rss);
  timestamps.push(Math.floor((Date.now() - startTs) / 1000));

  if (!AS_JSON) {
    console.log(
      `  t=${String(timestamps.at(-1)).padStart(5)}s   rss=${(rss / 1024 / 1024).toFixed(2)} MB`,
    );
  }
}

// Wait for any remaining in-flight requests, then stop.
await loadLoop;
server.default.stop();

// ── Analysis ───────────────────────────────────────────────────────────
if (rssSamples.length <= WARMUP_SAMPLES) {
  console.error("[check-rss] not enough samples to analyse");
  process.exit(1);
}

const plateauSamples = rssSamples.slice(0, WARMUP_SAMPLES);
const plateauAvg = plateauSamples.reduce((a, b) => a + b, 0) / plateauSamples.length;
const endSamples = rssSamples.slice(-WARMUP_SAMPLES);
const endAvg = endSamples.reduce((a, b) => a + b, 0) / endSamples.length;
const maxRss = Math.max(...rssSamples);
// Leak signal: settled END state vs warmup plateau. Transient peak noise is
// reported separately — it's not a leak.
const endDriftPct = (endAvg - plateauAvg) / plateauAvg;
const peakDriftPct = (maxRss - plateauAvg) / plateauAvg;

const pass = endDriftPct <= THRESHOLD;

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        samples: rssSamples.map((rss, i) => ({ t: timestamps[i], rss })),
        plateauAvgBytes: plateauAvg,
        endAvgBytes: endAvg,
        maxRssBytes: maxRss,
        endDriftPct: Number(endDriftPct.toFixed(4)),
        peakDriftPct: Number(peakDriftPct.toFixed(4)),
        thresholdPct: THRESHOLD,
        pass,
      },
      null,
      2,
    ),
  );
} else {
  console.log("── RSS drift analysis (post-full-GC settled samples) ─");
  console.log(
    `plateau avg   ${(plateauAvg / 1024 / 1024).toFixed(2)} MB (first ${WARMUP_SAMPLES} samples)`,
  );
  console.log(
    `end avg       ${(endAvg / 1024 / 1024).toFixed(2)} MB (last ${WARMUP_SAMPLES} samples)`,
  );
  console.log(`peak RSS      ${(maxRss / 1024 / 1024).toFixed(2)} MB`);
  console.log(
    `end drift     ${(endDriftPct * 100).toFixed(2)}%  (threshold: ${(THRESHOLD * 100).toFixed(0)}%)`,
  );
  console.log(`peak drift    ${(peakDriftPct * 100).toFixed(2)}%  (transient, informational)`);
  console.log(`verdict       ${pass ? "PASS ✅" : "FAIL ❌"}`);
}

process.exit(pass ? 0 : 1);
