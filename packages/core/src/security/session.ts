/**
 * Session management — signed-cookie (stateless) and store-backed sessions.
 *
 * `createSessionManager` returns a reusable manager; `withSession` turns it
 * into a request hook that exposes the current session through
 * {@link getSession}. Session mutations are write-through: `session.save()`
 * signs + writes the cookie (and the backing store when configured) via the
 * context's cookie jar, so responses automatically carry the right
 * `Set-Cookie` header.
 */
import { randomToken, signCookie, verifyCookie } from "@ignex/native";
import { err, isOk, ok, type Result } from "@ignex/shared";
import type { IgnexContext } from "../http/context";
import { writeCookie } from "../http/cookies";
import { continueHook, type HookFn, type HookResult } from "../lifecycle/hooks";
import { loadBunSqlite } from "../platform/sqlite";

/** Arbitrary session payload data (JSON-serializable). */
export type SessionData = Record<string, unknown>;

/** A live session attached to a request by the session middleware. */
export interface Session {
  readonly id: string;
  readonly createdAt: number;
  /** Epoch milliseconds at which the session expires. */
  expiresAt: number;
  data: SessionData;
  readonly isNew: boolean;
  /** Persist the session (writes cookie + store). */
  save(): Promise<void>;
  /** Delete the session (store entry + cookie). */
  destroy(): Promise<void>;
  /** Extend the session lifetime (rolling expiry). */
  touch(): void;
}

/** A pluggable session backing store (memory, SQLite, …). */
export interface SessionStore {
  get(id: string): Promise<SessionData | null>;
  set(id: string, data: SessionData, options?: { expiresAt?: number }): Promise<void>;
  delete(id: string): Promise<void>;
  touch?(id: string, options?: { expiresAt?: number }): Promise<void>;
  close?(): void;
}

/** In-memory session store with lazy expiry + periodic sweep (unref'd). */
export const createMemorySessionStore = (
  options: { ttlSeconds?: number; sweepIntervalMs?: number } = {},
): SessionStore => {
  const ttlMs = (options.ttlSeconds ?? 3600) * 1000;
  const entries = new Map<string, { data: SessionData; expiresAt: number }>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(id);
    }
  };

  const interval = setInterval(sweep, options.sweepIntervalMs ?? 60_000);
  interval.unref?.();

  return {
    async get(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(id);
        return null;
      }
      return { ...entry.data };
    },
    async set(id, data, opts) {
      entries.set(id, {
        data: { ...data },
        expiresAt: opts?.expiresAt ?? Date.now() + ttlMs,
      });
    },
    async delete(id) {
      entries.delete(id);
    },
    async touch(id, opts) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.expiresAt = opts?.expiresAt ?? Date.now() + ttlMs;
    },
    close() {
      clearInterval(interval);
    },
  };
};

/**
 * SQLite-backed session store via `bun:sqlite` (mirrors `createSqliteJobStore`).
 * Returns `null` when the module is unavailable (e.g. running on Node without
 * the polyfill) so callers can fall back to the memory store. Expired rows are
 * deleted lazily on read; a `close()` is provided for clean shutdown.
 */
export const createSqliteSessionStore = async (
  file = ":memory:",
  options: { ttlSeconds?: number } = {},
): Promise<SessionStore | null> => {
  const Database = await loadBunSqlite();
  if (!Database) return null;

  const ttlMs = (options.ttlSeconds ?? 3600) * 1000;
  const db = new Database(file);
  db.run(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  );
  const run = db.run.bind(db);
  const all = (sql: string, params: unknown[]): Array<{ data: string; expires_at: number }> =>
    db.query(sql).all(...params) as Array<{ data: string; expires_at: number }>;

  return {
    async get(id) {
      const rows = all("SELECT data, expires_at FROM sessions WHERE id = ?", [id]);
      const row = rows[0];
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        run("DELETE FROM sessions WHERE id = ?", [id]);
        return null;
      }
      try {
        return JSON.parse(row.data) as SessionData;
      } catch {
        run("DELETE FROM sessions WHERE id = ?", [id]);
        return null;
      }
    },
    async set(id, data, opts) {
      run(
        "INSERT INTO sessions (id, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at",
        [id, JSON.stringify(data), opts?.expiresAt ?? Date.now() + ttlMs],
      );
    },
    async delete(id) {
      run("DELETE FROM sessions WHERE id = ?", [id]);
    },
    async touch(id, opts) {
      run("UPDATE sessions SET expires_at = ? WHERE id = ?", [
        opts?.expiresAt ?? Date.now() + ttlMs,
        id,
      ]);
    },
    close() {
      db.close();
    },
  };
};

/** Options for {@link createSessionManager}. */
export interface SessionManagerOptions {
  secret: string | Uint8Array;
  /** Backing store. When omitted, sessions are fully stateless signed cookies. */
  store?: SessionStore;
  cookieName?: string;
  ttlSeconds?: number;
  /** Refresh the expiry on every request. */
  rolling?: boolean;
  cookieOptions?: Partial<Record<string, unknown>>;
}

