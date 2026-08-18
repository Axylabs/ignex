/**
 * Auth module tests: Ed25519 `.env` key bootstrap, JWT claim shaping per mode,
 * and request-time user resolution.
 *
 * The full bootstrap (generate → write `.env`) is exercised in a temp
 * directory (chdir) so the workspace `.env` is never touched; key-present
 * paths are tested against pre-seeded `process.env`.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthModule, createContext, getUser } from "@ignex/core";
import { generateEd25519Keypair } from "@ignex/native";
import { afterEach, describe, expect, it } from "vitest";

const ctx = (req = new Request("http://localhost:3000/")) => createContext(req, {});

/** Preserve + restore the env keys this suite touches. */
const ENV_KEYS = ["JWT_PRIVATE_KEY", "JWT_PUBLIC_KEY"] as const;
const saved = new Map<string, string | undefined>();
const saveEnv = (): void => {
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
};
const restoreEnv = (): void => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

let cwd: string | undefined;
afterEach(() => {
  restoreEnv();
  if (cwd) {
    process.chdir(cwd);
    cwd = undefined;
  }
});

describe("createAuthModule — .env key bootstrap", () => {
  it("generates Ed25519 keys and writes them to .env idempotently", () => {
    saveEnv();
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;

    // Run in a throwaway cwd so the workspace .env is untouched.
    cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "ignex-auth-"));
    process.chdir(dir);

    const module = createAuthModule({ mode: "both" });
    module.plugin().init?.();

    const dotenv = readFileSync(join(dir, ".env"), "utf8");
    expect(dotenv).toContain("JWT_PRIVATE_KEY=");
    expect(dotenv).toContain("JWT_PUBLIC_KEY=");

    // Keys are valid base64url DER: 48-byte PKCS#8 + 44-byte SPKI.
    const privateKey = process.env.JWT_PRIVATE_KEY ?? "";
    const publicKey = process.env.JWT_PUBLIC_KEY ?? "";
    const priv = Buffer.from(privateKey, "base64url");
    const pub = Buffer.from(publicKey, "base64url");
    expect(priv).toHaveLength(48);
    expect(pub).toHaveLength(44);

    // A second init must NOT rewrite (idempotent — keys unchanged).
    const before = dotenv;
    module.plugin().init?.();
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  });

  it("throws when keys are missing and bootstrap is disabled", () => {
    saveEnv();
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;

    // Run in a throwaway cwd so a workspace `.env` can't supply the keys.
    cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "ignex-auth-"));
    process.chdir(dir);

    const module = createAuthModule({ mode: "both", bootstrapEnv: false });
    expect(() => module.plugin().init?.()).toThrow(/JWT_PRIVATE_KEY/);
  });

  it("uses pre-existing keys without writing .env", async () => {
    saveEnv();
    const pair = generateEd25519Keypair();
    process.env.JWT_PRIVATE_KEY = pair.privateKey;
    process.env.JWT_PUBLIC_KEY = pair.publicKey;

    const module = createAuthModule({ mode: "both" });
    module.plugin().init?.();
    const token = await module.issueToken({ id: "1" }, { roles: ["admin"] });
    expect(token.split(".")).toHaveLength(3);
  });
});

