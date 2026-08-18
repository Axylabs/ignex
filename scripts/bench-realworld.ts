#!/usr/bin/env bun
/**
 * Real-world load probe — `bun scripts/bench-realworld.ts`
 *
 * Boots the AOT-compiled server and hammers it with REALISTIC traffic classes
 * (large valid POSTs, schema-invalid POSTs, malformed-JSON POSTs, small GETs,
 * JWT-auth GETs) at a fixed concurrency, reporting per-class throughput + avg
 * latency. Unlike the synthetic benches (small payloads, no bad traffic) this
 * exposes where time actually goes under load:
 *
 *   - small requests → framework overhead (should be ~30K rps on /health)
 *   - large-body POSTs → JSON.parse + DOM/GC (the real-world bottleneck)
 *   - schema-invalid / malformed POSTs → cost of parsing before rejection
 *
 * Env overrides:
 *   PORT        — server port (default 3998)
 *   CONCURRENCY — parallel connections (default 16)
 *   ITEMS       — line items in the large order body (default 5000)
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const PORT = Number(process.env.PORT ?? 3998);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const ITEMS = Number(process.env.ITEMS ?? 5000);

const BASE = `http://127.0.0.1:${PORT}`;

function makeOrderBody(n: number): string {
  return JSON.stringify({
    orderId: "order-1234",
    customer: { id: "c1", email: "a@b.com", name: "n" },
    shippingAddress: { line1: "l", city: "c", region: "r", postalCode: "p", country: "US" },
    lineItems: Array.from({ length: n }, (_, i) => ({
      sku: `sku-${i}-abcdefghijklmnopqrstuvwxyz`,
      name: `item number ${i} with padding`,
      quantity: (i % 10) + 1,
      unitPriceCents: 100 + (i % 5000),
      ...(i % 3 ? {} : { note: "optional note here" }),
    })),
    payment: { method: "card", last4: "4242" },
    subtotalCents: 1,
    taxCents: 1,
    totalCents: 1,
    currency: "USD",
  });
}

const large = makeOrderBody(ITEMS);
const invalid = large.replace('"currency":"USD"', '"currency":123');
const malformed = `${large.slice(0, large.length - 40)}not json`;

async function run(label: string, fn: () => Promise<Response>, n: number): Promise<void> {
  for (let i = 0; i < 15; i++) await fn().catch(() => {});
  const start = Date.now();
  let done = 0;
  let ok = 0;
  let totalMs = 0;
  let max = 0;
  const errors: Record<string, number> = {};

  const runOne = async (): Promise<void> => {
    const t0 = performance.now();
    try {
      const r = await fn();
      const ms = performance.now() - t0;
      totalMs += ms;
      if (ms > max) max = ms;
      if (r.status === 200 || r.status === 201 || r.status === 400 || r.status === 422) {
        ok++;
      } else {
        errors[`status_${r.status}`] = (errors[`status_${r.status}`] ?? 0) + 1;
      }
    } catch (e) {
      errors[`err_${String(e).slice(0, 40)}`] = (errors[`err_${String(e).slice(0, 40)}`] ?? 0) + 1;
    }
    done++;
  };

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (done < n) await runOne();
  });
  await Promise.all(workers);

  const el = Date.now() - start;
  const rps = (done / el) * 1000;
  console.log(
    `${label.padEnd(34)} rps=${rps.toFixed(0).padStart(6)} avg=${(totalMs / Math.max(1, done)).toFixed(1).padStart(7)}ms max=${max.toFixed(1).padStart(7)}ms ok=${ok}${Object.keys(errors).length ? ` errs=${JSON.stringify(errors)}` : ""}`,
  );
}

const child = spawn("bun", ["dist/__server.js"], {
  cwd: new URL("../packages/app/", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), IGNEX_HTTPS: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});

try {
  await new Promise((r) => setTimeout(r, 1500));
  console.log(
    `real-world load probe — concurrency=${CONCURRENCY}, items=${ITEMS}, server=:${PORT}`,
  );

  await run("GET /health (small)", () => fetch(`${BASE}/health`), 2000);
  await run(
    `POST /api/orders ${ITEMS} items (valid)`,
    () =>
      fetch(`${BASE}/api/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: large,
      }),
    300,
  );
  await run(
    `POST /api/orders ${ITEMS} items (schema-invalid)`,
    () =>
      fetch(`${BASE}/api/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: invalid,
      }),
    300,
  );
  await run(
    "POST /api/orders malformed JSON",
    () =>
      fetch(`${BASE}/api/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: malformed,
      }),
    300,
  );
  await run(
    "GET /api/reports/42 (JWT reject)",
    () => fetch(`${BASE}/api/reports/42`, { headers: { authorization: "Bearer x.y.z" } }),
    1000,
  );
} finally {
  child.kill("SIGTERM");
  process.exit(0);
}
