/**
 * Internationalization — message catalogs, locale negotiation and a request
 * hook that attaches `ctx.t` and `ctx.state.locale`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LRUCache } from "../data/lru";
import type { IgnexContext } from "../http/context";
import { continueHook, type HookFn } from "../lifecycle/hooks";

/** A single locale's message catalog: message key → translated string. */
export type Catalog = Record<string, string>;
/** All loaded locales: locale tag → {@link Catalog}. */
export type Catalogs = Record<string, Catalog>;

/** Options for {@link createI18n}. */
export interface I18nOptions {
  /** Locale used when no match is found (default `en`). */
  fallbackLocale?: string;
  /** Locale used when no `Accept-Language` header is present. */
  defaultLocale?: string;
}

/**
 * The i18n service returned by {@link createI18n}.
 *
 * All formatters accept an explicit `locale` and otherwise use the negotiated
 * per-request locale (via `middleware`).
 */
export interface I18n {
  /**
   * Translate a key with `{name}` interpolation. When `params.count` is a
   * number, the CLDR plural form is resolved first (`key.one` / `key.few` /
   * `key.other` …), falling back to `key`.
   */
  t(key: string, params?: Record<string, unknown>, locale?: string): string;
  /** Resolve the active locale for a context. */
  locale(ctx: IgnexContext): string;
  /** Resolve a plural message key for `count` (`key.one` / `key.few` / `key.other` …). */
  pluralize(key: string, count: number, locale?: string): string;
  /** Format a number (Intl.NumberFormat). */
  n(value: number, opts?: Intl.NumberFormatOptions, locale?: string): string;
  /** Format a date/time (Intl.DateTimeFormat). */
  d(value: Date | number | string, opts?: Intl.DateTimeFormatOptions, locale?: string): string;
  /** Format a currency amount (Intl.NumberFormat style=currency). */
  currency(value: number, currency: string, locale?: string): string;
  /** Request hook: negotiate locale and attach `ctx.t` + locale state. */
  middleware(options?: { stateKey?: string }): HookFn;
}

/** Locale state key on `ctx.state`. */
export const LOCALE_KEY = Symbol.for("ignex.locale");

/** CLDR plural categories (see `pluralCategory`). */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

// Bounded per-locale `Intl.PluralRules` cache: `Intl.PluralRules` construction
// is comparatively expensive, but an unbounded Map would grow forever with
// every unique (potentially attacker-controlled) locale string. 64 entries
// covers every realistic deployment while capping memory growth.
const pluralRulesCache = new LRUCache<string, Intl.PluralRules>({ max: 64 });

/**
 * CLDR cardinal plural category for a count in a locale (via `Intl.PluralRules`).
 *
 * @throws RangeError when `locale` is not a valid BCP 47 language tag.
 */
export const pluralCategory = (locale: string, count: number): PluralCategory => {
  const key = locale.toLowerCase();
  let rules = pluralRulesCache.get(key);
  if (!rules) {
    // `Intl.PluralRules` throws RangeError for malformed tags — let it surface
    // (a bad locale is a programming error, not an input the app must absorb).
    rules = new Intl.PluralRules(key);
    pluralRulesCache.set(key, rules);
  }
  return rules.select(count) as PluralCategory;
};

const toDate = (value: Date | number | string): Date => new Date(value);

/** Format a number with Intl.NumberFormat. */
export const formatNumber = (
  value: number,
  locale?: string,
  opts?: Intl.NumberFormatOptions,
): string => new Intl.NumberFormat(locale, opts).format(value);

/** Format a currency amount with Intl.NumberFormat (style=currency). */
export const formatCurrency = (value: number, currency: string, locale?: string): string =>
  new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);

/** Format a date/time with Intl.DateTimeFormat. */
export const formatDate = (
  value: Date | number | string,
  locale?: string,
  opts?: Intl.DateTimeFormatOptions,
): string => new Intl.DateTimeFormat(locale, opts).format(toDate(value));

interface NegotiateOptions {
  defaultLocale?: string;
}

interface Preference {
  tag: string;
  q: number;
}

