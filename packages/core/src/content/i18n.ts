/**
 * Internationalization — message catalogs, locale negotiation and a request
 * hook that attaches `ctx.t` and `ctx.state.locale`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipe } from "@ignus/shared";
import type { IgnusContext } from "../http/context";
import { continueHook, type HookFn } from "../lifecycle/hooks";

export type Catalog = Record<string, string>;
export type Catalogs = Record<string, Catalog>;

export interface I18nOptions {
  /** Locale used when no match is found (default `en`). */
  fallbackLocale?: string;
  /** Locale used when no `Accept-Language` header is present. */
  defaultLocale?: string;
}

export interface I18n {
  /** Translate a key with `{name}` interpolation. */
  t(key: string, params?: Record<string, unknown>, locale?: string): string;
  /** Resolve the active locale for a context. */
  locale(ctx: IgnusContext): string;
  /** Request hook: negotiate locale and attach `ctx.t` + locale state. */
  middleware(options?: { stateKey?: string }): HookFn;
}

/** Locale state key on `ctx.state`. */
export const LOCALE_KEY = Symbol.for("ignus.locale");

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
    const [tag, ...params] = part.trim().split(";");
    let q = 1;
    for (const param of params) {
      const eq = param.indexOf("=");
      if (eq >= 0 && param.slice(0, eq).trim() === "q") {
        const parsed = Number(param.slice(eq + 1).trim());
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    return { tag: tag.trim().toLowerCase(), q };
  });

/** First supported locale matching a preference (exact tag, then base language). */
const matchPreference = (
  pref: Preference,
  supported: readonly string[],
  lower: readonly string[],
): string | undefined => {
  if (pref.q <= 0) return undefined;
  const exact = lower.indexOf(pref.tag);
  if (exact >= 0) return supported[exact];
  const base = pref.tag.split("-")[0];
  const baseIndex = lower.indexOf(base);
  if (baseIndex >= 0) return supported[baseIndex];
  return undefined;
};

/**
 * Pick the best supported locale from an `Accept-Language` header.
 * Composed as a pipeline: parse → sort by `q` → first supported match.
 */
export const negotiateLocale = (
  acceptLanguage: string | null,
  supported: readonly string[],
  options: NegotiateOptions = {},
): string => {
  if (!acceptLanguage || supported.length === 0) {
    return options.defaultLocale ?? supported[0] ?? "en";
  }

  const fallback = options.defaultLocale ?? supported[0] ?? "en";
  const lower = supported.map((locale) => locale.toLowerCase());
  const byQuality = (a: Preference, b: Preference): number => b.q - a.q;

  return pipe(acceptLanguage)(
    parsePreferences,
    (prefs) => prefs.sort(byQuality),
    (prefs) => {
      for (const pref of prefs) {
        const match = matchPreference(pref, supported, lower);
        if (match) return match;
      }
      return fallback;
    },
  );
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

export const createI18n = (catalogs: Catalogs, options: I18nOptions = {}): I18n => {
  const fallbackLocale = options.fallbackLocale ?? "en";
  const defaultLocale = options.defaultLocale ?? fallbackLocale;

  const lookup = (key: string, locale?: string): string =>
    (locale && catalogs[locale]?.[key]) ?? catalogs[fallbackLocale]?.[key] ?? key;

  const i18n: I18n = {
    t(key, params, locale) {
      return interpolate(lookup(key, locale), params);
    },

    locale(ctx) {
      return ctx.getState<string>(LOCALE_KEY) ?? defaultLocale;
    },

    middleware(middlewareOptions = {}) {
      const stateKey = middlewareOptions.stateKey ?? "locale";
      const translate = i18n.t;

      return async (ctx) => {
        const locale = negotiateLocale(ctx.headers.get("accept-language"), Object.keys(catalogs), {
          defaultLocale,
        });

        ctx.setState(LOCALE_KEY, locale);
        ctx.setState(stateKey, locale);

        (ctx as IgnusContext & { t: I18n["t"] }).t = (key, params) =>
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
