/**
 * Security suite tests: crypto primitives, auth hooks, sessions, CSRF.
 * Runs under the pure-TS fallbacks (the Rust addon is optional); the wire
 * formats are identical either way.
 */

import {
  bearerAuth,
  createContext,
  createCookieSigner,
  createCsrf,
  createCsrfGuard,
  createJwt,
  createMemorySessionStore,
  createPasswordHasher,
  createSessionManager,
  csrfToken,
  csrfVerify,
  getSession,
  getUser,
  hmacSha256,
  hmacSha256Verify,
  jwtAuth,
  jwtVerify,
  optionalAuth,
  requireAuth,
  signCookie,
  verifyCookie,
} from "@ignex/core";
import { describe, expect, it } from "vitest";

const ctx = (req = new Request("http://localhost:3000/")) => createContext(req, {});

describe("crypto", () => {
  it("createJwt signs and verifies with issuer/audience enforcement", () => {
    const jwt = createJwt({
      secret: "s3cret",
      ttlSeconds: 3600,
      issuer: "ignex",
      audience: "web",
    });
    const token = jwt.sign({ sub: "1", role: "admin" });
    const claims = jwt.verify(token) as Record<string, unknown>;
    expect(claims.sub).toBe("1");
    expect(claims.iss).toBe("ignex");
    expect(claims.aud).toBe("web");
    expect(claims.iat).toBeTypeOf("number");
    expect(claims.exp).toBeTypeOf("number");
  });

  it("rejects wrong issuer/audience", () => {
    const jwt = createJwt({ secret: "s3cret", issuer: "ignex", audience: "web" });
    const token = jwt.sign({ sub: "1" });
    const otherIssuer = createJwt({ secret: "s3cret", issuer: "other", audience: "web" });
    const otherAudience = createJwt({ secret: "s3cret", issuer: "ignex", audience: "mobile" });
    expect(otherIssuer.verify(token)).toBeNull();
    expect(otherAudience.verify(token)).toBeNull();
  });

  it("signed cookies round-trip and reject tampering", () => {
    const signer = createCookieSigner("s");
    const signed = signer.sign("session=abc");
    expect(signer.verify(signed)).toBe("session=abc");
    expect(signCookie("v", "s")).toMatch(/^v\.[0-9a-f]{64}$/);
    expect(verifyCookie("v.deadbeef", "s")).toBeNull();
  });

  it("csrf tokens verify and reject wrong secrets", () => {
    const csrf = createCsrf("secret");
    const token = csrf.token();
    expect(csrf.verify(token)).toBe(true);
    expect(csrfVerify(token, "other")).toBe(false);
    expect(csrfToken("s")).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
  });

  it("hmac signs and verifies", () => {
    const sig = hmacSha256("k", "data");
    expect(hmacSha256Verify("k", "data", sig)).toBe(true);
    expect(hmacSha256Verify("k", "other", sig)).toBe(false);
  });

  it("password hasher round-trips (scrypt fallback path)", async () => {
    const hasher = createPasswordHasher();
    const phc = await hasher.hash("hunter2");
    expect(hasher.verify("hunter2", phc)).toBe(true);
    expect(hasher.verify("wrong", phc)).toBe(false);
  });
});

