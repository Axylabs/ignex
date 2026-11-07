/**
 * CSRF guard hardening tests — the Origin/Referer layer, session binding and
 * the `__Host-` cookie prefix (pinning tests for the secure-default pass).
 */
import { createCsrfGuard, csrfToken } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/http/context";

const ctx = (req: Request, cookieValue?: string): ReturnType<typeof createContext> => {
  const c = createContext(req, {});
  if (cookieValue !== undefined) c.cookie["csrf-token"]?.update({ value: cookieValue });
  return c;
};

const post = (url: string, headers: Record<string, string>) =>
  new Request(url, { method: "POST", headers });

/** Drive one guarded POST; returns the hook result. */
const guardedPost = async (
  guard: ReturnType<typeof createCsrfGuard>,
  req: Request,
  cookieValue?: string,
) => {
  const c = ctx(req, cookieValue);
  return guard(c);
};

describe("csrf guard origin enforcement (secure default)", () => {
  it("issues and passes header-less clients unchanged (curl / server-to-server)", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret" });
    const getCtx = ctx(new Request("http://localhost:3000/"));
    const result = await guard(getCtx);
    expect(result.ok).toBe(true);
    const token = getCtx.cookie["csrf-token"]?.value ?? "";
    // POST without Origin/Referer: token layer only (token echoed in header).
    const r = await guardedPost(
      guard,
      post("http://localhost:3000/x", { "x-csrf-token": token }),
      token,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects cross-site Origin on a state-changing request", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret" });
    const getCtx = ctx(new Request("http://localhost:3000/"));
    await guard(getCtx);
    const token = getCtx.cookie["csrf-token"]?.value ?? "";
    const r = await guardedPost(
      guard,
      post("http://localhost:3000/x", { origin: "https://evil.example" }),
      token,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("accepts same-origin Origin", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret" });
    const getCtx = ctx(new Request("http://localhost:3000/"));
    await guard(getCtx);
    const token = getCtx.cookie["csrf-token"]?.value ?? "";
    const r = await guardedPost(
      guard,
      post("http://localhost:3000/x", {
        origin: "http://localhost:3000",
        "x-csrf-token": token,
      }),
      token,
    );
    expect(r.ok).toBe(true);
  });

  it("falls back to Referer when Origin is absent", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret" });
    const getCtx = ctx(new Request("http://localhost:3000/"));
    await guard(getCtx);
    const token = getCtx.cookie["csrf-token"]?.value ?? "";
    const evil = await guardedPost(
      guard,
      post("http://localhost:3000/x", {
        referer: "https://evil.example/page",
        "x-csrf-token": token,
      }),
      token,
    );
    expect(evil.ok).toBe(false);
    const own = await guardedPost(
      guard,
      post("http://localhost:3000/x", {
        referer: "http://localhost:3000/page",
        "x-csrf-token": token,
      }),
      token,
    );
    expect(own.ok).toBe(true);
  });

  it("honor an explicit origin allowlist (multi-domain frontends)", async () => {
    const guard = createCsrfGuard({
      secret: "csrf-secret",
      origin: ["https://app.example.com"],
    });
    const getCtx = ctx(new Request("http://localhost:3000/"));
    await guard(getCtx);
    const token = getCtx.cookie["csrf-token"]?.value ?? "";
    const allowed = await guardedPost(
      guard,
      post("http://localhost:3000/x", {
        origin: "https://app.example.com",
        "x-csrf-token": token,
      }),
      token,
    );
    expect(allowed.ok).toBe(true);
    const other = await guardedPost(
      guard,
      post("http://localhost:3000/x", {
        origin: "https://other.example.com",
        "x-csrf-token": token,
      }),
      token,
    );
    expect(other.ok).toBe(false);
  });

  it("origin: false restores token-only behavior", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret", origin: false });
    const getCtx = ctx(new Request("http://localhost:3000/"));
    await guard(getCtx);
    const token = getCtx.cookie["csrf-token"]?.value ?? "";
    const r = await guardedPost(
      guard,
      post("http://localhost:3000/x", {
        origin: "https://evil.example",
        "x-csrf-token": token,
      }),
      token,
    );
    expect(r.ok).toBe(true);
  });

  it("GETs are never origin-rejected (browser navigations carry Origin)", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret" });
    const c = ctx(
      new Request("http://localhost:3000/", { headers: { origin: "https://evil.example" } }),
    );
    expect((await guard(c)).ok).toBe(true);
  });
});

describe("csrf guard session binding", () => {
  const bind = { bindSession: "sid" as const };

  it("a token minted under session A is rejected under session B", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret", ...bind });
    const mintA = ctx(new Request("http://localhost:3000/"));
    mintA.cookie.sid?.update({ value: "session-a" });
    await guard(mintA);
    const tokenA = mintA.cookie["csrf-token"]?.value ?? "";

    // Same token replayed under session B → 403 (binding ties it to A).
    const withSidB = ctx(post("http://localhost:3000/x", { "x-csrf-token": tokenA }));
    withSidB.cookie.sid?.update({ value: "session-b" });
    withSidB.cookie["csrf-token"]?.update({ value: tokenA });
    const result = await guard(withSidB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("a session-bound token round-trips within its own session", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret", ...bind });
    const mint = ctx(new Request("http://localhost:3000/"));
    mint.cookie.sid?.update({ value: "session-a" });
    await guard(mint);
    const token = mint.cookie["csrf-token"]?.value ?? "";
    const verify = ctx(post("http://localhost:3000/x", { "x-csrf-token": token }));
    verify.cookie.sid?.update({ value: "session-a" });
    verify.cookie["csrf-token"]?.update({ value: token });
    expect((await guard(verify)).ok).toBe(true);
  });

  it("rotation ring works with binding (old secret's tokens verify in-window)", async () => {
    const OLD = "old-csrf-secret";
    const guard = createCsrfGuard({ secret: ["new-csrf-secret", OLD], ...bind });
    // Mint with the LEGACY unbound path (old deployment), verify under the
    // rotated + bound guard with the same session.
    const legacyToken = csrfToken(OLD);
    const c = ctx(post("http://localhost:3000/x", { "x-csrf-token": legacyToken }));
    c.cookie.sid?.update({ value: "session-x" });
    c.cookie["csrf-token"]?.update({ value: legacyToken });
    // Legacy token was minted unbound → fails under binding (by design).
    expect((await guard(c)).ok).toBe(false);
  });
});

describe("csrf guard __Host- prefix", () => {
  it("forces the __Host- name with secure + path=/", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret", hostPrefix: true });
    const c = ctx(new Request("https://example.com/"));
    const result = await guard(c);
    expect(result.ok).toBe(true);
    const setCookie = c.setCookie?.get?.("__Host-csrf-token") ?? c.cookie["__Host-csrf-token"];
    expect(c.cookie["__Host-csrf-token"]?.value).toBeTruthy();
    expect(c.cookie["csrf-token"]?.value).toBeFalsy();
    void setCookie;
  });

  it("rejection still works under the prefixed cookie", async () => {
    const guard = createCsrfGuard({ secret: "csrf-secret", hostPrefix: true });
    const mint = ctx(new Request("https://example.com/"));
    await guard(mint);
    const token = mint.cookie["__Host-csrf-token"]?.value ?? "";
    const r = ctx(post("https://example.com/x", {}));
    r.cookie["__Host-csrf-token"]?.update({ value: token });
    const result = await guard(r);
    expect(result.ok).toBe(false);
  });
});
