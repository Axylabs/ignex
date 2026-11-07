/**
 * Key-rotation ring tests — the grace-window contract: sign with the current
 * secret (`secrets[0]`), verify against every entry, so rotating a secret
 * does not invalidate live JWTs, cookies, CSRF tokens or session seals until
 * the old entry is dropped.
 */
import { generateEd25519Keypair } from "@ignex/native";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/http/context";
import {
  createCookieSigner,
  createCsrf,
  createEd25519Jwt,
  createJwt,
} from "../src/security/crypto";
import {
  normalizeSecrets,
  signSecret,
  verifyBoolWithRing,
  verifyWithRing,
} from "../src/security/keyring";
import { createSessionManager, getSession } from "../src/security/session";

const DEV_ENV = { NODE_ENV: "development" } as const;

describe("keyring primitives", () => {
  it("normalizes a single secret into a one-entry ring", () => {
    expect(normalizeSecrets("abc")).toEqual(["abc"]);
    expect(signSecret("abc")).toBe("abc");
    expect(signSecret(["new", "old"])).toBe("new");
  });

  it("rejects empty rings and empty entries", () => {
    expect(() => normalizeSecrets([])).toThrow(TypeError);
    expect(() => normalizeSecrets(["ok", ""])).toThrow(TypeError);
    expect(() => normalizeSecrets(["", "ok"])).toThrow(TypeError);
  });

  it("verifyWithRing returns the first accepted entry's result", () => {
    const result = verifyWithRing(["new", "old"], (secret) =>
      secret === "old" ? "old-hit" : null,
    );
    expect(result).toBe("old-hit");
    expect(verifyWithRing(["new"], () => null)).toBeNull();
  });

  it("verifyBoolWithRing needs one accepting entry", () => {
    expect(verifyBoolWithRing(["a", "b"], (s) => s === "b")).toBe(true);
    expect(verifyBoolWithRing(["a"], () => false)).toBe(false);
  });
});

describe("JWT rotation", () => {
  it("verifies tokens signed with the previous secret during the grace window", () => {
    const ring = ["new-secret-current", "previous-secret"];
    const svc = createJwt({ secret: ring, ttlSeconds: 600 });
    const oldSvc = createJwt({ secret: "previous-secret", ttlSeconds: 600 });
    const legacyToken = oldSvc.sign({ sub: "user-1" });
    expect(svc.verify(legacyToken)).toMatchObject({ sub: "user-1" });
    // New tokens sign with the current secret and verify too.
    const fresh = svc.sign({ sub: "user-2" });
    expect(svc.verify(fresh)).toMatchObject({ sub: "user-2" });
    // Signed by no ring entry → still fails closed.
    const foreign = createJwt({ secret: "attacker", ttlSeconds: 600 });
    expect(svc.verify(foreign.sign({ sub: "evil" }))).toBeNull();
  });

  it("rotates Ed25519 public keys with a grace window", () => {
    const oldPair = generateEd25519Keypair();
    const newPair = generateEd25519Keypair();
    const oldSvc = createEd25519Jwt({
      privateKey: oldPair.privateKey,
      publicKey: oldPair.publicKey,
      ttlSeconds: 600,
    });
    const rotated = createEd25519Jwt({
      privateKey: newPair.privateKey,
      publicKey: [newPair.publicKey, oldPair.publicKey],
      ttlSeconds: 600,
    });
    const legacy = oldSvc.sign({ sub: "user-1" });
    expect(rotated.verify(legacy)).toMatchObject({ sub: "user-1" });
    expect(rotated.verify(rotated.sign({ sub: "user-2" }))).toMatchObject({ sub: "user-2" });
  });
});

describe("cookie/CSRF rotation", () => {
  it("signed cookies verify across the ring", () => {
    const signer = createCookieSigner(["new-cookie-secret", "old-cookie-secret"]);
    const legacy = createCookieSigner("old-cookie-secret");
    expect(signer.verify(legacy.sign("value"))).toBe("value");
    expect(signer.verify(signer.sign("value"))).toBe("value");
    const foreign = createCookieSigner("attacker");
    expect(signer.verify(foreign.sign("evil"))).toBeNull();
  });

  it("CSRF tokens verify across the ring", () => {
    const csrf = createCsrf(["new-csrf-secret", "old-csrf-secret"]);
    const legacy = createCsrf("old-csrf-secret");
    expect(csrf.verify(legacy.token())).toBe(true);
    expect(csrf.verify(csrf.token())).toBe(true);
    expect(csrf.verify("not-a-token")).toBe(false);
  });
});

describe("session rotation", () => {
  const makeCtx = (cookie?: string) =>
    createContext(new Request("http://localhost:3000/", { headers: cookie ? { cookie } : {} }), {});

  it("session seals open across the ring (no forced logout on rotation)", async () => {
    const ring = ["current-session-secret-0123456789", "previous-session-secret-0123456"];
    const rotated = createSessionManager({ secret: ring, ttlSeconds: 3600 });
    const legacy = createSessionManager({ secret: ring[1]!, ttlSeconds: 3600 });
    // A session created before the rotation (sealed by the old manager) opens
    // on the rotated manager through the same cookie jar.
    const c1 = makeCtx();
    const created = await legacy.middleware({ createIfMissing: true })(c1);
    expect(created.ok).toBe(true);
    const s1 = await getSession(c1);
    s1!.data.uid = "u1";
    await s1!.save();
    const raw = c1.cookie.sid?.value;
    expect(raw).toMatch(/\./);

    const c2 = makeCtx(`sid=${raw}`);
    await rotated.middleware()(c2);
    const s2 = await getSession(c2);
    expect(s2?.data.uid).toBe("u1");

    // New seals sign with the current entry and still open.
    const c3 = makeCtx();
    await rotated.middleware({ createIfMissing: true })(c3);
    const s3 = await getSession(c3);
    s3!.data.uid = "u2";
    await s3!.save();
    const c4 = makeCtx(`sid=${c3.cookie.sid?.value}`);
    await rotated.middleware()(c4);
    expect((await getSession(c4))?.data.uid).toBe("u2");
  });

  it("gates every ring entry for strength, not just the current", () => {
    // In strict mode a previous (verify-only) key is still forgeable session
    // material — the gate applies per entry.
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        createSessionManager({
          secret: ["strong-current-secret-0123456789", "short"],
          ttlSeconds: 60,
        }),
      ).toThrow(/at least 16 characters/);
    } finally {
      process.env.NODE_ENV = DEV_ENV.NODE_ENV;
    }
  });
});