/** Parse an `Accept-Language` header into weighted preferences. */
const parsePreferences = (acceptLanguage: string): Preference[] =>
  acceptLanguage.split(",").map((part) => {
    const tag = part.trim().split(";")[0] ?? "";
    let q = 1;
    for (const param of part.trim().split(";").slice(1)) {
      const eq = param.indexOf("=");
      if (eq >= 0 && param.slice(0, eq).trim() === "q") {
        const parsed = Number(param.slice(eq + 1).trim());
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    return { tag: tag.trim().toLowerCase(), q };
  });

const byQuality = (a: Preference, b: Preference): number => b.q - a.q;

/**
 * Precompiled lookup for a supported locale list: lowercased full tag →
 * original-cased locale (first occurrence wins). Prevents per-request
 * allocation of a lowercased copy + O(supported) array scans in the hot path.
 */
interface CompiledLocales {
  readonly supported: readonly string[];
  readonly byTag: ReadonlyMap<string, string>;
}

const compileLocales = (supported: readonly string[]): CompiledLocales => {
  const byTag = new Map<string, string>();
  for (const locale of supported) {
    const lower = locale.toLowerCase();
    if (!byTag.has(lower)) byTag.set(lower, locale);
  }
  return { supported, byTag };
};

/**
 * First supported locale matching a preference: exact tag, then the bare base
 * language AS a supported tag (e.g. a `fr-FR` request matches a supported
 * `fr`). Behavior-identical to the original indexOf-based matcher, including
 * the empty-tag quirk (`Array.indexOf("")` → 0 ⇒ an empty tag matches the
 * first supported locale).
 */
const matchCompiled = (pref: Preference, compiled: CompiledLocales): string | undefined => {
  if (pref.q <= 0) return undefined;
  if (pref.tag === "") return compiled.supported[0];
  const exact = compiled.byTag.get(pref.tag);
  if (exact !== undefined) return exact;
  const base = pref.tag.split("-")[0] ?? "";
  return compiled.byTag.get(base);
};

/** Negotiate against a precompiled table: parse → sort by q → first match. */
const negotiateLocaleCompiled = (
  acceptLanguage: string | null,
  compiled: CompiledLocales,
  fallback: string,
): string => {
  if (!acceptLanguage || compiled.supported.length === 0) return fallback;

  const prefs = parsePreferences(acceptLanguage).sort(byQuality);
  for (const pref of prefs) {
    const match = matchCompiled(pref, compiled);
    if (match !== undefined) return match;
  }
  return fallback;
};

/**
 * Pick the best supported locale from an `Accept-Language` header:
 * parse → sort by `q` → first supported match (exact tag, then base-as-tag).
 * Hot-path callers (e.g. `createI18n` middleware) should precompile via
 * {@link compileLocales} and use `negotiateLocaleCompiled` to avoid
 * per-request allocation.
 */
export const negotiateLocale = (
  acceptLanguage: string | null,
  supported: readonly string[],
  options: NegotiateOptions = {},
): string => {
  const fallback = options.defaultLocale ?? supported[0] ?? "en";
  if (!acceptLanguage || supported.length === 0) return fallback;

  return negotiateLocaleCompiled(acceptLanguage, compileLocales(supported), fallback);
};

/** Interpolate `{name}` placeholders from a params object. */
export const interpolate = (
  template: string,
  params: Record<string, unknown> | undefined,
): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params?.[key];
    return value === undefined || value === null ? match : String(value);
  });

/**
 * Create an i18n instance over a set of catalogs.
 *
 * `t` interpolates `{name}` placeholders and supports CLDR plural keys
 * (`key.one`/`key.other`/…) driven by `Intl.PluralRules`. `middleware()`
 * negotiates the request locale from `Accept-Language` and exposes a
 * locale-bound `t` on the context.
 *
 * @param catalogs - All locales and their messages.
 * @param options - Fallback/default locale selection.
 * @returns The i18n instance (see {@link I18n}).
 */