/** A reusable session manager from {@link createSessionManager}. */
export interface SessionManager {
  /** Load the session for the current request (or `null`). */
  load(ctx: IgnexContext): Promise<Session | null>;
  /** Load the session, creating one when missing. */
  loadOrCreate(ctx: IgnexContext): Promise<Session>;
  /** Build the request hook that attaches the session to the context. */
  middleware(options?: { createIfMissing?: boolean | "lazy" }): HookFn;
  /** Close the backing store (releases sweep timers). Called on app shutdown. */
  close?(): void;
}

const SESSION_KEY = Symbol.for("ignex.session");

/**
 * Read the session attached by `withSession` middleware.
 *
 * When the middleware runs with `createIfMissing: "lazy"`, the session is
 * created here — on first read by a handler — instead of eagerly on every
 * request. Requests that never read the session (health checks, static
 * routes, non-session API calls) therefore do zero session work: no id
 * generation, no cookie signing, no `Set-Cookie` on the response.
 */
export const getSession = async (ctx: IgnexContext): Promise<Session | undefined> => {
  const existing = ctx.getState<Session>(SESSION_KEY);
  if (existing) return existing;

  const create = ctx.getState<() => Promise<Session>>(SESSION_CREATE);
  if (create) {
    const session = await create();
    ctx.setState(SESSION_KEY, session);
    ctx.state.delete(SESSION_CREATE);
    return session;
  }

  return undefined;
};

interface Envelope {
  id: string;
  data?: SessionData;
  exp: number;
}

/**
 * Lazy-creation marker left by the middleware when `createIfMissing: "lazy"`:
 * holds a factory that creates (and persists) the session on first read via
 * {@link getSession}, so requests that never use a session do no session work.
 */
const SESSION_CREATE = Symbol.for("ignex.session.create");

/** Why a session cookie could not be decoded. */
type DecodeError = "missing" | "invalid-signature" | "invalid-json" | "invalid-id" | "expired";

/**
 * Create a reusable session manager.
 *
 * Without a `store`, sessions are fully stateless signed cookies. With a
 * store, the data lives in the store and the cookie carries only the id + exp.
 *
 * @param options - Secret (must be non-empty), optional store/cookie/ttl tuning.
 * @throws TypeError when `options.secret` is empty.
 */
