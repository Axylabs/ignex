/**
 * Auth module — Ed25519 (EdDSA) JWT authentication with role/permission claim
 * shaping and `.env` key bootstrap.
 *
 * On `init()` (idempotent) the module:
 *   1. `loadEnv()`s the dotenv files,
 *   2. reads `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` from the environment, and
 *   3. if they're missing, GENERATES an Ed25519 keypair through the Rust addon
 *      (`@ignex/native` FFI, pure-TS fallback) and appends both to `.env`
 *      (never overwriting existing keys).
 *
 * The JWT claim shape follows the configured `mode`:
 *   - `role`       → `{ sub, roles }`
 *   - `permission` → `{ sub, permissions }` (direct ∪ role-derived permissions)
 *   - `both`       → `{ sub, roles, permissions }` (default)
 *
 * The plugin's `onRequest` performs OPTIONAL auth (attaches the user when a
 * bearer token is present, never rejects); RBAC guards (`can`/`hasRole`) run
 * after it and decide on protected routes.
 */
import { generateEd25519Keypair } from "@ignex/native";
import type { IgnexContext } from "../http/context";
import type { HookFn } from "../lifecycle/hooks";
import type { IgnexPlugin } from "../lifecycle/plugin";
import { loadEnv, writeEnvKeys } from "../platform/env";
import type { MaybePromise } from "../types";
import { type AuthUser, bearerAuth, setUser } from "./auth";
import { createEd25519Jwt, createJwt, type Ed25519JwtService, type JwtService } from "./crypto";

/** How the JWT claim set is shaped at issue time. */
export type AuthMode = "role" | "permission" | "both";

/** Default issued-token lifetime (1 hour) when `ttlSeconds` is not configured. */
export const DEFAULT_AUTH_TOKEN_TTL_SECONDS = 3600;

/** Options for {@link createAuthModule}. */
export interface AuthModuleOptions {
  /** Claim shape: `role`, `permission`, or `both` (default `both`). */
  mode?: AuthMode;
  /** JWT algorithm: `EdDSA` (default, ed25519 keys) or `HS256` (shared secret). */
  algorithm?: "EdDSA" | "HS256";
  /**
   * Fixed TTL in seconds for issued tokens (injects `iat`/`exp`). Default
   * `3600` (1 hour) — issued tokens ALWAYS expire by default; the verifier
   * rejects non-expiring tokens (`requireExp`), so a config omission can
   * never silently mint permanent credentials. Pass `0` to opt out
   * deliberately (verification then needs `requireExp: false` too).
   */
  ttlSeconds?: number;
  /** `iss` claim injected on sign and enforced on verify. */
  issuer?: string;
  /** `aud` claim(s) injected on sign and enforced on verify. */
  audience?: string | string[];
  /** HS256 shared secret (only for `algorithm: "HS256"`). */
  secret?: string | Uint8Array;
  /** `.env` key name for the Ed25519 private key (default `JWT_PRIVATE_KEY`). */
  privateKeyEnv?: string;
  /** `.env` key name for the Ed25519 public key (default `JWT_PUBLIC_KEY`). */
  publicKeyEnv?: string;
  /** role → permissions map, used to expand roles into permissions. */
  rolePermissions?: Record<string, string[]>;
  /** Resolve a user's roles at issue time (DB-backed). Optional. */
  loadRoles?: (user: AuthUser) => MaybePromise<string[]>;
  /** Resolve a user's permissions at issue time (DB-backed). Optional. */
  loadPermissions?: (user: AuthUser) => MaybePromise<string[]>;
  /** Allow generating + writing missing keys into `.env` (default true). */
  bootstrapEnv?: boolean;
  /** Send `WWW-Authenticate: Bearer` on middleware failure (default true). */
  challenge?: boolean;
}

/** The runtime auth module: token issuance + an `IgnexPlugin` for requests. */
export interface AuthModule {
  readonly mode: AuthMode;
  /** The bound JWT service (EdDSA by default). Ready after `init()`. */
  readonly jwt: Ed25519JwtService | JwtService;
  /** Issue a JWT for `user`, shaping claims per `mode`. */
  issueToken(user: AuthUser, opts?: { roles?: string[]; permissions?: string[] }): Promise<string>;
  /** A `requireAuth` hook that verifies tokens with THIS module's service. */
  middleware(): HookFn;
  /** The plugin: boots keys on `init`, attaches the user on `onRequest`. */
  plugin(): IgnexPlugin;
}

/** Split a `Bearer` authorization header into `{ header, token }` or null. */
const bearerParts = (ctx: IgnexContext): { token: string } | null => {
  const header = ctx.headers.get("authorization") ?? "";
  const space = header.indexOf(" ");
  const scheme = (space < 0 ? header : header.slice(0, space)).toLowerCase();
  if (scheme !== "bearer") return null;
  const token = space < 0 ? "" : header.slice(space + 1);
  if (!token) return null;
  return { token };
};

/** Verify a token with the module's JWT service → claims object or null. */
const verifyWith = (
  jwt: Ed25519JwtService | JwtService,
  token: string,
): Record<string, unknown> | null => {
  const claims = jwt.verify(token);
  return claims != null && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
};

/**
 * Create the auth module.
 *
 * @throws Error on `init()`/first use when EdDSA keys are missing AND
 *   `bootstrapEnv: false` (or HS256 has no secret).
 */
