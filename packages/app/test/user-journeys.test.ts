/**
 * @fileoverview Flow-based (user-journey) tests for the AOT-compiled server.
 *
 * The per-route matrix suites (`routing`, `request-body`, `validation`,
 * `headers-cookies`, …) prove each feature in isolation. These journeys drive
 * the SAME compiled artifact the way a real client does — each step consumes
 * the previous step's response (register → authenticate → refresh → logout;
 * upload → download → revalidate; cookie-chained sessions; a concurrent burst
 * across every journey). Regressions in cross-request state, cookie/header
 * propagation or the request lifecycle surface here even when every
 * single-route test still passes.
 *
 * One server is booted for the whole file through the shared {@link bootServer}
 * harness. Journeys that need a live MongoDB (resource CRUD, readiness) are
 * gated so a checkout without a database still verifies cleanly.
 */

import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJwt } from "@ignex/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BENCH_SECRET } from "../src/bench-data";
import { type BootedServer, bootServer } from "./helpers/boot";

const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const DIST_EXISTS = existsSync(join(APP_DIR, "dist", "__server.js"));

/**
 * The compiled bundle embeds `@ignex/ninox`, so booting an existing dist needs
 * no package resolution. A fresh checkout without a dist must rebuild, which
 * does need it — gate so the standalone monorepo verifies instead of erroring.
 */
const hasNinox = (() => {
  try {
    createRequire(import.meta.url).resolve("@ignex/ninox");
    return true;
  } catch {
    return false;
  }
})();
const CAN_BOOT = DIST_EXISTS || hasNinox;

/** Probe whether a MongoDB is listening on localhost:27017 (the app default). */
const hasLocalMongo = await new Promise<boolean>((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port: 27017 });
  const done = (ok: boolean): void => {
    socket.destroy();
    resolve(ok);
  };
  socket.setTimeout(800);
  socket.once("connect", () => done(true));
  socket.once("timeout", () => done(false));
  socket.once("error", () => done(false));
});

interface Json<T> {
  status: number;
  body: T;
  headers: Headers;
}

const postJson = async <T = unknown>(
  base: string,
  path: string,
  payload: unknown,
): Promise<Json<T>> => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as T,
    headers: res.headers,
  };
};

const getJson = async <T = unknown>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<Json<T>> => {
  const res = await fetch(`${base}${path}`, init);
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as T,
    headers: res.headers,
  };
};

const uniqueName = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A minimal valid body for `POST /api/orders` (one line item). */
const validOrder = (): Record<string, unknown> => ({
  orderId: "order-journey-1",
  customer: { id: "cust-1", email: "journey@example.com", name: "Journey Tester" },
  shippingAddress: {
    line1: "1 Test Way",
    city: "Testville",
    region: "TS",
    postalCode: "00000",
    country: "US",
  },
  lineItems: [{ sku: "sku-1", name: "Widget", quantity: 2, unitPriceCents: 100 }],
  payment: { method: "card", last4: "4242" },
  subtotalCents: 200,
  taxCents: 0,
  totalCents: 200,
  currency: "USD",
});

