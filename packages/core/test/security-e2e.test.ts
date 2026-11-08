/**
 * @fileoverview Routed security E2E regressions. Every request traverses the
 * real context, plugin lifecycle, router, response finalization, and error
 * boundary; no request-scoped value is replaced with a mock.
 */

import {
  bearerAuthPlugin,
  cors,
  createApp,
  createRouter,
  csrf,
  getSession,
  getUser,
  security,
  session,
} from "@ignex/core";
import { describe, expect, it, vi } from "vitest";

const request = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, init);

const cookiePair = (response: Response): string => {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (value === undefined) throw new Error("Expected a Set-Cookie response header");
  return value;
};

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe("security E2E — request isolation", () => {
  it("keeps state, identity, query, headers, and cookies separate under concurrency", async () => {
    const router = createRouter().get("/isolation/:tenant", async (ctx) => {
      ctx.setState("tenant", ctx.params.tenant);
      ctx.set.headers["x-tenant"] = ctx.params.tenant;
      ctx.set.headers["x-request-id"] = ctx.requestId;
      ctx.cookie.reply?.update({
        value: ctx.params.tenant,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
      await pause();
      return ctx.json({
        tenant: ctx.getState("tenant"),
        param: ctx.params.tenant,
        clientCookie: ctx.cookie.client?.value,
        marker: ctx.query.get("marker"),
        requestId: ctx.requestId,
      });
    });
    const app = createApp({ router });
    const tenants = Array.from({ length: 40 }, (_, index) => `tenant-${index}`);

    const responses = await Promise.all(
      tenants.map(async (tenant) => ({
        tenant,
        response: await app.handler(
          request(`/isolation/${tenant}?marker=${tenant}`, {
            headers: { cookie: `client=${tenant}` },
          }),
        ),
      })),
    );

    const requestIds = new Set<string>();
    for (const { tenant, response } of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("x-tenant")).toBe(tenant);
      expect(response.headers.get("set-cookie")).toContain(`reply=${tenant}`);
      const requestId = response.headers.get("x-request-id");
      expect(requestId).toBeTruthy();
      if (requestId !== null) requestIds.add(requestId);
      await expect(response.json()).resolves.toEqual({
        tenant,
        param: tenant,
        clientCookie: tenant,
        marker: tenant,
        requestId,
      });
    }
    expect(requestIds.size).toBe(tenants.length);
  });

  it("never shares authenticated users between overlapping requests", async () => {
    const router = createRouter().get("/me", async (ctx) => {
      await pause();
      return ctx.json({ user: getUser(ctx) });
    });
    const app = createApp({
      router,
      plugins: [bearerAuthPlugin((token) => ({ id: token }))],
    });

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        app.handler(request("/me", { headers: { authorization: `Bearer user-${index}` } })),
      ),
    );
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ user: { id: `user-${index}` } });
    }
  });

  it("does not serve one credential holder's cached response to another", async () => {
    const router = createRouter().get("/private", (ctx) =>
      ctx.cache(async () =>
        ctx.json({
          authorization: ctx.headers.get("authorization"),
          cookie: ctx.headers.get("cookie"),
        }),
      ),
    );
    const app = createApp({ router });

    const first = await app.handler(
      request("/private", { headers: { authorization: "Bearer alice" } }),
    );
    const second = await app.handler(
      request("/private", { headers: { authorization: "Bearer bob" } }),
    );
    const cookieResponse = await app.handler(
      request("/private", { headers: { cookie: "sid=carol" } }),
    );

    await expect(first.json()).resolves.toEqual({
      authorization: "Bearer alice",
      cookie: null,
    });
    await expect(second.json()).resolves.toEqual({
      authorization: "Bearer bob",
      cookie: null,
    });
    await expect(cookieResponse.json()).resolves.toEqual({
      authorization: null,
      cookie: "sid=carol",
    });
    for (const response of [first, second, cookieResponse]) {
      expect(response.headers.get("x-cache")).toBeNull();
    }
  });
});

