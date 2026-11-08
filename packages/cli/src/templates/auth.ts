/**
 * @fileoverview Durable authentication library template for generated apps.
 */

/** Emit the auth module, SQLite users, and optional refresh-token rotation. */
export function authLibTemplate(options: { refresh: boolean }): string {
  const { refresh } = options;
  const refreshImports = refresh ? 'import { createHash } from "node:crypto";\n' : "";
  const refreshSection = refresh
    ? `
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const refreshDb = await createSqliteStore("./data/auth.db", {
  table: "refresh_tokens",
  ttlMs: REFRESH_TTL_MS
});
if (!refreshDb) throw new Error("Refresh tokens require bun:sqlite");
const refreshStore: Store = refreshDb;
const updateRefresh = refreshStore.update;
if (!updateRefresh) throw new Error("Refresh tokens require atomic updates");
const refreshKey = (token: string): string =>
  \`refresh:\${createHash("sha256").update(token).digest("hex")}\`;

interface RefreshClaims {
  sub: string;
  roles: string[];
  expiresAt: number;
  consumedAt?: number;
}

export const refreshTokens = {
  async issue(user: { username: string; roles: string[] }): Promise<string> {
    const token = randomToken(32);
    const expiresAt = Date.now() + REFRESH_TTL_MS;
    const claims: RefreshClaims = { sub: user.username, roles: user.roles, expiresAt };
    await refreshStore.set(refreshKey(token), claims, { expiresAt });
    return token;
  },
  async consume(token: string): Promise<RefreshClaims | null> {
    let consumed: RefreshClaims | null = null;
    await updateRefresh.call(refreshStore, refreshKey(token), (current) => {
      if (!current || typeof current !== "object") return current;
      const claims = current as RefreshClaims;
      if (claims.consumedAt || claims.expiresAt <= Date.now()) return current;
      if (typeof claims.sub !== "string" || !Array.isArray(claims.roles)) return current;
      consumed = { sub: claims.sub, roles: [...claims.roles], expiresAt: claims.expiresAt };
      return { ...claims, consumedAt: Date.now() };
    });
    return consumed;
  },
  async revoke(token: string): Promise<void> {
    await refreshStore.delete(refreshKey(token));
  }
};
`
    : "";
  const closeRefresh = refresh ? "await refreshStore.close?.();" : "";

  return `${refreshImports}import { mkdirSync } from "node:fs";
import {
  createAuthModule,
  createPasswordHasher,
  createSqliteStore${refresh ? ",\n  randomToken,\n  type Store" : ""}
} from "@ignex/core";

export const ACCESS_TTL_SECONDS = 15 * 60;
export const auth = createAuthModule({
  mode: "both",
  ttlSeconds: ACCESS_TTL_SECONDS,
  issuer: "ignex-app"
});
export const requireAuth = auth.middleware();

mkdirSync("./data", { recursive: true });
const authDb = await createSqliteStore("./data/auth.db", { table: "auth_users" });
if (!authDb) throw new Error("The auth store requires bun:sqlite");
const updateUser = authDb.update;
if (!updateUser) throw new Error("The auth store requires atomic updates");
const hasher = createPasswordHasher();

interface UserRecord {
  passwordHash: string;
  roles: string[];
}

const userKey = (username: string): string => \`user:\${username.trim().toLowerCase()}\`;

export const userStore = {
  async find(username: string): Promise<UserRecord | null> {
    const value = await authDb.get(userKey(username));
    return value && typeof value === "object" ? value as UserRecord : null;
  },
  async create(username: string, password: string) {
    const normalized = username.trim().toLowerCase();
    const passwordHash = await hasher.hash(password);
    let created = false;
    await updateUser.call(authDb, userKey(normalized), (current) => {
      if (current) return current;
      created = true;
      return { passwordHash, roles: ["user"] } satisfies UserRecord;
    });
    return created ? { username: normalized, roles: ["user"] } : null;
  },
  async verify(username: string, password: string) {
    const entry = await userStore.find(username);
    if (!entry) return null;
    return await hasher.verifyAsync(password, entry.passwordHash)
      ? { username: username.trim().toLowerCase(), roles: entry.roles }
      : null;
  }
};

export const closeAuth = async (): Promise<void> => {
  await authDb.close?.();
  ${closeRefresh}
};

export const authLifecycle = {
  name: "auth-lifecycle",
  close: closeAuth
};
${refreshSection}
`;
}