describe.runIf(CAN_BOOT)("user journeys (compiled server)", () => {
  let base = "";
  let srv: BootedServer;
  /** Files created by the upload journey, removed when the suite finishes. */
  const uploaded: string[] = [];

  beforeAll(async () => {
    srv = await bootServer(APP_DIR, {
      protocol: "http",
      // Production shape: plain HTTP (no auto dev certs) and NODE_ENV so the
      // server runs its non-development behavior, as a deployment would.
      env: { IGNEX_HTTPS: "0", NODE_ENV: "production" },
    });
    base = srv.base;
  }, 90_000);

  afterAll(() => {
    for (const name of uploaded) rmSync(join(APP_DIR, "uploads", name), { force: true });
    srv?.close();
  });

  describe("account lifecycle", () => {
    it("registers, authenticates, refreshes, logs out, then logs back in", async () => {
      const username = uniqueName("journey");
      const password = "journey-pass-123";

      // 1. Register — returns both tokens.
      const reg = await postJson<{ accessToken: string; refreshToken: string; expiresIn: number }>(
        base,
        "/auth/register",
        { username, password, roles: ["user", "editor"] },
      );
      expect(reg.status).toBe(201);
      const { accessToken, refreshToken } = reg.body;
      expect(typeof accessToken).toBe("string");
      expect(typeof refreshToken).toBe("string");
      expect(reg.body.expiresIn).toBe(900);

      // 2. The same username cannot be registered twice.
      expect((await postJson(base, "/auth/register", { username, password })).status).toBe(409);

      // 3. The protected route is closed without a token.
      expect((await getJson(base, "/auth/me")).status).toBe(401);
      expect(
        (await getJson(base, "/auth/me", { headers: { authorization: "Bearer not-a-jwt" } }))
          .status,
      ).toBe(401);

      // 4. The access token opens it and carries the registered claims.
      const me = await getJson<{ user?: { sub?: string; roles?: string[] } }>(base, "/auth/me", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(me.status).toBe(200);
      expect(me.body.user?.sub).toBe(username);
      expect(me.body.user?.roles).toContain("editor");

      // 5. Refreshing mints a new, working access token.
      const refreshed = await postJson<{ accessToken?: string }>(base, "/auth/refresh", {
        refreshToken,
      });
      expect(refreshed.status).toBe(200);
      expect(typeof refreshed.body.accessToken).toBe("string");
      const meAgain = await getJson(base, "/auth/me", {
        headers: { authorization: `Bearer ${refreshed.body.accessToken}` },
      });
      expect(meAgain.status).toBe(200);

      // 6. Logout revokes the refresh token server-side.
      const out = await postJson<{ ok?: boolean }>(base, "/auth/logout", { refreshToken });
      expect(out.status).toBe(200);
      expect(out.body.ok).toBe(true);

      // 7. The revoked token can no longer be exchanged…
      expect((await postJson(base, "/auth/refresh", { refreshToken })).status).toBe(401);
      // …but the credentials still log in (revocation is token-scoped).
      const login = await postJson<{ accessToken?: string }>(base, "/auth/login", {
        username,
        password,
      });
      expect(login.status).toBe(200);
      expect(typeof login.body.accessToken).toBe("string");
      expect(
        (await postJson(base, "/auth/login", { username, password: "wrong-password" })).status,
      ).toBe(401);
    });
  });

  describe("signed-token report journey", () => {
    it("mints an HS256 token, reads a report, and rejects anonymous/tampered tokens", async () => {
      const jwt = createJwt({ secret: BENCH_SECRET, ttlSeconds: 3600 });
      const subject = uniqueName("reporter");
      const token = await jwt.sign({ sub: subject });

      expect((await getJson(base, "/api/reports/7")).status).toBe(401);

      const ok = await getJson<{ ok?: boolean; report?: { id?: string; owner?: string } }>(
        base,
        "/api/reports/7",
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(ok.status).toBe(200);
      expect(ok.body.report?.id).toBe("7");
      expect(ok.body.report?.owner).toBe(subject);

      // Flipping the final signature byte must not verify.
      const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      expect(
        (
          await getJson(base, "/api/reports/7", {
            headers: { authorization: `Bearer ${tampered}` },
          })
        ).status,
      ).toBe(401);
    });
  });

  describe("session continuity", () => {
    it("chains the session cookie across requests, incrementing visits", async () => {
      let cookie = "";
      for (let visit = 1; visit <= 3; visit++) {
        const res = await fetch(`${base}/session`, { headers: cookie ? { cookie } : {} });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { visits?: number; isNew?: boolean };
        expect(body.visits).toBe(visit);
        expect(body.isNew).toBe(visit === 1);

        const setCookie = res.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("sid=");
        expect(setCookie).toContain("HttpOnly");
        // A browser follows the rotated cookie; the journey must too.
        cookie = setCookie.split(";")[0] ?? "";
      }
    });
  });

  describe("upload → download journey", () => {
    it("uploads a file and serves it back byte-identically (revalidate + range)", async () => {
      const bytes = new TextEncoder().encode(`journey payload ${uniqueName("bytes")}\n`);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "text/plain" }), "journey.txt");

      const up = (await (await fetch(`${base}/upload`, { method: "POST", body: form })).json()) as {
        ok?: boolean;
        size?: number;
        path?: string;
      };
      expect(up.ok).toBe(true);
      expect(up.size).toBe(bytes.byteLength);
      expect(up.path).toMatch(/^\/files\//);
      uploaded.push(basename(up.path ?? ""));

      // Full download: exact bytes + attachment disposition + cache validators.
      const dl = await fetch(`${base}${up.path}`);
      expect(dl.status).toBe(200);
      expect(dl.headers.get("content-disposition")).toContain("journey.txt");
      expect((await dl.arrayBuffer()).byteLength).toBe(bytes.byteLength);
      const etag = dl.headers.get("etag");
      expect(etag).toBeTruthy();

      // Revalidation with the served ETag → 304 with no body.
      const cached = await fetch(`${base}${up.path}`, { headers: { "if-none-match": etag ?? "" } });
      expect(cached.status).toBe(304);

      // A partial range serves exactly the requested slice.
      const range = await fetch(`${base}${up.path}`, { headers: { range: "bytes=0-4" } });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-range")).toMatch(/^bytes 0-4\//);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.slice(0, 5));
    });

    it("rejects an upload with no file part", async () => {
      const res = await fetch(`${base}/upload`, { method: "POST", body: new FormData() });
      expect(res.status).toBe(400);
    });
  });

  describe("request-validation journey", () => {
    it("validates a bulk order, rejects invalid schemas, and acks a valid order", async () => {
      const ok = await postJson<{ ok?: boolean; count?: number; total?: number }>(
        base,
        "/api/orders",
        validOrder(),
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true, count: 1, total: 200 });

      const badOrder = validOrder();
      badOrder.lineItems = [{ sku: "sku-1", name: "Widget", quantity: 0, unitPriceCents: 100 }];
      const bad = await postJson<{ error?: string; code?: string }>(base, "/api/orders", badOrder);
      expect(bad.status).toBe(422);
      expect(bad.body.error).toBe("Validation failed");
      expect(bad.body.code).toBe("VALIDATION_ERROR");

      const malformed = await fetch(`${base}/api/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });
      expect(malformed.status).toBe(400);

      // The schema-first ack route validates the raw bytes natively and calls
      // the handler only on the happy path.
      const ack = await postJson<{ ok?: boolean }>(base, "/api/orders-ack", {
        orderId: "ack-1",
        quantity: 1,
        totalCents: 5,
      });
      expect(ack.status).toBe(200);
      expect(ack.body).toEqual({ ok: true });

      const ackBad = await postJson<{ code?: string }>(base, "/api/orders-ack", {
        orderId: "ack-1",
        quantity: 0,
        totalCents: 5,
      });
      expect(ackBad.status).toBe(422);
      expect(ackBad.body.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("public content journey", () => {
    it("walks root → hello → catalog → page → i18n in one client session", async () => {
      const root = await fetch(`${base}/`);
      expect(root.status).toBe(200);
      expect(await root.text()).toBeTruthy();

      const hello = await fetch(`${base}/hello`);
      expect(hello.status).toBe(200);
      // A plain-string handler is JSON-encoded on the wire.
      expect(await hello.json()).toBe("Hello World");

      const catalog = await fetch(`${base}/catalog`);
      expect(catalog.status).toBe(200);
      expect(await catalog.text()).toContain("data-id=");

      const page = await fetch(`${base}/page?name=Journey`);
      expect(page.status).toBe(200);
      const pageHtml = await page.text();
      expect(pageHtml).toContain("Hello Journey!");
      expect(pageHtml).toContain("<title>Ignex demo</title>");

      const es = await getJson<{ locale?: string; message?: string }>(base, "/i18n?name=Ada", {
        headers: { "accept-language": "es-ES,es;q=0.9" },
      });
      expect(es.status).toBe(200);
      expect(es.body).toMatchObject({ locale: "es", message: "Hola Ada" });

      // Unsupported locales fall back deterministically instead of 500ing.
      const fallback = await getJson<{ locale?: string }>(base, "/i18n?name=Ada", {
        headers: { "accept-language": "zz-ZZ" },
      });
      expect(fallback.status).toBe(200);
      expect(fallback.body.locale).toBe("en");
    });
  });

  describe("observability journey", () => {
    it("always answers liveness", async () => {
      const health = await getJson<{ status?: string }>(base, "/health");
      expect(health.status).toBe(200);
      expect(health.body.status).toBe("ok");
    });

    it("gates readiness on its dependency", async () => {
      const ready = await getJson<{ ok?: boolean }>(base, "/ready");
      if (hasLocalMongo) {
        expect(ready.status).toBe(200);
        expect(ready.body.ok).toBe(true);
      } else {
        // A replica with a dead database must stop receiving traffic: 503, not
        // a 200 that would keep it in the load-balancer rotation.
        expect(ready.status).toBe(503);
        expect(ready.body.ok).toBe(false);
      }
    });
  });

  describe("client error-recovery journey", () => {
    it("recovers from a rejected payload and a 404 without poisoning the connection", async () => {
      // 1. A rejected body…
      const bad = await postJson(base, "/api/orders-ack", {
        orderId: "recover",
        quantity: 0,
        totalCents: 1,
      });
      expect(bad.status).toBe(422);

      // 2. …then a valid one on the SAME route succeeds.
      const ok = await postJson<{ ok?: boolean }>(base, "/api/orders-ack", {
        orderId: "recover",
        quantity: 1,
        totalCents: 1,
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true });

      // 3. An unknown path 404s…
      expect((await getJson(base, "/definitely-not-a-route")).status).toBe(404);

      // 4. …and a known path still answers right after.
      expect((await getJson(base, "/health")).status).toBe(200);
    });
  });

  describe("jwt + session coexistence", () => {
    it("keeps the JWT and the session cookie independent", async () => {
      const username = uniqueName("coexist");
      const reg = await postJson<{ accessToken?: string }>(base, "/auth/register", {
        username,
        password: "coexist-pass-123",
      });
      const token = reg.body.accessToken ?? "";

      const sess = await fetch(`${base}/session`);
      const cookie = (sess.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect(cookie).toContain("sid=");

      // A session cookie does NOT authenticate the JWT-guarded route…
      expect((await getJson(base, "/auth/me", { headers: { cookie } })).status).toBe(401);

      // …the JWT does, independent of the session…
      const me = await getJson<{ user?: { sub?: string } }>(base, "/auth/me", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(200);
      expect(me.body.user?.sub).toBe(username);

      // …and the session still resolves from its own cookie alone.
      const second = await getJson<{ visits?: number }>(base, "/session", { headers: { cookie } });
      expect(second.status).toBe(200);
      expect(second.body.visits).toBe(2);
    });
  });

  describe("cors preflight → actual journey", () => {
    it("preflights a cross-origin POST, then performs it", async () => {
      const preflight = await fetch(`${base}/auth/login`, {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
      expect((preflight.headers.get("access-control-allow-methods") ?? "").toUpperCase()).toContain(
        "POST",
      );

      const actual = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.com" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      });
      expect(actual.status).toBe(200);
      expect(actual.headers.get("access-control-allow-origin")).toBe("*");
      expect(actual.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });

  describe("method negotiation journey", () => {
    it("answers OPTIONS → HEAD → GET → 405 on one path without changing state", async () => {
      const options = await fetch(`${base}/health`, { method: "OPTIONS" });
      expect(options.status).toBe(204);
      expect((options.headers.get("allow") ?? "").toUpperCase()).toContain("GET");

      const head = await fetch(`${base}/health`, { method: "HEAD" });
      expect(head.status).toBe(200);

      const get = await fetch(`${base}/health`);
      expect(get.status).toBe(200);

      const wrong = await fetch(`${base}/health`, { method: "POST", body: "x" });
      expect(wrong.status).toBe(405);
      expect((wrong.headers.get("allow") ?? "").toUpperCase()).toContain("GET");

      // The path still works after the rejected method.
      expect((await fetch(`${base}/health`)).status).toBe(200);
    });
  });

  describe("concurrent mixed flows", () => {
    it("serves every journey concurrently with no cross-request bleed", async () => {
      const reg = await postJson<{ accessToken?: string }>(base, "/auth/register", {
        username: uniqueName("burst"),
        password: "burst-pass-123",
      });
      const token = reg.body.accessToken ?? "";

      const one = (i: number): Promise<Response> => {
        switch (i % 6) {
          case 0:
            return fetch(`${base}/health`);
          case 1:
            return fetch(`${base}/hello`);
          case 2:
            return fetch(`${base}/catalog`);
          case 3:
            return fetch(`${base}/page?name=Burst${i}`);
          case 4:
            return fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
          default:
            return fetch(`${base}/api/search?a=1&b=two&c=3`);
        }
      };

      const responses = await Promise.all(Array.from({ length: 300 }, (_, i) => one(i)));
      const statuses = new Map<number, number>();
      for (const res of responses) {
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        // Drain bodies so sockets return to the pool instead of stalling.
        await res.arrayBuffer();
      }
      expect([...statuses.keys()]).toEqual([200]);
      expect(statuses.get(200)).toBe(300);
    });

    it("assigns a unique request id to every concurrent request", async () => {
      const ids = await Promise.all(
        Array.from({ length: 64 }, () =>
          getJson<{ requestId?: string }>(base, "/env").then((r) => r.body.requestId),
        ),
      );
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe.runIf(hasLocalMongo)("mongo resource journey", () => {
    it("creates, reads, updates and deletes a gig", async () => {
      const name = uniqueName("gig");

      const created = await postJson<{ id?: string }>(base, "/api/gigs", { name });
      expect(created.status).toBe(201);
      const id = created.body.id ?? "";
      expect(id).toMatch(/^[0-9a-fA-F]{24}$/);

      const got = await getJson<{ name?: string }>(base, `/api/gigs/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe(name);

      // A malformed id is rejected by the compiled params validator.
      expect((await getJson(base, "/api/gigs/not-an-object-id")).status).toBe(422);

      const patch = await fetch(`${base}/api/gigs/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `${name}-v2` }),
      });
      expect(patch.status).toBe(200);
      expect((await patch.json()) as { updated?: boolean }).toMatchObject({ updated: true });

      const deleted = await fetch(`${base}/api/gigs/${id}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect((await deleted.json()) as { deleted?: boolean }).toMatchObject({ deleted: true });

      // The resource is really gone.
      expect((await getJson(base, `/api/gigs/${id}`)).status).toBe(404);
    });
  });
});
