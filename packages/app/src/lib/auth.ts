import {
  createAuthModule,
  createMemorySessionStore,
  createPasswordHasher,
  randomToken,
  type SessionStore,
} from "@ignex/core";

// Ed25519 (EdDSA) JWT auth module — issues short-lived access tokens and
// bootstraps `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` into `.env` on first use.
export const ACCESS_TTL_SECONDS = 15 * 60;

export const auth = createAuthModule({
  mode: "both", // claims: { sub, roles, permissions }
  ttlSeconds: ACCESS_TTL_SECONDS,
  issuer: "ignex-app",
});

// Named hook used by routes via `config.hooks = ["require-auth"]`.
export const requireAuth = auth.middleware();

// --- In-memory user store (hashed passwords) ---
// Swap for a real DB (e.g. a ninox collection) in production. The admin seed
// is created on first access so hashing (argon2id native / scrypt fallback)
// runs once at runtime rather than at module load.
const hasher = createPasswordHasher();
const users = new Map<string, { passwordHash: string; roles: string[] }>();
let seeded = false;

async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  users.set("admin", {
    passwordHash: await hasher.hash("secret"),
    roles: ["admin"],
  });
}

export const userStore = {
  async find(username: string) {
    await ensureSeed();
    return users.get(username) ?? null;
  },
  async create(username: string, password: string, roles: string[] = []) {
    await ensureSeed();
    if (users.has(username)) return null;
    users.set(username, { passwordHash: await hasher.hash(password), roles });
    return { username, roles };
  },
  async verify(username: string, password: string) {
    const entry = await userStore.find(username);
    if (!entry) return null;
    return hasher.verify(password, entry.passwordHash) ? { username, roles: entry.roles } : null;
  },
};

// --- Refresh tokens (opaque, revocable) ---
// Reuses the session-store infrastructure (`SessionStore`) so tokens can be
// revoked (logout) and verified server-side. Memory by default; point
// `refreshStore` at `createSqliteSessionStore(...)` for persistence across
// restarts.
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const refreshStore: SessionStore = createMemorySessionStore({ ttlSeconds: 7 * 24 * 60 * 60 });

export const refreshTokens = {
  /** Issue a new opaque refresh token bound to the user. */
  async issue(user: { username: string; roles: string[] }): Promise<string> {
    const token = randomToken(32);
    await refreshStore.set(
      token,
      { sub: user.username, roles: user.roles },
      { expiresAt: Date.now() + REFRESH_TTL_MS },
    );
    return token;
  },
  /** Resolve a refresh token to its user claims, or null when invalid/expired. */
  async consume(token: string) {
    return await refreshStore.get(token);
  },
  /** Revoke a refresh token (logout). */
  async revoke(token: string): Promise<void> {
    await refreshStore.delete(token);
  },
};