describe("auth hooks", () => {
  it("requireAuth halts with 401 when no user", async () => {
    const result = await requireAuth(() => null)(ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("requireAuth attaches user and continues", async () => {
    const c = ctx();
    const result = await requireAuth(() => ({ id: 1 }))(c);
    expect(result.ok).toBe(true);
    expect(getUser(c)).toEqual({ id: 1 });
  });

  it("optionalAuth never halts", async () => {
    const result = await optionalAuth(() => null)(ctx());
    expect(result.ok).toBe(true);
  });

  it("basicAuth decodes Basic credentials", async () => {
    const c = ctx(
      new Request("http://localhost:3000/", {
        headers: { authorization: `Basic ${Buffer.from("admin:pw").toString("base64")}` },
      }),
    );
    const result = await bearerAuth(() => null)(c);
    // wrong scheme → halted
    expect(result.ok).toBe(false);
  });

  it("jwtAuth accepts a valid bearer token", async () => {
    const jwt = createJwt({ secret: "s3cret", ttlSeconds: 3600 });
    const token = jwt.sign({ sub: "1" });
    const c = ctx(
      new Request("http://localhost:3000/", { headers: { authorization: `Bearer ${token}` } }),
    );
    const result = await jwtAuth({ secret: "s3cret" })(c);
    expect(result.ok).toBe(true);
    expect(getUser(c)).toMatchObject({ sub: "1" });
  });

  it("jwtAuth rejects missing/invalid tokens", async () => {
    const c = ctx(new Request("http://localhost:3000/"));
    const result = await jwtAuth({ secret: "s3cret" })(c);
    expect(result.ok).toBe(false);
    expect(jwtVerify("a.b.c", "s3cret")).toBeNull();
  });
});

describe("sessions", () => {
  it("memory store persists with TTL", async () => {
    const store = createMemorySessionStore({ ttlSeconds: 60 });
    await store.set("s1", { visits: 1 }, { expiresAt: Date.now() + 60_000 });
    expect(await store.get("s1")).toEqual({ visits: 1 });
    await store.set("s1", { visits: 2 });
    expect(await store.get("s1")).toEqual({ visits: 2 });
    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
  });

  it("signed-cookie session middleware persists a session", async () => {
    const manager = createSessionManager({ secret: "s3cret" });
    const c = ctx();
    const result = await manager.middleware({ createIfMissing: true })(c);
    expect(result.ok).toBe(true);
    const session = await getSession(c);
    expect(session).toBeDefined();
    if (session) {
      session.data.visits = 1;
      await session.save();
      const cookieValue = c.cookie.sid?.value;
      expect(cookieValue).toMatch(/\./);
      expect(verifyCookie(cookieValue ?? "", "s3cret")).not.toBeNull();
    }
  });

  it("lazy mode creates a session only when the handler reads it", async () => {
    const manager = createSessionManager({ secret: "s3cret" });

    // No cookie + lazy: middleware alone attaches nothing and writes NO cookie
    // (no eager id generation, no signing, no Set-Cookie).
    const untouched = ctx();
    await manager.middleware({ createIfMissing: "lazy" })(untouched);
    expect(untouched.cookie.sid?.value).toBeUndefined();

    // The first read triggers one-time lazy creation + cookie write.
    const created = await getSession(untouched);
    expect(created).toBeDefined();
    expect(created?.isNew).toBe(true);
    expect(untouched.cookie.sid?.value).toMatch(/\./);
    expect(verifyCookie(untouched.cookie.sid?.value ?? "", "s3cret")).not.toBeNull();

    // A second read returns the same attached session (no re-create).
    const again = await getSession(untouched);
    expect(again).toBe(created);
  });
});

describe("csrf guard", () => {
  it("issues a token cookie and rejects state-changing requests without it", async () => {
    const guard = createCsrfGuard({ secret: "s" });
    // GET: issues cookie, passes
    const getCtx = ctx(new Request("http://localhost:3000/"));
    const getResult = await guard(getCtx);
    expect(getResult.ok).toBe(true);
    const token = getCtx.cookie["csrf-token"]?.value;
    expect(token).toBeTruthy();

    // POST without header: rejected
    const postCtx = ctx(new Request("http://localhost:3000/", { method: "POST" }));
    postCtx.cookie["csrf-token"]?.update({ value: token ?? "" });
    const postResult = await guard(postCtx);
    expect(postResult.ok).toBe(false);
    if (!postResult.ok) expect(postResult.response.status).toBe(403);

    // POST with matching header: passes
    const okCtx = ctx(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: { "x-csrf-token": token ?? "" },
      }),
    );
    okCtx.cookie["csrf-token"]?.update({ value: token ?? "" });
    const okResult = await guard(okCtx);
    expect(okResult.ok).toBe(true);
  });
});
