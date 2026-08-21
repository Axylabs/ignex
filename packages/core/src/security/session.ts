/**
 * Session management — signed-cookie (stateless) and store-backed sessions.
 *
 * `createSessionManager` returns a reusable manager; `withSession` turns it
 * into a request hook that exposes the current session through
 * {@link getSession}. Session mutations are write-through: `session.save()`
 * signs + writes the cookie (and the backing store when configured) via the
 * context's cookie jar, so responses automatically carry the right
 * `Set-Cookie` header.
 *
 * The backing stores live in `./session-store`: `SessionStore` is the pluggable
 * driver contract, implemented on the generic `data/store` layer (`memory` /
 * `sqlite` / file / custom drivers via {@link createSessionStoreFromStore}).
 */
import { randomToken, signCookie, verifyCookie } from "@ignex/native";
import { err, ok, type Result } from "@ignex/shared";
import type { IgnexContext } from "../http/context";
import { writeCookie } from "../http/cookies";
import { continueHook, type HookFn, type HookResult } from "../lifecycle/hooks";
import type { SessionData, SessionStore, SessionStoreOptions } from "./session-store";
import {
  createMemorySessionStore,
  createSessionStoreFromStore,
  createSqliteSessionStore,
} from "./session-store";

export type { SessionData, SessionStore, SessionStoreOptions };
export { createMemorySessionStore, createSessionStoreFromStore, createSqliteSessionStore };

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
  // Production hardening: a weak or well-known dev default secret must never
  // ship. Dev/test keep the lenient check so local iteration stays
  // frictionless (matches the `doctor` security check).
  if (process.env.NODE_ENV === "production") {
    if (options.secret.length < 16) {
      throw new TypeError(
        "createSessionManager requires a secret of at least 16 characters in production",
      );
    }
    const asString = typeof options.secret === "string" ? options.secret : "";
    if (asString === "dev-secret-change-me") {
      throw new TypeError(
        "createSessionManager refuses the known dev default 'dev-secret-change-me' in production",
      );
    }
  }
  const secret = options.secret;
  const store = options.store;
  const cookieName = options.cookieName ?? "sid";
  const ttlSeconds = options.ttlSeconds ?? 3600;
  const rolling = options.rolling ?? true;
  const cookieOptions = options.cookieOptions ?? { httpOnly: true, sameSite: "lax", path: "/" };

  // Effective cookie options for a request: apply the `secure` default —
  // production always sets Secure; dev auto-detects from the request URL so
  // HTTPS-local hosts get Secure cookies without configuration. An explicit
  // `cookieOptions.secure` always wins.
  const effectiveCookieOptions = (ctx: IgnexContext): Partial<Record<string, unknown>> => {
    if (cookieOptions.secure != null) return cookieOptions;
    const secure = process.env.NODE_ENV === "production" || ctx.req.url.startsWith("https:");
    return secure ? { ...cookieOptions, secure: true } : cookieOptions;
  };

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
        // Write-through so a bare touch() (handler calls it without a later
        // save()) still extends the session on the next request: a store gets
        // its row updated AND the cookie rewritten (the next request reads
        // expiry from the cookie). The rolling middleware's follow-up persist
        // makes this redundant there, but it is harmless (same data, single
        // Set-Cookie key).
        const p = persist(ctx, session);
        if (p instanceof Promise) {
          void p.catch((err) => console.error("[ignex] session touch persist failed:", err));
        }
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
        writeCookie(ctx.cookie, cookieName, encodeEnvelope(envelope), effectiveCookieOptions(ctx));
      });
    }
    envelope.data = session.data;
    writeCookie(ctx.cookie, cookieName, encodeEnvelope(envelope), effectiveCookieOptions(ctx));
  };

  const destroy = async (ctx: IgnexContext, session: Session | null): Promise<void> => {
    if (store && session) await store.delete(session.id);
    ctx.cookie[cookieName]?.remove();
  };

  // Sync-capable session resolution: without a store the cookie decode +
  // materialize is pure sync (no Promise). With a store, `store.get` is async.
  const resolveSession = (ctx: IgnexContext): Session | null | Promise<Session | null> => {
    const raw = ctx.cookie[cookieName]?.value;
    const envelope = decodeEnvelope(raw);
    if (envelope.ok === false) {
      // A tampered/expired/malformed session cookie is treated as missing AND
      // cleared from the client — otherwise a bad cookie lingers forever or
      // mints a fresh session on every request (session churn). "missing" is
      // the no-cookie case and has nothing to clear.
      if (envelope.error !== "missing") {
        ctx.cookie[cookieName]?.remove();
      }
      return null;
    }
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
