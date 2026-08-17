/**
 * RBAC tests: `can`/`hasRole` guards (401 vs 403), permission wildcards,
 * `withGuards` handler wrapper, the `createRbac` plugin, and a full
 * interpreted-runtime flow (auth module → guarded route).
 */
import {
  can,
  canAll,
  createApp,
  createAuthModule,
  createContext,
  createRbac,
  createRouter,
  getPermissions,
  getRoles,
  hasRole,
  permissionMatches,
  setUser,
  withGuards,
} from "@ignex/core";
import { generateEd25519Keypair } from "@ignex/native";
import { describe, expect, it } from "vitest";

const ctx = (req = new Request("http://localhost:3000/")) => createContext(req, {});

/** Seed a user with roles/permissions on the context. */
const authed = (roles?: string[], permissions?: string[]) => {
  const c = ctx();
  setUser(c, { sub: "u1", roles: roles ?? [], permissions: permissions ?? [] });
  return c;
};

describe("permission matching", () => {
  it("matches exact, global wildcard, and namespace wildcards", () => {
    // (pattern, granted) — the wildcard lives on the required pattern.
    expect(permissionMatches("users:read", "users:read")).toBe(true);
    expect(permissionMatches("*", "users:read")).toBe(true);
    expect(permissionMatches("users:*", "users:read")).toBe(true);
    expect(permissionMatches("users:write", "users:read")).toBe(false);
    expect(permissionMatches("orders:*", "users:read")).toBe(false);
    expect(permissionMatches("*", "anything")).toBe(true);
  });
});

describe("hasRole", () => {
  it("allows a matching role", async () => {
    const r = await hasRole("admin")(authed(["admin"], []));
    expect(r.ok).toBe(true);
  });

  it("allows any of the listed roles", async () => {
    const r = await hasRole("admin", "editor")(authed(["editor"], []));
    expect(r.ok).toBe(true);
  });

  it("forbids a missing role with 403", async () => {
    const r = await hasRole("admin")(authed(["viewer"], []));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    const r = await hasRole("admin")(ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });
});

describe("can / canAll", () => {
  it("allows any matching permission (any-of)", async () => {
    const r = await can("users:read", "users:write")(authed([], ["users:write"]));
    expect(r.ok).toBe(true);
  });

  it("allows a namespace wildcard permission", async () => {
    const r = await can("users:read")(authed([], ["users:*"]));
    expect(r.ok).toBe(true);
  });

  it("forbids with 403 when lacking the permission", async () => {
    const r = await can("users:read")(authed([], ["orders:read"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("canAll requires every permission", async () => {
    const ok = await canAll("a:r", "b:r")(authed([], ["a:r", "b:r"]));
    expect(ok.ok).toBe(true);
    const missing = await canAll("a:r", "b:r")(authed([], ["a:r"]));
    expect(missing.ok).toBe(false);
  });
});

describe("withGuards", () => {
  const handler = (c: ReturnType<typeof ctx>) => c.json({ ok: true });

  it("runs the handler when guards pass", async () => {
    const guarded = withGuards(handler, { roles: ["admin"], permissions: ["users:read"] });
    const res = await guarded(authed(["admin"], ["users:read"]));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(200);
  });

  it("forbids a user lacking the permission", async () => {
    const guarded = withGuards(handler, { permissions: ["users:read"] });
    const res = (await guarded(authed([], ["orders:read"]))) as Response;
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const guarded = withGuards(handler, { permissions: ["users:read"] });
    const res = (await guarded(ctx())) as Response;
    expect(res.status).toBe(401);
  });

  it("with no guards, requires authentication only", async () => {
    const guarded = withGuards(handler);
    expect(((await guarded(authed([], []))) as Response).status).toBe(200);
    expect(((await guarded(ctx())) as Response).status).toBe(401);
  });
});

describe("createRbac plugin", () => {
  it("normalizes user claims onto ctx.state roles/permissions", async () => {
    const plugin = createRbac();
    const c = authed(["admin"], ["users:read"]);
    const result = plugin.onRequest?.(c);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      await result;
    }
    expect(getRoles(c)).toEqual(["admin"]);
    expect(getPermissions(c)).toEqual(["users:read"]);
  });

  it("resolves a custom loadUser when the auth module is not used", async () => {
    const plugin = createRbac({
      loadUser: async () => ({ sub: "x", roles: ["svc"], permissions: ["svc:call"] }),
    });
    const c = ctx();
    const result = plugin.onRequest?.(c);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      await result;
    }
    expect(getRoles(c)).toEqual(["svc"]);
    expect(getPermissions(c)).toEqual(["svc:call"]);
  });
});

describe("integration — auth module + guarded route (interpreted)", () => {
  it("login → protected route returns 200/401/403 correctly", async () => {
    const pair = generateEd25519Keypair();
    process.env.RBAC_PRIV = pair.privateKey;
    process.env.RBAC_PUB = pair.publicKey;
    const auth = createAuthModule({
      mode: "both",
      privateKeyEnv: "RBAC_PRIV",
      publicKeyEnv: "RBAC_PUB",
      rolePermissions: { admin: ["users:read"] },
    });

    const router = createRouter().get(
      "/admin",
      withGuards((c) => c.json({ admin: true }), { permissions: ["users:read"] }),
    );

    const app = createApp({ router, plugins: [auth.plugin(), createRbac()] });
    await app.init();

    // No token → 401.
    const anon = await app.handler(new Request("http://localhost:3000/admin"));
    expect(anon.status).toBe(401);

    // Token without the permission → 403.
    const noPerm = await auth.issueToken({ id: "u1" }, { roles: ["viewer"] });
    const denied = await app.handler(
      new Request("http://localhost:3000/admin", {
        headers: { authorization: `Bearer ${noPerm}` },
      }),
    );
    expect(denied.status).toBe(403);

    // Token with the admin role (expanded to users:read) → 200.
    const token = await auth.issueToken({ id: "u1" }, { roles: ["admin"] });
    const allowed = await app.handler(
      new Request("http://localhost:3000/admin", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ admin: true });

    delete process.env.RBAC_PRIV;
    delete process.env.RBAC_PUB;
  });
});