export const createAuthModule = (options: AuthModuleOptions = {}): AuthModule => {
  const mode = options.mode ?? "both";
  const algorithm = options.algorithm ?? "EdDSA";
  const privateKeyEnv = options.privateKeyEnv ?? "JWT_PRIVATE_KEY";
  const publicKeyEnv = options.publicKeyEnv ?? "JWT_PUBLIC_KEY";

  let jwt!: Ed25519JwtService | JwtService;
  let initialised = false;

  /** Ensure keys exist (generating + writing to `.env` when allowed). */
  const ensureKeys = (): { privateKey: string; publicKey: string } => {
    loadEnv();
    if (algorithm === "HS256") {
      const secret = options.secret !== undefined ? options.secret : process.env.JWT_SECRET;
      if (!secret) {
        throw new Error(
          "[ignex] auth: HS256 requires options.secret or JWT_SECRET in the environment",
        );
      }
      return { privateKey: String(secret), publicKey: String(secret) };
    }

    let privateKey = process.env[privateKeyEnv];
    let publicKey = process.env[publicKeyEnv];
    if (privateKey && publicKey) return { privateKey, publicKey };

    if (options.bootstrapEnv === false) {
      throw new Error(
        `[ignex] auth: missing ${privateKeyEnv}/${publicKeyEnv} and bootstrapEnv is disabled`,
      );
    }

    const pair = generateEd25519Keypair();
    writeEnvKeys({
      [privateKeyEnv]: pair.privateKey,
      [publicKeyEnv]: pair.publicKey,
    });
    privateKey = process.env[privateKeyEnv] ?? pair.privateKey;
    publicKey = process.env[publicKeyEnv] ?? pair.publicKey;
    return { privateKey, publicKey };
  };

  /** Build the JWT service bound to the resolved keys/secret. */
  const buildJwt = (): Ed25519JwtService | JwtService => {
    const common = {
      // Secure-by-default: issued tokens expire after one hour unless the app
      // configures an explicit TTL (or opts out with 0 — see AuthModuleOptions).
      ttlSeconds: options.ttlSeconds ?? DEFAULT_AUTH_TOKEN_TTL_SECONDS,
      ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
      ...(options.audience !== undefined ? { audience: options.audience } : {}),
    };
    if (algorithm === "HS256") {
      return createJwt({ secret: ensureKeys().privateKey, ...common });
    }
    const { privateKey, publicKey } = ensureKeys();
    return createEd25519Jwt({ privateKey, publicKey, ...common });
  };

  const init = (): void => {
    if (initialised) return;
    jwt = buildJwt();
    initialised = true;
  };

  /** Permissions granted by a role list (rolePermissions map or a loader). */
  const permissionsForRoles = async (user: AuthUser, roles: string[]): Promise<string[]> => {
    if (options.loadPermissions) return options.loadPermissions(user);
    const roleMap = options.rolePermissions ?? {};
    const out = new Set<string>();
    for (const role of roles) {
      for (const perm of roleMap[role] ?? []) out.add(perm);
    }
    return [...out];
  };

  const issueToken = async (
    user: AuthUser,
    opts: { roles?: string[]; permissions?: string[] } = {},
  ): Promise<string> => {
    init();

    const roles =
      opts.roles ??
      (options.loadRoles
        ? await options.loadRoles(user)
        : ((user.roles as string[] | undefined) ?? []));

    const direct = opts.permissions ?? (user.permissions as string[] | undefined) ?? [];
    let permissions = direct;
    if (mode === "permission" || mode === "both") {
      const fromRoles = await permissionsForRoles(user, roles);
      permissions = [...new Set([...direct, ...fromRoles])];
    }

    // A user without `id`/`sub` gets a UNIQUE per-token subject (previously a
    // constant "anon" made every such token indistinguishable — role-scoped
    // auth could not tell them apart).
    const claims: Record<string, unknown> = {
      sub: String(user.id ?? user.sub ?? crypto.randomUUID()),
    };
    if (mode === "role" || mode === "both") claims.roles = roles;
    if (mode === "permission" || mode === "both") claims.permissions = permissions;

    return jwt.sign(claims);
  };

  /** Require a valid bearer token; halts with 401 when absent/invalid. */
  const middleware = (): HookFn => {
    init();
    const service = jwt;
    return bearerAuth(
      (token) => verifyWith(service, token),
      options.challenge === false ? undefined : "Bearer",
    );
  };

  /** Resolve the user from a bearer token when present (never rejects). */
  const resolveUser = async (ctx: IgnexContext): Promise<void> => {
    init();
    const parts = bearerParts(ctx);
    if (!parts) return;
    const claims = verifyWith(jwt, parts.token);
    if (claims) setUser(ctx, claims);
  };

  const plugin: IgnexPlugin = {
    name: "auth-module",
    version: "1.0.0",
    init,
    onRequest(ctx) {
      // Fast path: no Authorization header → sync no-op (zero Promise alloc).
      const header = ctx.headers.get("authorization");
      if (!header || !/^bearer\s/i.test(header)) return ctx;
      return (async () => {
        await resolveUser(ctx);
        return ctx;
      })();
    },
  };

  return {
    mode,
    get jwt() {
      init();
      return jwt;
    },
    issueToken,
    middleware,
    plugin: () => plugin,
  };
};