export const createI18n = (catalogs: Catalogs, options: I18nOptions = {}): I18n => {
  const fallbackLocale = options.fallbackLocale ?? "en";
  const defaultLocale = options.defaultLocale ?? fallbackLocale;

  // Precompile the supported-locale lookup once so per-request negotiation
  // (middleware) avoids allocating + scanning the catalog keys every time.
  const compiled = compileLocales(Object.keys(catalogs));

  const lookup = (key: string, locale?: string): string =>
    (locale && catalogs[locale]?.[key]) ?? catalogs[fallbackLocale]?.[key] ?? key;

  const i18n: I18n = {
    t(key, params, locale) {
      const count = typeof params?.count === "number" ? params.count : undefined;
      if (count !== undefined) {
        const category = pluralCategory(locale ?? defaultLocale, count);
        const plural = lookup(`${key}.${category}`, locale);
        if (plural !== `${key}.${category}`) return interpolate(plural, params);
        const other = lookup(`${key}.other`, locale);
        if (other !== `${key}.other`) return interpolate(other, params);
      }
      return interpolate(lookup(key, locale), params);
    },

    pluralize(key, count, locale) {
      const category = pluralCategory(locale ?? defaultLocale, count);
      const plural = lookup(`${key}.${category}`, locale);
      if (plural !== `${key}.${category}`) return interpolate(plural, { count });
      const other = lookup(`${key}.other`, locale);
      return other !== `${key}.other` ? interpolate(other, { count }) : plural;
    },

    n(value, opts, locale) {
      return formatNumber(value, locale ?? defaultLocale, opts);
    },
    d(value, opts, locale) {
      return formatDate(value, locale ?? defaultLocale, opts);
    },
    currency(value, code, locale) {
      return formatCurrency(value, code, locale ?? defaultLocale);
    },

    locale(ctx) {
      return ctx.getState<string>(LOCALE_KEY) ?? defaultLocale;
    },

    middleware(middlewareOptions = {}) {
      const stateKey = middlewareOptions.stateKey ?? "locale";
      const translate = i18n.t;

      // Sync hook: negotiate the locale and attach `ctx.t`/locale state with
      // no per-request Promise (runHooks only awaits actual Promises).
      return (ctx) => {
        const locale = negotiateLocaleCompiled(
          ctx.headers.get("accept-language"),
          compiled,
          defaultLocale,
        );
        ctx.setState(LOCALE_KEY, locale);
        ctx.setState(stateKey, locale);

        (ctx as IgnexContext & { t: I18n["t"] }).t = (key, params) =>
          translate(key, params, locale);

        return continueHook(ctx);
      };
    },
  };

  return i18n;
};

/** Options for {@link loadCatalogDir}. */
export interface LoadCatalogDirOptions {
  /** Separator used to join a namespaced subpath into a key prefix (default `"."`). */
  namespaceSeparator?: string;
  /** Called when a catalog file cannot be read or parsed (default: silently skip). */
  onError?: (locale: string, error: unknown) => void;
}

/**
 * Load JSON message catalogs from a directory (best-effort).
 *
 * Supported layouts:
 * - `locales/en.json` → locale `en`
 * - `locales/en/errors.json` → locale `en`, keys prefixed `errors.`
 * - `locales/en/nested/ui.json` → locale `en`, keys prefixed `nested.ui.`
 *
 * Files that cannot be read or parsed are skipped (or reported via
 * `onError`), so a missing locale never throws.
 */
export const loadCatalogDir = (dir: string, options: LoadCatalogDirOptions = {}): Catalogs => {
  const separator = options.namespaceSeparator ?? ".";
  const catalogs: Catalogs = {};

  const mergeFile = (abs: string, locale: string, namespace: string | undefined): void => {
    let entries: unknown;
    try {
      entries = JSON.parse(readFileSync(abs, "utf-8"));
    } catch (error) {
      options.onError?.(locale, error);
      return;
    }

    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;

    catalogs[locale] ??= {};
    const target = catalogs[locale];
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      target[namespace ? `${namespace}${separator}${key}` : key] = value;
    }
  };

  const scan = (absDir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(absDir).sort();
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = join(absDir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;

      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }

      if (isDir) {
        scan(abs, rel);
      } else if (entry.endsWith(".json")) {
        const segments = rel.replace(/\.json$/, "").split("/");
        const locale = segments[0];
        if (!locale) continue;
        const namespace = segments.slice(1).join(separator);
        mergeFile(abs, locale, namespace || undefined);
      }
    }
  };

  scan(dir, "");
  return catalogs;
};

/** `createI18n` from a directory of JSON catalogs (see {@link loadCatalogDir}). */
export const createI18nFromDir = (
  dir: string,
  options: I18nOptions & LoadCatalogDirOptions = {},
): I18n => {
  const { onError, namespaceSeparator, ...i18nOptions } = options;
  return createI18n(
    loadCatalogDir(dir, {
      ...(onError !== undefined ? { onError } : {}),
      ...(namespaceSeparator !== undefined ? { namespaceSeparator } : {}),
    }),
    i18nOptions,
  );
};

/**
 * Request middleware alias that attaches `ctx.t` + locale state for an I18n
 * instance — equivalent to `createI18n(...).middleware()`.
 */
export const withI18n = (i18n: I18n, options?: { stateKey?: string }): HookFn =>
  i18n.middleware(options);
