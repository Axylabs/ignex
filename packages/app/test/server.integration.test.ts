/**
 * Generated-server integration tests.
 *
 * Boots the AOT-compiled server (`dist/__server.js`) on an ephemeral port and
 * exercises the core routes end-to-end. Uses the shared {@link bootServer}
 * harness (compile-if-missing + spawn + readiness poll) so every integration
 * suite boots the same way.
 */

import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer } from "./helpers/boot";

const APP_DIR = new URL("../", import.meta.url).pathname;

/**
 * The reference app (packages/app) imports the external `@ignex/ninox`
 * MongoDB toolkit (`bun link`-ed from the sibling ignex-mongodb repo in full
 * local-dev setups, or resolved from the registry otherwise). When the
 * package — or a live MongoDB the app's `dbPlugin` connects to at boot — is
 * unavailable, skip this suite so a standalone monorepo checkout verifies
 * cleanly.
 */
const hasNinox = (() => {
  try {
    createRequire(import.meta.url).resolve("@ignex/ninox");
    return true;
  } catch {
    return false;
  }
})();

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

describe.runIf(hasNinox && hasLocalMongo)("generated server (integration)", () => {
  let BASE = "";
  let srv: BootedServer;

  beforeAll(async () => {
    // The app is AOT-compiled in its production shape (builder.ts), which never
    // auto-generates dev certs — so boot over plain HTTP and poll http://.
    // Allow well beyond the harness's readiness window — under full-suite
    // parallelism a cold boot (Mongo connect + compile-if-needed) can be slow.
    srv = await bootServer(APP_DIR, {
      protocol: "http",
      env: { IGNEX_HTTPS: "0" },
    });
    BASE = srv.base;
  }, 60_000);

  afterAll(() => srv?.close());
  it("serves GET /health with a JSON body", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });

  it("serves GET /hello (named-export handler)", async () => {
    const res = await fetch(`${BASE}/hello`);
    expect(res.status).toBe(200);
  });

  it("serves GET /products/:id with a dynamic param", async () => {
    const res = await fetch(`${BASE}/products/42`);
    expect(res.status).toBe(200);
  });

  it("404s unknown routes", async () => {
    const res = await fetch(`${BASE}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("405s a method not allowed on an existing path", async () => {
    const res = await fetch(`${BASE}/health`, { method: "POST", body: "x" });
    expect(res.status).toBe(405);
  });

  it("parses a JSON POST body (auth login)", async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
    };
    expect(typeof body.accessToken).toBe("string");
    expect((body.accessToken ?? "").split(".")).toHaveLength(3);
    expect(typeof body.refreshToken).toBe("string");
    expect(body.expiresIn).toBe(900);
  });

  it("returns 401 for invalid credentials", async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns a JSON error envelope for a malformed JSON body", async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  it("protects a JWT-gated route (401 without a token)", async () => {
    const res = await fetch(`${BASE}/auth/me`);
    expect(res.status).toBe(401);
  });

  it("authenticates a Bearer token through the compiled server", async () => {
    const login = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };

    const res = await fetch(`${BASE}/auth/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { sub?: string; roles?: string[] } };
    expect(body.user?.sub).toBe("admin");
    expect(body.user?.roles).toContain("admin");
  });

  it("sets a session cookie via the session plugin", async () => {
    const res = await fetch(`${BASE}/session`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sid=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("persists a session across requests using the cookie", async () => {
    const first = await fetch(`${BASE}/session`);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const second = await fetch(`${BASE}/session`, { headers: { cookie } });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { visits?: number };
    expect(body.visits).toBeGreaterThan(1);
  });

  it("serves i18n and jobs routes", async () => {
    const i18n = await fetch(`${BASE}/i18n?lang=es`);
    expect(i18n.status).toBe(200);
    const jobs = await fetch(`${BASE}/jobs`);
    expect(jobs.status).toBe(200);
  });

  it("applies security headers", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("answers a CORS preflight", async () => {
    const res = await fetch(`${BASE}/health`, {
      method: "OPTIONS",
      headers: { origin: "http://example.com", "access-control-request-method": "GET" },
    });
    expect(res.status).toBe(204);
    // Native castrum CORS owns preflight and echoes the allowed origin.
    expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com");
  });

  it("compresses a large response with gzip", async () => {
    const res = await fetch(`${BASE}/openapi.json`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("serves the OpenAPI docs UI at /openapi", async () => {
    const res = await fetch(`${BASE}/openapi`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("api-reference");
  });

  it("serves a constant (zero-runtime) route", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBeTruthy();
  });
});
