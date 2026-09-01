/**
 * @fileoverview HTTP cookies — parsing, serialization and the mutable `Cookie`
 * facade backed by the `set.cookie` accumulator.
 *
 * Serialization is centralized here so every writer (sessions, CSRF, `ctx.cookie`)
 * emits identical `set-cookie` values.
 */

import { cookiePairs } from "@ignex/native";
import type { CookieOptions, ElysiaCookie } from "../types";
import type { SetHeaders } from "./headers";

const toCookieValue = (value: unknown): string =>
  typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");

const encodeCookieValue = (value: string): string => encodeURIComponent(value);

const decodeCookieValue = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeSameSite = (sameSite: CookieOptions["sameSite"]): string | undefined => {
  if (sameSite === true) return "Strict";
  if (sameSite === false || sameSite === undefined) return undefined;

  return sameSite.charAt(0).toUpperCase() + sameSite.slice(1);
};

const serializeCookiePair = (name: string, value: string, opts: ElysiaCookie): string => {
  const parts = [`${name}=${encodeCookieValue(value)}`];

  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.path) parts.push(`Path=${opts.path}`);

  if (opts.expires instanceof Date) {
    parts.push(`Expires=${opts.expires.toUTCString()}`);
  }

  if (opts.maxAge != null) {
    parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  }

  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");

  const sameSite = normalizeSameSite(opts.sameSite);
  if (sameSite) parts.push(`SameSite=${sameSite}`);

  if (opts.priority) parts.push(`Priority=${opts.priority}`);
  if (opts.partitioned) parts.push("Partitioned");

  return parts.join("; ");
};

/**
 * Serialize a cookie record into `Set-Cookie` header value(s).
 *
 * @returns A single header string, an array (multiple cookies), or `undefined`
 * when no cookie has a value.
 */
export const serializeCookie = (
  cookies: Record<string, ElysiaCookie>,
): string | string[] | undefined => {
  const serialized = Object.entries(cookies)
    .filter(([, opts]) => opts?.value != null)
    .map(([name, opts]) => serializeCookiePair(name, toCookieValue(opts.value), opts));

  if (serialized.length === 0) return undefined;

  return serialized.length === 1 ? serialized[0] : serialized;
};

/** Maximum number of cookies parsed from a single header (DoS guard). */
const MAX_COOKIES = 100;
/** Maximum length of the Cookie header we'll parse (DoS guard). */
const MAX_COOKIE_HEADER_BYTES = 8192;

/**
 * Fold raw cookie pairs into a `Record` (last value wins per key), honoring
 * the {@link MAX_COOKIES} DoS guard.
 */
export const cookiePairsToRecord = (
  pairs: ReadonlyArray<[string, string]>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  let count = 0;

  // Native parser trims + unwraps DQUOTE but does not URL-decode, so we keep
  // the existing decode step here.
  for (const [key, value] of pairs) {
    if (count >= MAX_COOKIES) break;
    out[key] = decodeCookieValue(value);
    count += 1;
  }

  return out;
};

/**
 * Parse a `Cookie` request header into a name → value record.
 *
 * Enforces DoS guards: at most 100 cookies and an 8 KB header; oversized or
 * absent input yields an empty record (never throws).
 *
 * @param cookieString - The raw `Cookie` header value (or `null`).
 * @returns Decoded cookie values keyed by name.
 */
export const parseCookieString = (cookieString: string | null): Record<string, string> => {
  if (!cookieString) return {};
  // Refuse to parse an absurdly large cookie header.
  if (cookieString.length > MAX_COOKIE_HEADER_BYTES) return {};

  return cookiePairsToRecord(cookiePairs(cookieString));
};

/**
 * Read a SINGLE named cookie from the raw `Cookie` request header — without
 * materializing a full name → value record.
 *
 * Semantics are byte-identical to `parseCookieString(header)[name]`: same
 * pair splitting, whitespace trim, DQUOTE unwrap and percent-decode, last
 * value wins on duplicates, and the same DoS guards (8 KB header / 100 pairs).
 * The point is allocation-free session reads: middleware that only needs one
 * known cookie (e.g. the session id) no longer forces a full header parse nor
 * the lazy cookie-jar proxy on requests that carry few or no cookies.
 *
 * @param cookieString - The raw `Cookie` header value (or `null`).
 * @param name - Cookie name to look up (case-sensitive per RFC 6265 §5.4).
 */
