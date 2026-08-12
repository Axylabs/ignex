#!/usr/bin/env bun
/**
 * @fileoverview CI regression gate for the end-to-end compiled-server benchmark.
 *
 * Compares the freshly-written `bench/results/server/latest.json` (produced by
 * `bun run bench:server`) against the committed `baseline.json`. Fails when:
 *   1. any route's NATIVE req/s regresses more than `NATIVE_RPS_REGRESSION`
 *      (default 10%) vs the committed baseline, or
 *   2. NATIVE req/s falls more than `NATIVE_VS_FALLBACK_DEGRADE` (default 15%)
 *      behind the FALLBACK run in the same `latest.json` (the native layer must
 *      never be meaningfully slower than pure-JS).
 *
 * Env overrides:
 *   NATIVE_RPS_REGRESSION     — allowed native-vs-baseline drop (default 0.10)
 *   NATIVE_VS_FALLBACK_DEGRADE— allowed native-vs-fallback drop (default 0.15)
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const RESULTS_DIR = new URL("../bench/results/server/", import.meta.url).pathname;
const NATIVE_RPS_REGRESSION = Number(process.env.NATIVE_RPS_REGRESSION ?? 0.1);
const NATIVE_VS_FALLBACK_DEGRADE = Number(process.env.NATIVE_VS_FALLBACK_DEGRADE ?? 0.15);

interface RouteResult {
  label: string;
  rps: number;
}

interface ModeResult {
  mode: string;
  routes: RouteResult[];
}

interface Report {
  modes: ModeResult[];
}

const readReport = async (file: string): Promise<Report> => {
  const raw = await readFile(join(RESULTS_DIR, file), "utf8");
  return JSON.parse(raw) as Report;
};

const routeRps = (report: Report, mode: string): Map<string, number> =>
  new Map((report.modes.find((m) => m.mode === mode)?.routes ?? []).map((r) => [r.label, r.rps]));

const latest = await readReport("latest.json");
let baseline: Report;
try {
  baseline = await readReport("baseline.json");
} catch {
  // No committed baseline yet — the latest run becomes the reference.
  baseline = latest;
}

const latestNative = routeRps(latest, "native");
const latestFallback = routeRps(latest, "fallback");
const baselineNative = routeRps(baseline, "native");

const failures: string[] = [];

for (const [label, nativeRps] of latestNative) {
  const base = baselineNative.get(label);
  if (base !== undefined && base > 0 && nativeRps < base * (1 - NATIVE_RPS_REGRESSION)) {
    failures.push(
      `${label}: native ${nativeRps.toFixed(1)} rps regressed >${(NATIVE_RPS_REGRESSION * 100).toFixed(0)}% vs baseline ${base.toFixed(1)}`,
    );
  }

  const fallbackRps = latestFallback.get(label);
  if (
    fallbackRps !== undefined &&
    fallbackRps > 0 &&
    nativeRps < fallbackRps * (1 - NATIVE_VS_FALLBACK_DEGRADE)
  ) {
    failures.push(
      `${label}: native ${nativeRps.toFixed(1)} rps fell >${(NATIVE_VS_FALLBACK_DEGRADE * 100).toFixed(0)}% behind fallback ${fallbackRps.toFixed(1)}`,
    );
  }
}

if (failures.length > 0) {
  console.error("server-bench gate FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("server-bench gate OK: native at/above baseline and within band of fallback.");
