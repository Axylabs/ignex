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
import { randomToken, sessionOpen, sessionSeal, signCookie, verifyCookie } from "@ignex/native";
import { err, ok, type Result } from "@ignex/shared";
import type { IgnexContext } from "../http/context";
import { readRequestCookie, writeCookie } from "../http/cookies";
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
  /**
   * The current session id. Mutated in place by {@link Session.rotate} —
   * handlers holding the object observe the new id after rotation.
   */
  id: string;
  readonly createdAt: number;
  /** Epoch milliseconds at which the session expires. */
  expiresAt: number;
  data: SessionData;
  readonly isNew: boolean;
  /** Persist the session (writes cookie + store). */
  save(): Promise<void>;
  /**
   * Rotate the session id while preserving data and expiry — THE fixation
   * defense: call it after every privilege change (login, role grant,
   * password change). Deletes the old store row (when store-backed) and
   * rewrites the cookie under the new id; the old cookie value is dead
   * immediately.
   */
  rotate(): Promise<void>;
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
  /**
   * Use the fused native seal/open (ONE ffi crossing replacing
   * stringify+HMAC). Default `false` — at small-envelope granularity the
   * fused path measured 0.80x (seal) / 0.58x (open) versus JSC's optimized
   * JSON.stringify + Bun HMAC (see CHANGELOG A/B verdict), so the JS two-step
   * stays the measured-fastest default; opt in when profiling YOUR envelope
   * sizes shows the crossing wins (larger data blobs, non-JSC hosts).
   */
  nativeFusion?: boolean;
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

  // Legacy location first (a marker written by older middleware versions or
  // app code), then the WeakMap slot the middleware now uses.
  const legacy = ctx.getState<() => Promise<Session>>(SESSION_CREATE);
  if (legacy) {
    const session = await legacy();
    ctx.setState(SESSION_KEY, session);
    ctx.state.delete(SESSION_CREATE);
    return session;
  }

  const create = lazyCreateMarkers.get(ctx);
  if (create) {
    const session = await create();
    ctx.setState(SESSION_KEY, session);
    lazyCreateMarkers.delete(ctx);
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

/**
 * Per-request lazy-creation factories, keyed by the request context.
 *
 * Storing the marker here (instead of `ctx.setState`) keeps `createIfMissing:
 * "lazy"` truly allocation-free for requests that never touch their session:
 * a WeakMap set does not force the context's lazy `state` Map to materialize.
 * Contexts are per-request objects, so entries are collected with the request.
 */
const lazyCreateMarkers = new WeakMap<object, () => Session | Promise<Session>>();

/** Why a session cookie could not be decoded. */
type DecodeError = "missing" | "invalid-signature" | "invalid-json" | "invalid-id" | "expired";

/**
 * Escape hatch for local experimentation: set `IGNEX_ALLOW_WEAK_SECRET=1` to
 * bypass the strength checks entirely (a one-time loud warning is printed).
 * Never set this in shared/staging/production environments.
 */
const WEAK_SECRET_BYPASS_ENV = "IGNEX_ALLOW_WEAK_SECRET";

/** Known developer-default secrets that must never reach a real deployment. */
const KNOWN_DEV_DEFAULTS = new Set([
  "dev-secret-change-me",
  "secret",
  "changeme",
  "session-secret",
]);

/**
 * Strict secret checking whenever we cannot PROVE this is a local dev/test
 * process: `production` obviously, but ALSO an unset/empty `NODE_ENV` — the
 * common staging shape (`bun dist/__server.js` with no environment wiring)
 * that the old production-only guard silently let through.
 */
const isStrictSecretMode = (): boolean => {
  const nodeEnv = process.env.NODE_ENV;
  return nodeEnv == null || nodeEnv === "" || nodeEnv === "production" || nodeEnv === "prod";
};

/**
 * Create a reusable session manager.
 *
 * Without a `store`, sessions are fully stateless signed cookies. With a
 * store, the data lives in the store and the cookie carries only the id + exp.
 *
 * @param options - Secret plus optional store/cookie/ttl tuning.
 * @throws TypeError when `options.secret` is empty, or shorter than 16
 *   characters / a known dev default outside explicit local development
 *   (`NODE_ENV=development|test`) — unless `IGNEX_ALLOW_WEAK_SECRET=1`.
 */
export const createSessionManager = (options: SessionManagerOptions): SessionManager => {
  if (options.secret.length === 0) {
    throw new TypeError("createSessionManager requires a non-empty secret");
  }
  // Strength hardening: a weak or well-known dev default secret must never
  // ship. Strict everywhere except explicit local dev/test so a staging or
  // preview deploy without NODE_ENV wiring cannot boot with forgeable session
  // cookies. Local iteration stays frictionless; the escape hatch exists for
  // deliberate experiments and warns loudly when used.
  if (isStrictSecretMode()) {
    const asString = typeof options.secret === "string" ? options.secret : "";
    if (options.secret.length < 16 || KNOWN_DEV_DEFAULTS.has(asString)) {
      if (process.env[WEAK_SECRET_BYPASS_ENV] === "1") {
        console.warn(
          "[ignex] IGNEX_ALLOW_WEAK_SECRET=1 — running with a weak session secret; " +
            "NEVER enable this outside local development.",
        );
      } else {
        const reason =
          options.secret.length < 16
            ? "of at least 16 characters"
            : "that is not a known dev default";
        throw new TypeError(
          `createSessionManager requires a secret ${reason} outside local development ` +
            `(NODE_ENV=${process.env.NODE_ENV ?? "<unset>"}). Generate one, e.g.: ` +
            "`openssl rand -hex 32`, or use devSessionSecret() for local apps.",
        );
      }
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

  // Fused native seal/open is OPT-IN (see SessionManagerOptions.nativeFusion):
  // measured slower than the JS two-step for typical small envelopes, so the
  // default stays the JS path.
  const fusionEnabled = options.nativeFusion ?? false;

  const createId = (): string => randomToken(16);

  // Module-level helpers keep the closure below within complexity budget.
  const parseData = (raw: string | null): Result<SessionData, DecodeError> => {
    if (!raw || raw === "null") return ok({});
    try {
      const parsed = JSON.parse(raw) as unknown;
      return ok(parsed != null && typeof parsed === "object" ? (parsed as SessionData) : {});
    } catch {
      return err("invalid-json");
    }
  };

  /** Fused fast path: ONE native crossing verifies HMAC + extracts fields. */
  const decodeFused = (raw: string): Result<Envelope, DecodeError> | null => {
    const opened = sessionOpen(raw, secret);
    if (!opened) return null; // ffi/addon unavailable → caller uses the fallback
    const exp = typeof opened.exp === "number" ? Math.floor(opened.exp) : 0;
    if (opened.id.length === 0) return err("invalid-id");
    if (exp * 1000 <= now()) return err("expired");
    const data = parseData(opened.dataJson);
    return data.ok === false ? data : ok({ id: opened.id, data: data.value, exp });
  };

  /** Two-step fallback: verifyCookie + JSON.parse (byte-compatible contract). */
  const decodeFallback = (raw: string): Result<Envelope, DecodeError> => {
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

  const decodeEnvelope = (raw: string | undefined): Result<Envelope, DecodeError> => {
    if (!raw) return err("missing");
    // Opt-in fused path first; both sealers' cookies decode on BOTH paths
    // (byte-compatible), so enabling/disabling fusion never strands cookies.
    if (fusionEnabled) return decodeFused(raw) ?? decodeFallback(raw);
    return decodeFallback(raw);
  };

  const encodeEnvelope = (envelope: Envelope): string => {
    if (fusionEnabled) {
      // ONE crossing: build + HMAC. `data` is omitted for store-backed
      // sessions; the fused sealer embeds `null` there ("no data" on decode).
      const sealed = sessionSeal(
        envelope.id,
        envelope.data === undefined ? "null" : JSON.stringify(envelope.data),
        envelope.exp,
        secret,
      );
      if (sealed !== null) return sealed;
    }
    return signCookie(JSON.stringify(envelope), secret);
  };

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
      rotate: () => rotate(ctx, session),
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
    // Mirror the write attributes on deletion — the deletion cookie only
    // matches the browser's stored cookie when path/domain agree.
    ctx.cookie[cookieName]?.remove(effectiveCookieOptions(ctx) as Partial<Record<string, unknown>>);
  };

  // Session-id rotation (fixation defense): mint a fresh id, persist under it
  // FIRST (cookie + store row), then best-effort delete the old row so the
  // window where both ids resolve is as short as possible. Data and expiry are
  // preserved; the old cookie value is dead the moment the new one is written.
  const rotate = async (ctx: IgnexContext, session: Session): Promise<void> => {
    const oldId = session.id;
    session.id = createId();
    await persist(ctx, session);
    if (store && oldId !== session.id) {
      try {
        await store.delete(oldId);
      } catch (err) {
        console.error("[ignex] session rotate: old store row delete failed:", err);
      }
    }
  };

  // Sync-capable session resolution: without a store the cookie decode +
  // materialize is pure sync (no Promise). With a store, `store.get` is async.
  //
  // The session id is read straight from the raw Cookie header
  // (`readRequestCookie`) instead of going through `ctx.cookie[cookieName]`:
  // an indexed read on the lazy jar would materialize the jar proxy AND parse
  // the whole header on EVERY request — including requests that carry no
  // cookies at all (health checks, static assets). Reads that need the full
  // jar (handler reads other cookies / writes) still materialize lazily as
  // before; only this one-name lookup skips it.
  const resolveSession = (ctx: IgnexContext): Session | null | Promise<Session | null> => {
    const raw = readRequestCookie(ctx.req.headers.get("cookie"), cookieName);
    const envelope = decodeEnvelope(raw);
    if (envelope.ok === false) {
      // A tampered/expired/malformed session cookie is treated as missing AND
      // cleared from the client — otherwise a bad cookie lingers forever or
      // mints a fresh session on every request (session churn). "missing" is
      // the no-cookie case and has nothing to clear.
      if (envelope.error !== "missing") {
        ctx.cookie[cookieName]?.remove(
          effectiveCookieOptions(ctx) as Partial<Record<string, unknown>>,
        );
      }
      return null;
    }
    const { id, data: envelopeData, exp } = envelope.value;

    if (store) {
      return store.get(id).then((stored) => {
        if (!stored) {
          // The envelope decoded but the store row is gone (restart, expiry
          // sweep, evicted entry). Clear the cookie like the tamper case —
          // otherwise every subsequent request re-decodes + store-lookups a
          // dead id forever.
          ctx.cookie[cookieName]?.remove(
            effectiveCookieOptions(ctx) as Partial<Record<string, unknown>>,
          );
          return null;
        }
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
        // generation, no cookie signing, no Set-Cookie on the response). The
        // marker lives in a WeakMap so this hook allocates nothing else —
        // notably it does NOT force ctx.state's lazy Map into existence.
        lazyCreateMarkers.set(ctx, () => loadOrCreate(ctx));
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