export const readRequestCookie = (
  cookieString: string | null,
  name: string,
): string | undefined => {
  if (!cookieString || cookieString.length > MAX_COOKIE_HEADER_BYTES) return undefined;

  let found: string | undefined;
  let count = 0;

  // Count parity with `cookiePairs`: every part with a non-empty trimmed name
  // is a pair (a bare `foo` token parses to value ""), guard included.
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    const partName = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (!partName) continue;
    if (count >= MAX_COOKIES) break;
    count += 1;
    if (partName !== name) continue;
    const raw = part.slice(eq + 1).trim();
    const unquoted =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    found = decodeCookieValue(unquoted);
  }

  return found;
};

/**
 * A mutable view of one cookie inside a cookie jar.
 *
 * Reads fall back to the jar entry or the initial options; writes accumulate
 * into the context's `set.cookie` so the response carries the right
 * `Set-Cookie` header.
 */
export class Cookie<T = string | undefined> {
  constructor(
    private name: string,
    private jar: Record<string, ElysiaCookie>,
    private initial: Partial<ElysiaCookie> = {},
  ) {}

  get value(): T {
    return (this.jar[this.name]?.value ?? this.initial.value) as T;
  }

  set value(v: T) {
    if (this.jar[this.name] === undefined) {
      this.jar[this.name] = { ...this.initial };
    }
    const entry = this.jar[this.name];
    if (entry === undefined) throw new Error(`cookie jar entry missing for "${this.name}"`);
    entry.value = v;
  }

  get expires() {
    return this.jar[this.name]?.expires ?? this.initial.expires;
  }

  set expires(v: Date | undefined) {
    this._set("expires", v);
  }

  get maxAge() {
    return this.jar[this.name]?.maxAge ?? this.initial.maxAge;
  }

  set maxAge(v: number | undefined) {
    this._set("maxAge", v);
  }

  get domain() {
    return this.jar[this.name]?.domain ?? this.initial.domain;
  }

  set domain(v: string | undefined) {
    this._set("domain", v);
  }

  get path() {
    return this.jar[this.name]?.path ?? this.initial.path;
  }

  set path(v: string | undefined) {
    this._set("path", v);
  }

  get secure() {
    return this.jar[this.name]?.secure ?? this.initial.secure;
  }

  set secure(v: boolean | undefined) {
    this._set("secure", v);
  }

  get httpOnly() {
    return this.jar[this.name]?.httpOnly ?? this.initial.httpOnly;
  }

  set httpOnly(v: boolean | undefined) {
    this._set("httpOnly", v);
  }

  get sameSite() {
    return this.jar[this.name]?.sameSite ?? this.initial.sameSite;
  }

  set sameSite(v: true | false | "lax" | "strict" | "none" | undefined) {
    this._set("sameSite", v);
  }

  update(config: Partial<ElysiaCookie>): this {
    if (this.jar[this.name] === undefined) {
      this.jar[this.name] = { ...this.initial };
    }
    const entry = this.jar[this.name];
    if (entry === undefined) throw new Error(`cookie jar entry missing for "${this.name}"`);
    Object.assign(entry, config);
    return this;
  }

  /**
   * Mark the cookie for deletion (expired + empty).
   *
   * Browsers match deletion cookies on the full attribute set — most
   * importantly `path` (which is NOT echoed back in the request's Cookie
   * header, so it cannot be inferred). A cookie written with
   * `Path=/` survives a path-less deletion. Pass `attrs` to mirror the
   * original write attributes (`{ path: "/" }` at minimum for app-wide
   * cookies; include `domain` when one was set).
   */
  remove(attrs?: Partial<ElysiaCookie>): this {
    this.update({ ...attrs, expires: new Date(0), maxAge: 0, value: "" });
    return this;
  }

