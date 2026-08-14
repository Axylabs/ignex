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
 * Parse many `Cookie` headers, one record per input. Honors the same
 * {@link MAX_COOKIES} / {@link MAX_COOKIE_HEADER_BYTES} guards as
 * {@link parseCookieString} and produces identical output.
 *
 * NOTE: always uses the per-item scalar parser — the native packed-batch path
 * (`batch.cookieParse`) measured SLOWER than the JS scalar at every batch size
 * (`bench/results/batch-selection.json`, batch/js ≈ 0.16-0.23) and was removed
 * 2026-08-14.
 *
 * @param inputs Raw `Cookie` header values (`null`/oversized → `{}`).
 * @returns One `Record<string, string>` per input.
 */
export const parseCookies = (inputs: ReadonlyArray<string | null>): Array<Record<string, string>> =>
  inputs.map(parseCookieString);

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
    Object.assign(entry, config);
    return this;
  }

  remove(): this {
    this.update({ expires: new Date(0), maxAge: 0, value: "" });
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

  return new Proxy(store, {
    get(_, key: string) {
      return new Cookie(key, cookieStore, { ...initial, ...store[key] });
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

  return new Proxy(target, {
    get(_, key: string) {
      const store = ensureParsed();

      return new Cookie(key, cookieStore, {
        ...initial,
        value: store[key],
      });
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
