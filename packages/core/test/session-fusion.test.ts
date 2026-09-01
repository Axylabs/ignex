/**
 * Session seal/open fusion: cookies sealed through the fused native path must
 * round-trip, and BOTH sealers (fused + fallback signCookie) must decode on
 * the shared decode path — no cookie written before the change may break.
 */

import { signCookie, verifyCookie } from "@ignex/native";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/http/context";
import { createSessionManager, getSession } from "../src/index";

const SECRET = "s3cret-value-for-tests";
const makeCtx = (cookie?: string) =>
  createContext(
    new Request("http://localhost:3000/", {
      headers: cookie ? { cookie } : {},
    }),
    {},
  );

describe("session fusion (sessionSeal/sessionOpen)", () => {
  it("round-trips session data through save → new request → load", async () => {
    const manager = createSessionManager({ secret: SECRET });
    const c1 = makeCtx();
    const created = await manager.middleware({ createIfMissing: true })(c1);
    expect(created.ok).toBe(true);
    const s1 = await getSession(c1);
    expect(s1).toBeDefined();
    if (!s1) return;
    s1.data.cart = ["apple"];
    await s1.save();
    const raw = c1.cookie.sid?.value;
    expect(raw).toMatch(/\./);

    const c2 = makeCtx(`sid=${raw}`);
    await manager.middleware()(c2);
    const s2 = await getSession(c2);
    expect(s2).toBeDefined();
    expect(s2?.data.cart).toEqual(["apple"]);
  });

  it("decodes legacy fallback-sealed cookies (byte compatibility)", async () => {
    const envelope = JSON.stringify({
      id: "legacy-id",
      data: { visits: 3 },
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const legacy = signCookie(envelope, SECRET);
    const manager = createSessionManager({ secret: SECRET });
    const c = makeCtx(`sid=${legacy}`);
    await manager.middleware()(c);
    const session = await getSession(c);
    expect(session?.id).toBe("legacy-id");
    expect(session?.data.visits).toBe(3);
  });

  it("rejects tampered and expired cookies identically on both paths", async () => {
    const manager = createSessionManager({ secret: SECRET });
    // Tampered
    const c1 = makeCtx("sid=abc.123");
    await manager.middleware()(c1);
    expect(await getSession(c1)).toBeUndefined();
    expect(c1.cookie.sid?.value).toBe(""); // cleared

    // Expired (signed honestly with a past exp)
    const expired = signCookie(
      JSON.stringify({ id: "x", data: {}, exp: Math.floor(Date.now() / 1000) - 10 }),
      SECRET,
    );
    const c2 = makeCtx(`sid=${expired}`);
    await manager.middleware()(c2);
    expect(await getSession(c2)).toBeUndefined();

    // Sanity: verifyCookie still accepts the honest token format.
    expect(verifyCookie(expired, SECRET)).not.toBeNull();
  });

  it("store-backed sessions keep the id-only cookie contract", async () => {
    const { createMemorySessionStore } = await import("../src/security/session-store");
    const manager = createSessionManager({
      secret: SECRET,
      store: createMemorySessionStore(),
    });
    const c1 = makeCtx();
    await manager.middleware({ createIfMissing: true })(c1);
    const s1 = await getSession(c1);
    if (!s1) return;
    s1.data.role = "admin";
    await s1.save();
    const raw = c1.cookie.sid?.value;
    const parsed = JSON.parse(verifyCookie(raw ?? "", SECRET) ?? "{}") as {
      data?: unknown;
      exp?: number;
    };
    // Store-backed: cookie carries id + exp only (data stays server-side).
    expect(parsed.data ?? null).toBeFalsy();
    expect(typeof parsed.exp).toBe("number");

    const c2 = makeCtx(`sid=${raw}`);
    await manager.middleware()(c2);
    const s2 = await getSession(c2);
    expect(s2?.data.role).toBe("admin");
  });
});