  toString(): string {
    const v = this.value;
    return typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
  }

  private _set(key: string, value: unknown) {
    if (this.jar[this.name] === undefined) {
      this.jar[this.name] = { ...this.initial };
    }
    const entry = this.jar[this.name];
    (entry as Record<string, unknown>)[key] = value;
  }
}

/**
 * Create a cookie jar backed by a context's `set.cookie` accumulator.
 *
 * Reading any key returns a {@link Cookie} view; mutating it writes through
 * to the accumulator. `initial` provides defaults for cookies not yet set.
 */
export const createCookieJar = (
  set: SetHeaders,
  store: Record<string, ElysiaCookie>,
  initial?: Partial<ElysiaCookie>,
): Record<string, Cookie> => {
  if (!set.cookie) set.cookie = Object.create(null) as Record<string, ElysiaCookie>;
  const cookieStore: Record<string, ElysiaCookie> = set.cookie;

  // One Cookie VIEW per key (cached): the instance re-reads the store on
  // every property access, so caching it is observably identical to
  // allocating a fresh view per read — minus the object + spread allocation
  // on the per-request path (session resolution reads ctx.cookie[name]).
  const views: Record<string, Cookie> = Object.create(null);

  return new Proxy(store, {
    get(_, key: string) {
      const k = typeof key === "string" ? key : String(key);
      let view = views[k];
      if (view === undefined) {
        view = new Cookie(k, cookieStore, { ...initial });
        views[k] = view;
      }
      return view;
    },
  }) as Record<string, Cookie>;
};

/**
 * Write (or overwrite) a cookie through a context's cookie jar with a fresh
 * value. Single write path shared by sessions, CSRF and any other signed/
 * token cookie writer so cookie semantics stay in one place.
 */
export const writeCookie = (
  jar: Record<string, Cookie>,
  name: string,
  value: string,
  options: Partial<Record<string, unknown>> = {},
): void => {
  jar[name]?.update({ ...options, value });
};

/**
 * Create a lazily-parsed cookie jar.
 *
 * The incoming `Cookie` header is parsed on first read (cached) rather than
 * at jar creation, so request paths that never touch cookies do zero parsing.
 */
export const createLazyCookieJar = (
  set: SetHeaders,
  getCookieHeader: () => string | null,
  initial?: Partial<ElysiaCookie>,
  preParsed?: Record<string, string>,
): Record<string, Cookie> => {
  if (!set.cookie) set.cookie = Object.create(null) as Record<string, ElysiaCookie>;
  const cookieStore: Record<string, ElysiaCookie> = set.cookie;

  // Seed with an already-parsed header (e.g. the compiled validation prelude
  // computed `__cookies`) so a handler reading cookies does not re-parse the
  // Cookie header.
  let parsed: Record<string, string> | undefined = preParsed;

  const ensureParsed = () => {
    if (!parsed) {
      parsed = parseCookieString(getCookieHeader());
    }

    return parsed;
  };

  const target = Object.create(null);
  // Cached views (see createCookieJar) — one per key, created after the
  // header parse so the constructor's `value` seed is correct.
  const views: Record<string, Cookie> = Object.create(null);

  return new Proxy(target, {
    get(_, key: string) {
      if (typeof key !== "string") return undefined;
      const cached = views[key];
      if (cached !== undefined) return cached;
      const store = ensureParsed();
      const view = new Cookie(key, cookieStore, {
        ...initial,
        value: store[key],
      });
      views[key] = view;
      return view;
    },
    // Lazy parsing is transparent to enumeration: `Object.keys(ctx.cookie)`
    // / `for…in` trigger a parse and list the received cookie names (matches
    // the eager `Record<string, Cookie>` type the API promises).
    ownKeys() {
      return Reflect.ownKeys(ensureParsed());
    },
    getOwnPropertyDescriptor(_, key: string | symbol) {
      const store = ensureParsed();
      if (typeof key === "string" && key in store) {
        return { value: store[key], enumerable: true, configurable: true };
      }
      return undefined;
    },
  }) as Record<string, Cookie>;
};