describe("createAuthModule — claim shaping", () => {
  it("role mode embeds roles only", async () => {
    const pair = generateEd25519Keypair();
    const module = createAuthModule({
      mode: "role",
      privateKeyEnv: "T_PRIV",
      publicKeyEnv: "T_PUB",
    });
    process.env.T_PRIV = pair.privateKey;
    process.env.T_PUB = pair.publicKey;
    const token = await module.issueToken({ id: "u1" }, { roles: ["admin", "editor"] });
    const claims = module.jwt.verify(token) as Record<string, unknown>;
    expect(claims.roles).toEqual(["admin", "editor"]);
    expect(claims.permissions).toBeUndefined();
  });

  it("permission mode expands rolePermissions into permissions", async () => {
    const pair = generateEd25519Keypair();
    const module = createAuthModule({
      mode: "permission",
      privateKeyEnv: "T_PRIV",
      publicKeyEnv: "T_PUB",
      rolePermissions: { admin: ["users:read", "users:write"], editor: ["users:read"] },
    });
    process.env.T_PRIV = pair.privateKey;
    process.env.T_PUB = pair.publicKey;
    const token = await module.issueToken(
      { id: "u1" },
      { roles: ["admin"], permissions: ["extra:one"] },
    );
    const claims = module.jwt.verify(token) as Record<string, unknown>;
    expect((claims.permissions as string[]).sort()).toEqual([
      "extra:one",
      "users:read",
      "users:write",
    ]);
    expect(claims.roles).toBeUndefined();
  });

  it("both mode embeds roles + permissions", async () => {
    const pair = generateEd25519Keypair();
    const module = createAuthModule({
      mode: "both",
      privateKeyEnv: "T_PRIV",
      publicKeyEnv: "T_PUB",
      rolePermissions: { admin: ["users:read"] },
    });
    process.env.T_PRIV = pair.privateKey;
    process.env.T_PUB = pair.publicKey;
    const token = await module.issueToken({ id: "u1" }, { roles: ["admin"] });
    const claims = module.jwt.verify(token) as Record<string, unknown>;
    expect(claims.roles).toEqual(["admin"]);
    expect(claims.permissions).toEqual(["users:read"]);
  });

  it("honors an async loadPermissions loader", async () => {
    const pair = generateEd25519Keypair();
    const module = createAuthModule({
      mode: "permission",
      privateKeyEnv: "T_PRIV",
      publicKeyEnv: "T_PUB",
      loadPermissions: async (user) => [`${user.scope}:read` as string],
    });
    process.env.T_PRIV = pair.privateKey;
    process.env.T_PUB = pair.publicKey;
    const token = await module.issueToken({ id: "u1", scope: "orders" });
    const claims = module.jwt.verify(token) as Record<string, unknown>;
    expect(claims.permissions).toEqual(["orders:read"]);
  });
});

describe("createAuthModule — request lifecycle", () => {
  it("middleware accepts a valid token and halts with 401 otherwise", async () => {
    const pair = generateEd25519Keypair();
    const module = createAuthModule({
      mode: "both",
      privateKeyEnv: "T_PRIV",
      publicKeyEnv: "T_PUB",
    });
    process.env.T_PRIV = pair.privateKey;
    process.env.T_PUB = pair.publicKey;

    const token = await module.issueToken({ id: "u1" }, { roles: ["admin"] });
    const ok = await module.middleware()(
      ctx(
        new Request("http://localhost:3000/", {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    );
    expect(ok.ok).toBe(true);

    const bad = await module.middleware()(
      ctx(new Request("http://localhost:3000/", { headers: { authorization: "Bearer nope" } })),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.response.status).toBe(401);
  });

  it("plugin onRequest attaches the user when a token is present, no-op otherwise", async () => {
    const pair = generateEd25519Keypair();
    const module = createAuthModule({
      mode: "both",
      privateKeyEnv: "T_PRIV",
      publicKeyEnv: "T_PUB",
    });
    process.env.T_PRIV = pair.privateKey;
    process.env.T_PUB = pair.publicKey;

    const token = await module.issueToken(
      { id: "u1" },
      { roles: ["admin"], permissions: ["users:read"] },
    );
    const c = ctx(
      new Request("http://localhost:3000/", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const result = module.plugin().onRequest?.(c);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      await result;
    }
    const user = getUser(c) as Record<string, unknown>;
    expect(user.sub).toBe("u1");
    expect(user.roles).toEqual(["admin"]);
    expect(user.permissions).toEqual(["users:read"]);

    const anon = ctx();
    const anonResult = module.plugin().onRequest?.(anon);
    if (anonResult && typeof (anonResult as PromiseLike<unknown>).then === "function") {
      await anonResult;
    }
    expect(getUser(anon)).toBeUndefined();
  });
});