export const createSessionManager = (options: SessionManagerOptions): SessionManager => {
  if (options.secret.length === 0) {
    throw new TypeError("createSessionManager requires a non-empty secret");
  }
  const secret = options.secret;
  const store = options.store;
  const cookieName = options.cookieName ?? "sid";
  const ttlSeconds = options.ttlSeconds ?? 3600;
  const rolling = options.rolling ?? true;
  const cookieOptions = options.cookieOptions ?? { httpOnly: true, sameSite: "lax", path: "/" };

  const now = (): number => Date.now();
  const expiresAtFor = (): number => now() + ttlSeconds * 1000;

  const createId = (): string => randomToken(16);

  const decodeEnvelope = (raw: string | undefined): Result<Envelope, DecodeError> => {
    if (!raw) return err("missing");
    const unsigned = verifyCookie(raw, secret);
    if (!unsigned) return err("invalid-signature");
    try {
      const payload = JSON.parse(unsigned) as { id?: unknown; data?: unknown; exp?: unknown };
      if (typeof payload.id !== "string" || payload.id.length === 0) return err("invalid-id");
      const exp = typeof payload.exp === "number" ? payload.exp : Math.floor(now() / 1000);
      if (exp * 1000 <= now()) return err("expired");
      const data =
        payload.data != null && typeof payload.data === "object"
          ? (payload.data as SessionData)
          : {};
      return ok({ id: payload.id, data, exp });
    } catch {
      return err("invalid-json");
    }
  };

  const encodeEnvelope = (envelope: Envelope): string =>
    signCookie(JSON.stringify(envelope), secret);

  const makeSession = (
    ctx: IgnexContext,
    id: string,
    data: SessionData,
    createdAt: number,
    expiresAt: number,
    isNew: boolean,
  ): Session => {
    const session: Session = {
      id,
      createdAt,
      expiresAt,
      data,
      isNew,
      save: () => save(ctx, session),
      destroy: () => destroy(ctx, session),
      touch: () => {
        session.expiresAt = expiresAtFor();
      },
    };
    return session;
  };

  const save = async (ctx: IgnexContext, session: Session): Promise<void> => {
    await persist(ctx, session);
  };

  // Sync-capable persist: writes the cookie synchronously when there's no
  // backing store (the common stateless case) — zero Promise/microtask. With a
  // store, the cookie write is deferred until the store write resolves (same
  // ordering as the old `await store.set(...)` then `writeCookie`).
  const persist = (ctx: IgnexContext, session: Session): void | Promise<void> => {
    const envelope: Envelope = {
      id: session.id,
      exp: Math.floor(session.expiresAt / 1000),
    };
    if (store) {
      return store.set(session.id, session.data, { expiresAt: session.expiresAt }).then(() => {
        writeCookie(ctx.cookie, cookieName, encodeEnvelope(envelope), cookieOptions);
      });
    }
    envelope.data = session.data;
    writeCookie(ctx.cookie, cookieName, encodeEnvelope(envelope), cookieOptions);
  };

  const destroy = async (ctx: IgnexContext, session: Session | null): Promise<void> => {
    if (store && session) await store.delete(session.id);
    ctx.cookie[cookieName]?.remove();
  };

  // Sync-capable session resolution: without a store the cookie decode +
  // materialize is pure sync (no Promise). With a store, `store.get` is async.
  const resolveSession = (ctx: IgnexContext): Session | null | Promise<Session | null> => {
    const envelope = decodeEnvelope(ctx.cookie[cookieName]?.value);
    if (!isOk(envelope)) return null;
    const { id, data: envelopeData, exp } = envelope.value;

    if (store) {
      return store.get(id).then((stored) => {
        if (!stored) return null;
        return makeSession(ctx, id, stored, exp * 1000, exp * 1000, false);
      });
    }

    return makeSession(ctx, id, envelopeData ?? {}, exp * 1000, exp * 1000, false);
  };

  const load = async (ctx: IgnexContext): Promise<Session | null> => resolveSession(ctx);

  // Sync-capable create: materialize + persist; sync when there's no store.
  const createNew = (ctx: IgnexContext): Session | Promise<Session> => {
    const session = makeSession(ctx, createId(), {}, now(), expiresAtFor(), true);
    const p = persist(ctx, session);
    return p instanceof Promise ? p.then(() => session) : session;
  };

  const loadOrCreate = async (ctx: IgnexContext): Promise<Session> => {
    const existing = resolveSession(ctx);
    if (existing instanceof Promise) {
      const s = await existing;
      if (s) return s;
      return createNew(ctx);
    }
    if (existing) return existing;
    return createNew(ctx);
  };

  const middleware = (opts: { createIfMissing?: boolean | "lazy" } = {}): HookFn => {
    const createIfMissing = opts.createIfMissing ?? false;

    // Attach an existing session; with `rolling` this may rewrite the cookie
    // (sync without a store). Returns a Promise only when a store write is
    // involved.
    const attachExisting = (
      ctx: IgnexContext,
      existing: Session,
    ): HookResult | Promise<HookResult> => {
      if (rolling && !existing.isNew) {
        existing.touch();
        const p = persist(ctx, existing);
        if (p instanceof Promise) {
          return p.then(() => {
            ctx.setState(SESSION_KEY, existing);
            return continueHook(ctx);
          });
        }
      }
      ctx.setState(SESSION_KEY, existing);
      return continueHook(ctx);
    };

    // Attach nothing / create eagerly / defer via lazy marker.
    const attachMissing = (ctx: IgnexContext): HookResult | Promise<HookResult> => {
      if (createIfMissing === true) {
        const session = createNew(ctx);
        const finish = (s: Session): HookResult | Promise<HookResult> => {
          if (rolling && !s.isNew) {
            s.touch();
            const p = persist(ctx, s);
            if (p instanceof Promise) {
              return p.then(() => {
                ctx.setState(SESSION_KEY, s);
                return continueHook(ctx);
              });
            }
          }
          ctx.setState(SESSION_KEY, s);
          return continueHook(ctx);
        };
        if (session instanceof Promise) return session.then(finish);
        return finish(session);
      }
      if (createIfMissing === "lazy") {
        // Defer creation until a handler reads the session via getSession().
        // Requests that never touch the session do zero session work (no id
        // generation, no cookie signing, no Set-Cookie on the response).
        ctx.setState(SESSION_CREATE, () => loadOrCreate(ctx));
      }
      return continueHook(ctx);
    };

    // Sync-capable middleware: without a store, `rolling: false`, and no eager
    // creation, the whole request path is synchronous (cookie decode + lazy
    // marker) — zero Promise/microtask, so the compiled sync core fn never
    // delegates to its async resume. Genuinely async work (store I/O, rolling
    // save, eager creation) returns a Promise that runHooks awaits.
    return (ctx) => {
      const existing = resolveSession(ctx);
      if (existing instanceof Promise) {
        return existing.then((s) => (s ? attachExisting(ctx, s) : attachMissing(ctx)));
      }
      if (existing) return attachExisting(ctx, existing);
      return attachMissing(ctx);
    };
  };

  // Release the backing store's sweep timer on app shutdown so a long-lived
  // manager doesn't accumulate intervals.
  const close = (): void => {
    store?.close?.();
  };

  return { load, loadOrCreate, middleware, close };
};

/**
 * @deprecated Prefer `createSessionManager(options).middleware(opts)` — this
 * thin alias is kept for back-compat but creates a fresh manager per call.
 */
export const withSession = (
  options: SessionManagerOptions,
  middlewareOptions?: { createIfMissing?: boolean | "lazy" },
): HookFn => createSessionManager(options).middleware(middlewareOptions);
