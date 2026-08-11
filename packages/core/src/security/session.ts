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
import { randomToken, signCookie, verifyCookie } from "@flux/native";
import { err, isOk, ok, type Result } from "@flux/shared";
import type { FluxContext } from "../http/context";
import { writeCookie } from "../http/cookies";
import { continueHook, type HookFn } from "../lifecycle/hooks";
import type { MaybePromise } from "../types";

export type SessionData = Record<string, unknown>;

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

export interface SessionManager {
  /** Load the session for the current request (or `null`). */
  load(ctx: FluxContext): Promise<Session | null>;
  /** Load the session, creating one when missing. */
  loadOrCreate(ctx: FluxContext): Promise<Session>;
  /** Build the request hook that attaches the session to the context. */
  middleware(options?: { createIfMissing?: boolean }): HookFn;
}

const SESSION_KEY = Symbol.for("flux.session");

/** Read the session attached by `withSession` middleware. */
export const getSession = (ctx: FluxContext): Session | undefined =>
  ctx.getState<Session>(SESSION_KEY);

interface Envelope {
  id: string;
  data?: SessionData;
  exp: number;
}

/** Why a session cookie could not be decoded. */
type DecodeError = "missing" | "invalid-signature" | "invalid-json" | "invalid-id" | "expired";

export const createSessionManager = (options: SessionManagerOptions): SessionManager => {
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
    ctx: FluxContext,
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

  const save = async (ctx: FluxContext, session: Session): Promise<void> => {
    const envelope: Envelope = {
      id: session.id,
      exp: Math.floor(session.expiresAt / 1000),
    };
    if (store) {
      await store.set(session.id, session.data, { expiresAt: session.expiresAt });
    } else {
      envelope.data = session.data;
    }
    writeCookie(ctx.cookie, cookieName, encodeEnvelope(envelope), cookieOptions);
  };

  const destroy = async (ctx: FluxContext, session: Session | null): Promise<void> => {
    if (store && session) await store.delete(session.id);
    ctx.cookie[cookieName]?.remove();
  };

  const load = async (ctx: FluxContext): Promise<Session | null> => {
    const envelope = decodeEnvelope(ctx.cookie[cookieName]?.value);
    if (!isOk(envelope)) return null;
    const { id, data: envelopeData, exp } = envelope.value;

    let data = envelopeData ?? {};
    if (store) {
      const stored = await store.get(id);
      if (!stored) return null;
      data = stored;
    }

    return makeSession(ctx, id, data, exp * 1000, exp * 1000, false);
  };

  const loadOrCreate = async (ctx: FluxContext): Promise<Session> => {
    const existing = await load(ctx);
    if (existing) return existing;
    const session = makeSession(ctx, createId(), {}, now(), expiresAtFor(), true);
    await save(ctx, session);
    return session;
  };

  const middleware = (opts: { createIfMissing?: boolean } = {}): HookFn => {
    const createIfMissing = opts.createIfMissing ?? false;
    return async (ctx) => {
      const session = createIfMissing ? await loadOrCreate(ctx) : await load(ctx);
      if (session) {
        if (rolling && !session.isNew) {
          session.touch();
          await save(ctx, session);
        }
        ctx.setState(SESSION_KEY, session);
      }
      return continueHook(ctx);
    };
  };

  return { load, loadOrCreate, middleware };
};

/** Alias for `createSessionManager(...).middleware(...)` — ergonomic hook. */
export const withSession = (
  options: SessionManagerOptions,
  middlewareOptions?: { createIfMissing?: boolean },
): HookFn => createSessionManager(options).middleware(middlewareOptions);

export type SessionLoader = MaybePromise<Session | null>;
