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
  requireAuthenticated,
  runHooks,
  setUser,
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

describe("guard boilerplate (app template)", () => {
  // The APP's withGuards template: composes the generic primitives into a
  // route-local `before` chain attached to `handler.config`. The framework
  // ships no withGuards — this is the boilerplate users own and extend.
  const withGuards = <H extends (...args: never[]) => unknown>(
    handler: H,
    guards: {
      roles?: string[];
      permissions?: string[];
      all?: boolean;
      authenticated?: boolean;
    } = {},
  ): H => {
    const before = [];
    if (guards.authenticated !== false) before.push(requireAuthenticated);
    if (guards.roles?.length) before.push(hasRole(...guards.roles));
    if (guards.permissions?.length) {
      before.push(guards.all ? canAll(...guards.permissions) : can(...guards.permissions));
    }
    (handler as unknown as { config?: unknown }).config = { before };
    return handler;
  };
  const runGuards = async (handler: (...args: never[]) => unknown, c: ReturnType<typeof ctx>) => {
    const before =
      (handler as unknown as { config?: { before: readonly unknown[] } }).config?.before ?? [];
    const r = await runHooks(before as never[], c);
    return r.response ?? handler(c as never);
  };

  it("runs the handler when guards pass", async () => {
    const guarded = withGuards((c: ReturnType<typeof ctx>) => c.json({ ok: true }), {
      roles: ["admin"],
      permissions: ["users:read"],
    });
    const res = (await runGuards(guarded, authed(["admin"], ["users:read"]))) as Response;
    expect(res.status).toBe(200);
  });

  it("forbids a user lacking the permission", async () => {
    const guarded = withGuards((c: ReturnType<typeof ctx>) => c.json({ ok: true }), {
      permissions: ["users:read"],
    });
    const res = (await runGuards(guarded, authed([], ["orders:read"]))) as Response;
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const guarded = withGuards((c: ReturnType<typeof ctx>) => c.json({ ok: true }), {
      permissions: ["users:read"],
    });
    const res = (await runGuards(guarded, ctx())) as Response;
    expect(res.status).toBe(401);
  });

  it("with no guards, requires authentication only", async () => {
    const guarded = withGuards((c: ReturnType<typeof ctx>) => c.json({ ok: true }));
    expect(((await runGuards(guarded, authed([], []))) as Response).status).toBe(200);
    expect(((await runGuards(guarded, ctx())) as Response).status).toBe(401);
  });
});

describe("route-local before/after hooks (interpreted router)", () => {
  it("chains before hooks (guard halt) and after hooks (audit) around the handler", async () => {
    const seen: string[] = [];
    const handler = () => {
      seen.push("handler");
      return new Response("ok", { status: 200 });
    };
    const beforeA = (c: ReturnType<typeof ctx>) => {
      seen.push("beforeA");
      return { ok: true as const, ctx: c };
    };
    const beforeB = (c: ReturnType<typeof ctx>) => {
      seen.push("beforeB");
      return { ok: true as const, ctx: c };
    };
    const after = (_c: ReturnType<typeof ctx>, response: Response) => {
      seen.push(`after:${response.status}`);
    };

    const router = createRouter().get("/demo", handler, undefined, {
      before: [beforeA, beforeB],
      after: [after],
    });
    const app = createApp({ router });
    await app.init();
    const res = await app.handler(new Request("http://localhost:3000/demo"));
    expect(res.status).toBe(200);
    expect(seen).toEqual(["beforeA", "beforeB", "handler", "after:200"]);
  });

  it("a before hook can halt the chain with its own response", async () => {
    const guard = () => ({ ok: false as const, response: new Response("denied", { status: 403 }) });
    const router = createRouter().get(
      "/admin",
      () => new Response("secret", { status: 200 }),
      undefined,
      { before: [guard] },
    );
    const app = createApp({ router });
    await app.init();
    const res = await app.handler(new Request("http://localhost:3000/admin"));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("denied");
  });

  it("an after hook can replace the response", async () => {
    const after = () => ({ response: new Response("wrapped", { status: 201 }) });
    const router = createRouter().get(
      "/x",
      () => new Response("inner", { status: 200 }),
      undefined,
      { after: [after] },
    );
    const app = createApp({ router });
    await app.init();
    const res = await app.handler(new Request("http://localhost:3000/x"));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("wrapped");
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

    // The app's guard boilerplate: a wrapped handler carrying config.before.
    const guardBefore = [requireAuthenticated, can("users:read")];
    const router = createRouter().get("/admin", (c) => c.json({ admin: true }), undefined, {
      before: guardBefore,
    });

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

describe("route DSL: before/after declared in the schema object", () => {
  it("chains guards + after hooks via the route's before/after schema keys", async () => {
    const seen: string[] = [];
    const app = createApp({
      router: createRouter().get(
        "/demo",
        () => {
          seen.push("handler");
          return new Response("ok", { status: 200 });
        },
        {
          before: [
            () => {
              seen.push("guard1");
              return { ok: true as const, ctx: createContext(new Request("http://x/")) };
            },
            () => {
              seen.push("guard2");
              return { ok: true as const, ctx: createContext(new Request("http://x/")) };
            },
          ],
          after: [
            (_c, response) => {
              seen.push(`after:${response.status}`);
            },
          ],
        },
      ),
    });
    await app.init();
    const res = await app.handler(new Request("http://localhost:3000/demo"));
    expect(res.status).toBe(200);
    expect(seen).toEqual(["guard1", "guard2", "handler", "after:200"]);
  });

  it("a before guard declared in the schema can halt with 403", async () => {
    const app = createApp({
      router: createRouter().get("/admin", () => new Response("secret", { status: 200 }), {
        before: [() => ({ ok: false as const, response: new Response("denied", { status: 403 }) })],
      }),
    });
    await app.init();
    const res = await app.handler(new Request("http://localhost:3000/admin"));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("denied");
  });
});
