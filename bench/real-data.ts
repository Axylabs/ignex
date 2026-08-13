/**
 * bench/real-data.ts — deterministic, realistic request fixtures for the
 * end-to-end compiled-server benchmark.
 *
 * Generated with a fixed-seed LCG so the native / fallback / raw-bun modes all
 * receive byte-identical payloads. The session cookie (hex HMAC, matching
 * castrum's signed-cookie format) and the HS256 JWT (base64url HMAC) are
 * produced with node:crypto so both the raw-Bun baseline and ignex's native
 * verifiers accept them with the shared {@link BENCH_SECRET}.
 */
import { createHmac } from "node:crypto";

/** Shared signing secret used by the bench servers + fixtures. */
export const BENCH_SECRET = "ignex-bench-secret";

/** Deterministic 32-bit LCG (fixed seed) — identical values across runs. */
let lcgState = 0x9e3779b9;
const resetLcg = (): void => {
  lcgState = 0x9e3779b9;
};
const rand = (): number => {
  lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
  return lcgState / 0x100000000;
};

const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");

/** Lowercase-hex HMAC-SHA256 — matches castrum's signed-cookie format. */
const hmacHex = (data: string): string =>
  createHmac("sha256", BENCH_SECRET).update(data).digest("hex");

/** base64url HMAC-SHA256 — matches standard HS256 JWT signatures. */
const hmacB64url = (data: string): string =>
  createHmac("sha256", BENCH_SECRET).update(data).digest("base64url");

/**
 * A realistic order JSON body (lineItems + address + payment). `items` line
 * items each with a product name, quantity, unit price and a repeated note
 * (so the body is tens of KB — JSON.parse / validation work is real).
 */
export const ordersBody = (items = 80): string => {
  resetLcg();
  const lineItems: Array<Record<string, unknown>> = [];
  for (let i = 0; i < items; i++) {
    lineItems.push({
      sku: `SKU-${(i * 7919) % 100000}`,
      name: `Product ${rand().toString(36).slice(2, 8)} ${rand().toString(36).slice(2, 8)}`,
      quantity: 1 + Math.floor(rand() * 4),
      unitPriceCents: 100 + Math.floor(rand() * 99900),
      note: "expedite if possible, gift wrap requested".repeat(1 + Math.floor(rand() * 3)),
    });
  }
  const subtotalCents = lineItems.reduce(
    (sum, li) => sum + (li.quantity as number) * (li.unitPriceCents as number),
    0,
  );
  return JSON.stringify({
    orderId: `ORD-${Math.floor(rand() * 1e9)}`,
    customer: {
      id: `C-${Math.floor(rand() * 1e6)}`,
      email: `cust${Math.floor(rand() * 1e6)}@example.com`,
      name: `${rand().toString(36).slice(2, 7)} ${rand().toString(36).slice(2, 7)}`,
    },
    shippingAddress: {
      line1: `${Math.floor(rand() * 9999)} ${rand().toString(36).slice(2, 9)} St`,
      city: rand().toString(36).slice(2, 8),
      region: rand().toString(36).slice(2, 5).toUpperCase(),
      postalCode: `${Math.floor(rand() * 9)}${Math.floor(rand() * 9)}${Math.floor(rand() * 9)}${Math.floor(rand() * 9)}${Math.floor(rand() * 9)}`,
      country: "US",
    },
    lineItems,
    payment: { method: "card", last4: `${Math.floor(rand() * 10000)}`.padStart(4, "0") },
    subtotalCents,
    taxCents: Math.floor(subtotalCents * 0.08),
    totalCents: Math.floor(subtotalCents * 1.08),
    currency: "USD",
  });
};

/** A query string with `n` parameters (some URL-encoded to force decoding). */
export const searchQuery = (n = 60): string => {
  resetLcg();
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = `filter[${i}]`;
    const value =
      i % 3 === 0
        ? `value%20with%20spaces%26and%3Dsymbols`
        : `value${i}-${rand().toString(36).slice(2, 8)}`;
    parts.push(`${key}=${value}`);
  }
  parts.push("page=3", "sort=price&sort=rating", "q=catalog+search+term");
  return parts.join("&");
};

/** A `Cookie` header with `n` pairs plus a valid signed session cookie. */
export const cookieHeader = (n = 30): string => {
  resetLcg();
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`k${i}=v${i}-${rand().toString(36).slice(2, 10)}`);
  }
  const sid = `sess-${Math.floor(rand() * 1e12).toString(36)}`;
  parts.push(`sid=${sid}.${hmacHex(sid)}`);
  return parts.join("; ");
};

/** A valid HS256 JWT (sub/role/exp) signed with {@link BENCH_SECRET}. */
export const bearerToken = (): string => {
  const header = b64url(Buffer.from('{"alg":"HS256","typ":"JWT"}'));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        sub: "bench-user",
        role: "admin",
        iat: 1_750_000_000,
        exp: 1_900_000_000,
      }),
    ),
  );
  const signature = hmacB64url(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
};

/** A deterministic catalog of `n` items (for template rendering). */
export const catalogItems = (n = 120): Array<Record<string, unknown>> => {
  resetLcg();
  const items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: i + 1,
      name: `Catalog Item ${i} ${rand().toString(36).slice(2, 7)}`,
      price: (rand() * 500).toFixed(2),
      stock: Math.floor(rand() * 1000),
      tags: ["new", "featured", "sale"].filter(() => rand() > 0.4),
      description: "A thoughtfully designed product for daily use. ".repeat(
        2 + Math.floor(rand() * 3),
      ),
    });
  }
  return items;
};

/** A large JSON document (for the gzip / big-response scenario), ~`kb` KB. */
export const bigJson = (kb = 256): string => {
  resetLcg();
  const rows: Array<Record<string, unknown>> = [];
  const target = kb * 1024;
  let approx = 0;
  while (approx < target) {
    rows.push({
      id: rows.length,
      ts: 1_750_000_000 + rows.length,
      metric: Math.floor(rand() * 1_000_000),
      series: Array.from({ length: 8 }, () => Math.floor(rand() * 1000)),
      label: rand().toString(36).slice(2, 14).repeat(2),
    });
    approx += 220;
  }
  return JSON.stringify({ generated: kb, rows });
};