describe("security E2E — session and browser boundaries", () => {
  it("keeps persistent session data isolated between clients", async () => {
    const router = createRouter()
      .post("/login", async (ctx) => {
        const current = await getSession(ctx);
        if (current === undefined) throw new Error("Lazy session was not created");
        const body = await ctx.body.json<{ tenant: string }>();
        current.data.tenant = body.tenant;
        await current.save();
        return ctx.json({ ok: true });
      })
      .get("/profile", async (ctx) => {
        const current = await getSession(ctx);
        return ctx.json({ tenant: current?.data.tenant ?? null });
      });
    const app = createApp({
      router,
      plugins: [
        session({
          secret: "e2e-session-secret-with-enough-entropy",
          createIfMissing: "lazy",
        }),
      ],
    });

    const login = async (tenant: string): Promise<string> => {
      const response = await app.handler(
        request("/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenant }),
        }),
      );
      expect(response.status).toBe(200);
      return cookiePair(response);
    };
    const [aliceCookie, bobCookie] = await Promise.all([login("alice"), login("bob")]);
    expect(aliceCookie).not.toBe(bobCookie);

    const [alice, bob, anonymous] = await Promise.all([
      app.handler(request("/profile", { headers: { cookie: aliceCookie } })),
      app.handler(request("/profile", { headers: { cookie: bobCookie } })),
      app.handler(request("/profile")),
    ]);
    await expect(alice.json()).resolves.toEqual({ tenant: "alice" });
    await expect(bob.json()).resolves.toEqual({ tenant: "bob" });
    await expect(anonymous.json()).resolves.toEqual({ tenant: null });
  });

  it("enforces CSRF token and origin checks on state-changing requests", async () => {
    const router = createRouter()
      .get("/form", (ctx) => ctx.json({ ok: true }))
      .post("/transfer", (ctx) => ctx.json({ ok: true }));
    const app = createApp({
      router,
      plugins: [csrf({ secret: "e2e-csrf-secret" }), security()],
    });

    const form = await app.handler(request("/form"));
    const csrfCookie = cookiePair(form);
    const token = csrfCookie.slice(csrfCookie.indexOf("=") + 1);

    const missing = await app.handler(
      request("/transfer", { method: "POST", headers: { cookie: csrfCookie } }),
    );
    const crossOrigin = await app.handler(
      request("/transfer", {
        method: "POST",
        headers: {
          cookie: csrfCookie,
          origin: "https://attacker.example",
          "x-csrf-token": token,
        },
      }),
    );
    const valid = await app.handler(
      request("/transfer", {
        method: "POST",
        headers: {
          cookie: csrfCookie,
          origin: "http://localhost:3000",
          "x-csrf-token": token,
        },
      }),
    );

    expect(missing.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(valid.status).toBe(200);
    for (const response of [missing, crossOrigin]) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    }
  });

  it("does not reflect disallowed CORS origins or allow wildcard credentials", async () => {
    const app = createApp({
      plugins: [cors({ origin: ["https://app.example"], credentials: true })],
      handler: () => new Response("ok"),
    });
    const allowed = await app.handler(request("/", { headers: { origin: "https://app.example" } }));
    const denied = await app.handler(
      request("/", { headers: { origin: "https://attacker.example" } }),
    );

    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
    expect(() => cors({ origin: "*", credentials: true })).toThrow(/cannot be used/);
  });
});

describe("security E2E — disclosure and injection boundaries", () => {
  it("masks internal errors and still emits security headers on errors and 404s", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = createRouter().get("/failure", () => {
      throw new Error("postgres://user:super-secret-password@database.internal/prod");
    });
    const app = createApp({ router, plugins: [security()] });

    const failure = await app.handler(request("/failure"));
    const missing = await app.handler(request("/missing"));
    const body = await failure.text();

    expect(failure.status).toBe(500);
    expect(body).not.toContain("super-secret-password");
    expect(body).not.toContain("database.internal");
    expect(JSON.parse(body)).toEqual({
      error: "Internal Server Error",
      status: 500,
      code: "INTERNAL_ERROR",
    });
    for (const response of [failure, missing]) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
    errorSpy.mockRestore();
  });

  it("turns malformed JSON into a bounded client error without parser details", async () => {
    const app = createApp({
      router: createRouter().post("/json", async (ctx) => ctx.json(await ctx.body.json())),
    });
    const response = await app.handler(
      request("/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"broken":',
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain("Unexpected");
    expect(body).not.toContain("at JSON");
  });

  it("rejects unsafe redirect schemes and protocol-relative targets", async () => {
    const app = createApp({
      router: createRouter().get("/redirect", (ctx) => ctx.redirect(ctx.query.get("next") ?? "/")),
    });

    for (const target of ["javascript:alert(1)", "data:text/html,secret", "//attacker.example"]) {
      const response = await app.handler(request(`/redirect?next=${encodeURIComponent(target)}`));
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      await expect(response.text()).resolves.not.toContain(target);
    }
    const safe = await app.handler(request("/redirect?next=%2Faccount"));
    expect(safe.status).toBe(302);
    expect(safe.headers.get("location")).toBe("/account");
  });
});
